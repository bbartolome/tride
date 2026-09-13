import { Injectable } from '@nestjs/common';
import { GitRunner } from './git-runner.service';

const FIELD_SEP = '\x1f'; // ASCII Unit Separator
const RECORD_END = '\x1e'; // ASCII Record Separator

/**
 * Fixed `--format` shared by `show` and `log`. `%B` (raw, unwrapped subject
 * + body) is deliberately last, since it is the one field whose content is
 * fully author-controlled free text — every fixed field comes before it so
 * nothing after `%B` needs to be located by counting from the front.
 */
const COMMIT_FORMAT = `%H${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%aI${FIELD_SEP}%B${RECORD_END}`;

export interface GitCommitInfo {
  sha: string;
  author: string;
  email: string;
  /** Strict ISO 8601 (`%aI`). */
  date: string;
  message: string;
}

export type GitLogEntry = GitCommitInfo;

export interface GitShowResult {
  header: GitCommitInfo;
  diffText: string;
}

export interface GitLogOptions {
  limit: number;
  skip: number;
  /** Repo-relative pathspec to restrict history to, or undefined for the whole tree. */
  path?: string;
}

/**
 * Strips exactly one trailing `RECORD_END` (our own format terminator) if
 * present. Only ever removes the LAST character, so a commit message that
 * happens to end with a genuine, author-typed `RECORD_END` byte keeps that
 * byte — only the one we appended is peeled off.
 */
function stripTrailingRecordEnd(value: string): string {
  return value.endsWith(RECORD_END) ? value.slice(0, -1) : value;
}

/**
 * Parses one already-isolated `COMMIT_FORMAT` record (i.e. already split at
 * its true record boundary — a NUL byte, never `RECORD_END` itself, see the
 * class doc) into its five fields.
 *
 * `message` is reconstructed by rejoining every field past the fourth
 * `FIELD_SEP` with `FIELD_SEP` itself. This is what keeps a commit message
 * containing a literal `FIELD_SEP` (`\x1f`) byte intact — split-then-rejoin
 * exactly undoes the split — rather than silently truncating the message at
 * the first occurrence.
 *
 * The one trailing `\n` `%B` always carries (git normalizes every stored
 * commit message to end with exactly one) is stripped for a clean
 * `message` string; any further internal newlines (a multi-line body) are
 * left untouched.
 */
function parseCommitFields(record: string): GitCommitInfo {
  const parts = stripTrailingRecordEnd(record).split(FIELD_SEP);
  const [sha = '', author = '', email = '', date = ''] = parts;
  const message = parts.slice(4).join(FIELD_SEP).replace(/\n$/, '');
  return { sha, author, email, date, message };
}

/**
 * Thin: runs `git show`/`git log` against an already resolved, realpath'd
 * repo root (callers go through `GitRepoService.resolveRepoRoot` first, per
 * F62 — this service never resolves `repo` itself).
 */
@Injectable()
export class GitLogService {
  constructor(private readonly gitRunner: GitRunner) {}

  /**
   * `rev` gets `assertNotOptionLike` ONLY, never `checkRefFormat` —
   * `checkRefFormat` validates ref *names* being created/switched (F59) and
   * would wrongly reject a bare SHA or any other commit-ish expression that
   * isn't a well-formed branch name.
   *
   * **Format-choice correction to the plan.** The plan's literal command
   * (`git show --format=... -U3 <rev> [-- <path>]`, no `-z`) is parsed by
   * finding the first `RECORD_END` and treating everything before it as the
   * header. Verified against real git 2.43 that this breaks the instant a
   * commit message contains a literal `RECORD_END` (`\x1e`) byte: the split
   * lands on the embedded byte instead of our own terminator, truncating
   * the header and corrupting `diffText`. Adding `-z` fixes this properly
   * rather than papering over it: with `-z`, git inserts exactly one real
   * NUL byte immediately after the format's own terminator and before the
   * diff, and a NUL can never appear in either a commit message or diff
   * text (that byte is literally how git itself decides a file is binary
   * for diffing purposes) — so splitting on the first NUL is a genuinely
   * safe boundary no author-controlled content can forge.
   */
  async show(
    repoAbsPath: string,
    rev: string,
    path?: string,
  ): Promise<GitShowResult> {
    this.gitRunner.assertNotOptionLike(rev, 'rev');

    const { stdout } = await this.gitRunner.runWithPathspecs(
      repoAbsPath,
      ['show', `--format=${COMMIT_FORMAT}`, '-U3', '-z', rev],
      path ? [path] : [],
    );

    const nulIndex = stdout.indexOf('\0');
    const headerRaw = nulIndex === -1 ? stdout : stdout.slice(0, nulIndex);
    // Git emits a lone "\n" right after the NUL before the diff text itself
    // (with plain, non-`-z` formatting it would be "\n\n" instead) — strip
    // it so `diffText` starts directly with "diff --git ...".
    const diffText =
      nulIndex === -1 ? '' : stdout.slice(nulIndex + 1).replace(/^\n+/, '');

    return { header: parseCommitFields(headerRaw), diffText };
  }

  async log(repoAbsPath: string, opts: GitLogOptions): Promise<GitLogEntry[]> {
    const { stdout } = await this.gitRunner.runWithPathspecs(
      repoAbsPath,
      [
        'log',
        `--format=${COMMIT_FORMAT}`,
        '-z',
        '-n',
        String(opts.limit),
        `--skip=${opts.skip}`,
      ],
      opts.path ? [opts.path] : [],
    );

    // Under `-z`, records are NUL-separated (never `RECORD_END`-separated —
    // see the `show` doc above for why only NUL is a safe boundary), so
    // splitting here needs no stateful cursor at all: unlike a status/
    // numstat entry, one commit record never spills into a neighboring NUL
    // field.
    return stdout
      .split('\0')
      .filter((record) => record.length > 0)
      .map(parseCommitFields);
  }
}
