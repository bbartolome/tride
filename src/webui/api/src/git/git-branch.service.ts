import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ERROR_CODES } from '../common/error-codes';
import { GitRunner } from './git-runner.service';

export interface BranchInfo {
  name: string;
  sha: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  upstreamGone: boolean;
}

export interface RemoteBranchInfo {
  name: string;
  sha: string;
}

export interface BranchListResult {
  current: string | null;
  detached: boolean;
  /** Short SHA HEAD is detached onto — present only when `detached` is true. */
  detachedAt?: string;
  local: BranchInfo[];
  remote: RemoteBranchInfo[];
}

export interface CheckoutOptions {
  branch: string;
  create?: boolean;
  startPoint?: string;
}

export interface CreateBranchOptions {
  name: string;
  startPoint?: string;
}

export interface DeleteBranchOptions {
  name: string;
  force?: boolean;
}

// Tab-separated is safe here (unlike file paths under -z elsewhere in this
// module) — refnames can never contain a tab, so no -z/NUL handling is
// needed for this parse.
const FOR_EACH_REF_FORMAT =
  '%(refname:short)\t%(upstream:short)\t%(upstream:track)\t%(objectname)';

// Confirmed against real git 2.43. Both messages are checked against BOTH
// stdout and stderr (F87 — `git commit`'s "nothing to commit" lands on
// stdout, not stderr, and the same caution applies here rather than
// assuming these particular messages are stderr-only just because they look
// like errors).
const BRANCH_EXISTS_RE = /already exists/i;
const BRANCH_NOT_FOUND_RE = /not found/i;

function combinedOutput(err: unknown): string {
  const shape = err as { stdout?: unknown; stderr?: unknown } | null;
  return [shape?.stdout, shape?.stderr]
    .filter((s): s is string => typeof s === 'string')
    .join('\n');
}

/**
 * Parses `%(upstream:track)`'s bracket forms: `[ahead N]`, `[behind M]`,
 * `[ahead N, behind M]`, `[gone]`, or an empty string when the branch is
 * caught up with (or has no) upstream. Matched with regexes rather than a
 * strict bracket grammar since the four shapes above are the entire set git
 * ever emits here.
 */
function parseUpstreamTrack(raw: string): {
  ahead: number;
  behind: number;
  upstreamGone: boolean;
} {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ahead: 0, behind: 0, upstreamGone: false };
  }
  if (trimmed === '[gone]') {
    return { ahead: 0, behind: 0, upstreamGone: true };
  }
  const aheadMatch = /ahead (\d+)/.exec(trimmed);
  const behindMatch = /behind (\d+)/.exec(trimmed);
  return {
    ahead: aheadMatch ? Number.parseInt(aheadMatch[1], 10) : 0,
    behind: behindMatch ? Number.parseInt(behindMatch[1], 10) : 0,
    upstreamGone: false,
  };
}

interface RawRef {
  name: string;
  upstream: string;
  track: string;
  sha: string;
}

/**
 * Thin: runs `git for-each-ref`/`git checkout`/`git branch` against an
 * already resolved, realpath'd repo root (callers go through
 * `GitRepoService.resolveRepoRoot` first, per F62 — this service never
 * resolves `repo` itself).
 *
 * **The validation split (F59, F81):** a branch NAME being created or
 * switched to (`branch`, `name`) is validated with `gitRunner.checkRefFormat`
 * — 400 `INVALID_REF` on failure, before the actual mutating git call. A
 * `startPoint`, by contrast, gets `assertNotOptionLike` ONLY: it may be an
 * arbitrary commit-ish, including a bare SHA, which `checkRefFormat` would
 * wrongly reject as an invalid branch name. Do not "make this consistent" by
 * applying `checkRefFormat` to `startPoint` too — see
 * `git-branch.service.spec.ts`'s bare-SHA `startPoint` test, which is
 * specifically engineered to fail if that guard is ever added there.
 */
@Injectable()
export class GitBranchService {
  constructor(private readonly gitRunner: GitRunner) {}

