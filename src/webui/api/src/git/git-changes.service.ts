import { ConflictException, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '../common/error-codes';
import { GitRunner } from './git-runner.service';

export interface StageOptions {
  paths?: string[];
  all?: boolean;
}

export interface CommitOptions {
  message: string;
  amend?: boolean;
  signoff?: boolean;
}

export interface CommitResult {
  sha: string;
}

// Real git prints this substring (lower-case) both when a plain `git commit`
// finds nothing staged and, distinctly, when `git commit --amend` on a
// tip commit is asked to reproduce identical content — checked BEFORE
// falling back to `toHttpException` (F52), never after. Confirmed against
// real git 2.43: this line goes to STDOUT, not stderr (git still exits 1),
// so both streams must be checked.
const NOTHING_TO_COMMIT_RE = /nothing to commit/i;

/**
 * Thin: every method here runs against an already resolved, realpath'd repo
 * root (callers go through `GitRepoService.resolveRepoRoot` first, per F62 —
 * this service never resolves `repo` itself). All mutation goes through
 * `GitRunner.run`/`runWithPathspecs` — the single chokepoint (F61) — so
 * pathspec validation (`assertNotOptionLike`) and the per-repo mutex are
 * inherited for free.
 */
@Injectable()
export class GitChangesService {
  constructor(private readonly gitRunner: GitRunner) {}

  async stage(repoAbsPath: string, opts: StageOptions): Promise<void> {
    if (opts.all) {
      await this.gitRunner.run(repoAbsPath, ['add', '-A']);
      return;
    }
    await this.gitRunner.runWithPathspecs(
      repoAbsPath,
      ['add'],
      opts.paths ?? [],
    );
  }

  async unstage(repoAbsPath: string, opts: StageOptions): Promise<void> {
    if (opts.all) {
      // `git restore --staged --` with NO pathspec is a usage error ("you
      // must specify path(s) to restore", exit 128) — restore, unlike
      // `add`, has no bare "everything" form, so the whole-tree case needs
      // the literal `.` pathspec instead of an empty pathspec list.
      await this.gitRunner.run(repoAbsPath, ['restore', '--staged', '.']);
      return;
    }
    await this.gitRunner.runWithPathspecs(
      repoAbsPath,
      ['restore', '--staged'],
      opts.paths ?? [],
    );
  }

  /**
   * DESTRUCTIVE. The caller (the controller) is responsible for verifying
   * the typed `confirm: "discard"` literal BEFORE this is ever called —
   * this method assumes that check already happened and never re-checks it,
   * so it must never be reachable except through that gate.
   *
   * Runs, in order, against exactly `paths` (never the whole tree):
   *   1. `restore --staged --worktree -- <paths>` — reverts tracked changes
   *      to HEAD, both staged and unstaged.
   *   2. `clean -fd -- <paths>` — removes untracked files/directories among
   *      exactly those paths. `-d` is required to remove untracked
   *      directories; the trailing pathspec is what stops it from touching
   *      untracked content anywhere else in the tree.
   */
  async discard(repoAbsPath: string, paths: string[]): Promise<void> {
    // `git restore` validates EVERY pathspec up front and aborts the whole
    // invocation if any one of them is untracked. Passing a mixed selection
    // therefore restores nothing at all, while step 2 still deletes the
    // untracked members — so "discard these two files" would discard one and
    // report success. That mixed case (some modified files, some new) is the
    // ordinary one, not an edge case, so partition first and hand restore
    // only the paths git actually knows about.
    const tracked = await this.listTrackedPaths(repoAbsPath, paths);

    if (tracked.length > 0) {
      await this.gitRunner.runWithPathspecs(
        repoAbsPath,
        ['restore', '--staged', '--worktree'],
        tracked,
      );
    }

    // Untracked content is removed by pathspec, which is what keeps this from
    // touching anything the caller did not name. `-d` covers directories.
    await this.gitRunner.runWithPathspecs(repoAbsPath, ['clean', '-fd'], paths);
  }

  /**
   * The subset of `paths` that git tracks (index entries included, so a
   * staged-but-uncommitted file counts). `ls-files -z` because paths may
   * contain anything a filename can.
   */
  private async listTrackedPaths(
    repoAbsPath: string,
    paths: string[],
  ): Promise<string[]> {
    const result = await this.gitRunner.runWithPathspecs(
      repoAbsPath,
      ['ls-files', '-z'],
      paths,
    );
    return result.stdout.split('\0').filter((entry) => entry.length > 0);
  }

  async commit(
    repoAbsPath: string,
    opts: CommitOptions,
  ): Promise<CommitResult> {
    const args = [
      'commit',
      // `message` occupies `-m`'s option-value slot here, not a positional
      // argv position — git's argument parser cannot reinterpret it as a
      // flag regardless of what character it starts with, so it deliberately
      // does NOT get `assertNotOptionLike` (only positional tokens, like
      // pathspecs and refs, need that guard). Do not "harden" this later —
      // doing so would break legitimate messages starting with "-".
      '-m',
      opts.message,
      ...(opts.amend ? ['--amend'] : []),
      ...(opts.signoff ? ['--signoff'] : []),
    ];

    try {
      await this.gitRunner.run(repoAbsPath, args);
    } catch (err) {
      this.rethrowNothingToCommit(err);
      throw err;
    }

    const { stdout } = await this.gitRunner.run(repoAbsPath, [
      'rev-parse',
      'HEAD',
    ]);
    return { sha: stdout.trim() };
  }

  private rethrowNothingToCommit(err: unknown): void {
    const shape = err as { stdout?: unknown; stderr?: unknown } | null;
    const combined = [shape?.stdout, shape?.stderr]
      .filter((s): s is string => typeof s === 'string')
      .join('\n');
    if (NOTHING_TO_COMMIT_RE.test(combined)) {
      throw new ConflictException({
        code: ERROR_CODES.NOTHING_TO_COMMIT,
        message: 'Nothing to commit',
      });
    }
  }
}
