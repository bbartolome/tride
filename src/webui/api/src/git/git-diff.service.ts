import { Injectable } from '@nestjs/common';
import { GitRunner } from './git-runner.service';

/**
 * `git diff` on a binary file never dumps content — it prints a single
 * "Binary files a/x and b/x differ" line (or ".../dev/null differ" for an
 * added/deleted binary file) instead of a unified diff. Detecting that line
 * is simpler and more robust than trying to sniff the raw bytes ourselves.
 */
const BINARY_DIFF_RE = /^Binary files .* differ$/m;

export type DiffResponse = { text: string } | { binary: true };

export interface DiffOptions {
  /** Repo-relative pathspec to restrict the diff to, or undefined for the whole tree. */
  path?: string;
  staged: boolean;
  /** Unified diff context line count (`-U<context>`). */
  context: number;
}

export interface DiffSummaryEntry {
  path: string;
  /** Present only for renames/copies. */
  origPath?: string;
  /** `null` for a binary file — `git diff --numstat` reports `-` there. */
  added: number | null;
  deleted: number | null;
  binary: boolean;
}

/**
 * Matches one `git diff --numstat -z` record: `<added>\t<deleted>\t<rest>`,
 * where `<rest>` is normally the path but is EMPTY for a rename/copy record
 * (see `parseNumstatZ`). `[\s\S]*` rather than `.*` because a path can
 * legitimately contain a literal newline.
 */
const NUMSTAT_RECORD_RE = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/;

/**
 * Parses `git diff --numstat -z` output.
 *
 * **The same NUL double-field trap as `git-status-parser.ts` (F70)**: a
 * rename/copy record is NOT `added\tdeleted\tpath\0` like an ordinary
 * record. Confirmed against real git 2.43: it is
 * `added\tdeleted\t\0<origPath>\0<newPath>\0` — the path field between the
 * two tabs is EMPTY, and the two real names ride as two SEPARATE
 * NUL-terminated fields immediately after. That is TWO extra fields, not
 * the ONE extra field a status `2` record carries. A parser that
 * copy-pastes the status parser's "consume one extra element" cursor
 * (an easy mistake, since the shapes look so similar) desyncs by leaving
 * the second name (the new path) to be read as if it were its own
 * top-level record on the next loop iteration.
 *
 * We detect a rename/copy record by its EMPTY trailing path field — an
 * ordinary record's path can never be empty, so this is unambiguous and,
 * unlike the status parser's marker-character dispatch, needs no
 * lookahead/backtracking to recognize.
 */
export function parseNumstatZ(raw: string): DiffSummaryEntry[] {
  const records = raw.split('\0').filter((record) => record.length > 0);
  const entries: DiffSummaryEntry[] = [];

  for (let i = 0; i < records.length; i++) {
    const match = NUMSTAT_RECORD_RE.exec(records[i]);
    if (!match) {
      // Malformed/unexpected record — skip rather than throw, same
      // defensive stance as parseGitStatusEntries's default case.
      continue;
    }

    const [, addedField, deletedField, rest] = match;
    const added = addedField === '-' ? null : Number.parseInt(addedField, 10);
    const deleted =
      deletedField === '-' ? null : Number.parseInt(deletedField, 10);
    const binary = addedField === '-' && deletedField === '-';

    if (rest.length === 0) {
      // Rename/copy: consume the NEXT TWO array elements (origPath, then
      // the new path) — this is the desync-prevention step, and the reason
      // it must be *two* rather than the status parser's *one*.
      const origPath = records[++i] ?? '';
      const path = records[++i] ?? '';
      entries.push({ path, origPath, added, deleted, binary });
      continue;
    }

    entries.push({ path: rest, added, deleted, binary });
  }

  return entries;
}

/**
 * Thin: runs `git diff`/`git diff --numstat` against an already resolved,
 * realpath'd repo root (callers go through `GitRepoService.resolveRepoRoot`
 * first, per F62 — this service never resolves `repo` itself).
 */
@Injectable()
export class GitDiffService {
  constructor(private readonly gitRunner: GitRunner) {}

  async diff(repoAbsPath: string, opts: DiffOptions): Promise<DiffResponse> {
    const { stdout } = await this.gitRunner.runWithPathspecs(
      repoAbsPath,
      ['diff', ...(opts.staged ? ['--staged'] : []), `-U${opts.context}`],
      opts.path ? [opts.path] : [],
    );

    if (BINARY_DIFF_RE.test(stdout)) {
      return { binary: true };
    }
    return { text: stdout };
  }

  async diffSummary(
    repoAbsPath: string,
    opts: { staged: boolean },
  ): Promise<DiffSummaryEntry[]> {
    // No path filter, per the endpoint contract — this is a whole-tree
    // summary, so a plain `run` rather than `runWithPathspecs`.
    const { stdout } = await this.gitRunner.run(repoAbsPath, [
      'diff',
      '--numstat',
      '-z',
      ...(opts.staged ? ['--staged'] : []),
    ]);
    return parseNumstatZ(stdout);
  }
}