  async listBranches(repoAbsPath: string): Promise<BranchListResult> {
    // Current/detached detection is its own call, independent of the
    // for-each-ref listing below.
    const { stdout: headOut } = await this.gitRunner.run(repoAbsPath, [
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ]);
    const headRef = headOut.trim();
    const detached = headRef === 'HEAD';

    const result: BranchListResult = {
      current: detached ? null : headRef,
      detached,
      local: [],
      remote: [],
    };

    if (detached) {
      const { stdout: shortOut } = await this.gitRunner.run(repoAbsPath, [
        'rev-parse',
        '--short',
        'HEAD',
      ]);
      result.detachedAt = shortOut.trim();
    }

    // Two separate for-each-ref calls, one per ref root, rather than a
    // single call given both patterns at once: `%(refname:short)` alone
    // gives no reliable way to tell which section a line came from (a local
    // branch name and a remote-tracking short name share the same shape),
    // so splitting by ref root up front is what makes local/remote
    // classification unambiguous rather than dependent on for-each-ref's
    // default sort order.
    const localRefs = await this.listRefs(repoAbsPath, 'refs/heads');
    const remoteRefs = await this.listRefs(repoAbsPath, 'refs/remotes');

    result.local = localRefs.map((ref) => {
      const { ahead, behind, upstreamGone } = parseUpstreamTrack(ref.track);
      return {
        name: ref.name,
        sha: ref.sha,
        upstream: ref.upstream.length > 0 ? ref.upstream : null,
        ahead,
        behind,
        upstreamGone,
      };
    });

    result.remote = remoteRefs
      // `refs/remotes/<remote>/HEAD` is a symbolic pointer, not a branch.
      // Confirmed against real git 2.43: `%(refname:short)` collapses it to
      // the bare remote name (e.g. "origin"), NOT "origin/HEAD" — a real
      // remote-tracking branch's short name always has a "/" in it (the
      // remote name and the branch name), so "no slash" is what
      // unambiguously identifies this symref within the refs/remotes list.
      .filter((ref) => ref.name.includes('/'))
      .map((ref) => ({ name: ref.name, sha: ref.sha }));

    return result;
  }

  private async listRefs(
    repoAbsPath: string,
    pattern: string,
  ): Promise<RawRef[]> {
    const { stdout } = await this.gitRunner.run(repoAbsPath, [
      'for-each-ref',
      `--format=${FOR_EACH_REF_FORMAT}`,
      pattern,
    ]);
    return stdout
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const [name = '', upstream = '', track = '', sha = ''] =
          line.split('\t');
        return { name, upstream, track, sha };
      });
  }

  async checkout(repoAbsPath: string, opts: CheckoutOptions): Promise<void> {
    await this.validateRefName(opts.branch);
    if (opts.startPoint !== undefined) {
      // See the class doc: startPoint may be a bare SHA, so it gets ONLY
      // this guard, never checkRefFormat.
      this.gitRunner.assertNotOptionLike(opts.startPoint, 'startPoint');
    }

    const args = opts.create
      ? [
          'checkout',
          '-b',
          opts.branch,
          ...(opts.startPoint ? [opts.startPoint] : []),
        ]
      : ['checkout', opts.branch];
    await this.gitRunner.run(repoAbsPath, args);
  }

  /** Creates a branch without switching to it. */
  async createBranch(
    repoAbsPath: string,
    opts: CreateBranchOptions,
  ): Promise<void> {
    await this.validateRefName(opts.name);
    if (opts.startPoint !== undefined) {
      this.gitRunner.assertNotOptionLike(opts.startPoint, 'startPoint');
    }

    try {
      await this.gitRunner.run(repoAbsPath, [
        'branch',
        opts.name,
        ...(opts.startPoint ? [opts.startPoint] : []),
      ]);
    } catch (err) {
      if (BRANCH_EXISTS_RE.test(combinedOutput(err))) {
        throw new ConflictException({
          code: ERROR_CODES.BRANCH_EXISTS,
          message: `Branch already exists: ${opts.name}`,
        });
      }
      throw err;
    }
  }

  async deleteBranch(
    repoAbsPath: string,
    opts: DeleteBranchOptions,
  ): Promise<void> {
    await this.validateRefName(opts.name);

    try {
      await this.gitRunner.run(repoAbsPath, [
        'branch',
        opts.force ? '-D' : '-d',
        opts.name,
      ]);
    } catch (err) {
      if (BRANCH_NOT_FOUND_RE.test(combinedOutput(err))) {
        throw new NotFoundException({
          code: ERROR_CODES.BRANCH_NOT_FOUND,
          message: `Branch not found: ${opts.name}`,
        });
      }
      // Notably NOT special-cased here: git's "not fully merged" refusal
      // (no `force`) falls straight through as a plain GitCommandError, for
      // the controller's `toHttpException` to map to 422
      // GIT_COMMAND_FAILED — that refusal is not a 404, and callers need
      // its stderr text to know why the delete was rejected.
      throw err;
    }
  }

  /**
   * Validates a branch name being created or switched to. Runs BEFORE the
   * actual checkout/branch/delete call in every method above — this is what
   * "before any other git call" means in this file's tests: a spy on
   * `GitRunner.run` sees this method's own `check-ref-format` invocation,
   * but never sees the real mutating command for an invalid name.
   */
  private async validateRefName(name: string): Promise<void> {
    const ok = await this.gitRunner.checkRefFormat(name);
    if (!ok) {
      throw new BadRequestException({
        code: ERROR_CODES.INVALID_REF,
        message: `Invalid ref name: ${JSON.stringify(name)}`,
      });
    }
  }
}
