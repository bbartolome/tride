import { BadGatewayException, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '../common/error-codes';
import { GitRunner } from './git-runner.service';

export interface FetchOptions {
  remote?: string;
  prune?: boolean;
}

export interface PullOptions {
  remote?: string;
  branch?: string;
}

export interface PushOptions {
  remote?: string;
  branch?: string;
  setUpstream?: boolean;
  force?: boolean;
}

export interface RemoteInfo {
  name: string;
  fetchUrl: string | null;
  pushUrl: string | null;
}

const DEFAULT_REMOTE = 'origin';

// Broadened beyond plan.md's SSH-only list (F47's phase correction already
// widened GIT_AUTH_REQUIRED itself) since `~/.gitconfig`'s
// `credential.helper` and `gh` are explicitly in scope — an HTTPS remote can
// fail auth just as readily as an SSH one. `Authentication failed` is
// matched case-insensitively; the rest are matched as git prints them
// verbatim (confirmed shapes, not guesses).
const AUTH_FAILURE_PATTERNS: readonly RegExp[] = [
  /Permission denied \(publickey\)/,
  /Host key verification failed/,
  /could not read Username/,
  /Authentication failed/i,
  /fatal: Authentication failed for/,
  /remote: Invalid username or password/,
];

/**
 * Pure function, unit-tested directly (a real SSH/HTTPS auth failure cannot
 * be provoked deterministically in CI, so this is the only reliable way to
 * pin the mapping). Matches combined stdout+stderr text from a failed
 * fetch/pull/push against the known auth-failure message shapes.
 */
export function matchesAuthFailure(text: string): boolean {
  return AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

function combinedOutput(err: unknown): string {
  const shape = err as { stdout?: unknown; stderr?: unknown } | null;
  return [shape?.stdout, shape?.stderr]
    .filter((s): s is string => typeof s === 'string')
    .join('\n');
}

// `git remote -v` prints one line per (name, url, direction) pair, e.g.
// `origin\tgit@host:org/repo.git (fetch)`. Tab-separated, and remote names
// can never contain whitespace, so no -z/NUL handling is needed here (same
// reasoning as git-branch.service.ts's for-each-ref parsing).
const REMOTE_LINE_RE = /^(\S+)\t(\S+)\s+\((fetch|push)\)$/;

/**
 * Thin: every method here runs against an already resolved, realpath'd repo
 * root (callers go through `GitRepoService.resolveRepoRoot` first, per F62 —
 * this service never resolves `repo` itself). All git calls go through
 * `GitRunner.run` — the single chokepoint (F61) — never a second spawn path.
 *
 * `sshAuthSock` is threaded through from the controller, which resolves it
 * fresh via `resolveSshAuthSock()` on every call (never cached) — this
 * service knows nothing about *where* that value comes from, mirroring
 * `GitRunOptions.sshAuthSock`'s own doc comment.
 */
@Injectable()
export class GitRemoteService {
  constructor(private readonly gitRunner: GitRunner) {}

  async fetch(
    repoAbsPath: string,
    opts: FetchOptions,
    sshAuthSock?: string,
  ): Promise<void> {
    const args = [
      'fetch',
      opts.remote ?? DEFAULT_REMOTE,
      ...(opts.prune ? ['--prune'] : []),
    ];
    await this.runNetwork(repoAbsPath, args, sshAuthSock);
  }

  /**
   * Always `--ff-only` (F48/product decision): merge/rebase/conflict work
   * routes to the terminal, so a pull through this app must never create a
   * merge commit or strand a conflict mid-operation. Never pass `--rebase`
   * either — same rationale.
   */
  async pull(
    repoAbsPath: string,
    opts: PullOptions,
    sshAuthSock?: string,
  ): Promise<void> {
    const args = [
      'pull',
      // --ff-only, always. A plain pull can silently create a merge commit
      // or strand the tree mid-conflict with MERGE_HEAD written, which
      // contradicts the decision that merge and conflict work belongs in
      // the terminal, not in a phone UI. Mutation-tested: without this flag
      // the divergence test finds MERGE_HEAD present.
      '--ff-only',
      opts.remote ?? DEFAULT_REMOTE,
      ...(opts.branch ? [opts.branch] : []),
    ];
    await this.runNetwork(repoAbsPath, args, sshAuthSock);
  }

  /**
   * Non-force pushes take `remote`/`branch`/`setUpstream` as given. A forced
   * push is, byte for byte, `['push', '--force-with-lease',
   * '--force-if-includes']` and nothing else — no plain `--force` code path
   * exists anywhere in this codebase, and none should be added. The
   * controller is responsible for verifying `confirm === 'force push'`
   * BEFORE this is ever called with `force: true`.
   */
  async push(
    repoAbsPath: string,
    opts: PushOptions,
    sshAuthSock?: string,
  ): Promise<void> {
    const args = opts.force
      ? ['push', '--force-with-lease', '--force-if-includes']
      : [
          'push',
          ...(opts.setUpstream ? ['--set-upstream'] : []),
          opts.remote ?? DEFAULT_REMOTE,
          ...(opts.branch ? [opts.branch] : []),
        ];
    await this.runNetwork(repoAbsPath, args, sshAuthSock);
  }

  async listRemotes(repoAbsPath: string): Promise<RemoteInfo[]> {
    const { stdout } = await this.gitRunner.run(repoAbsPath, ['remote', '-v']);

    const byName = new Map<string, RemoteInfo>();
    for (const line of stdout.split('\n')) {
      if (line.length === 0) {
        continue;
      }
      const match = REMOTE_LINE_RE.exec(line);
      if (!match) {
        continue;
      }
      const [, name, url, direction] = match;
      let entry = byName.get(name);
      if (!entry) {
        entry = { name, fetchUrl: null, pushUrl: null };
        byName.set(name, entry);
      }
      if (direction === 'fetch') {
        entry.fetchUrl = url;
      } else {
        entry.pushUrl = url;
      }
    }
    return [...byName.values()];
  }

  /**
   * Runs a network git command (fetch/pull/push), intercepting an
   * auth-failure error BEFORE it ever reaches the controller's generic
   * `toHttpException` fallback (F52) — matched against both stdout and
   * stderr (F87/F95).
   */
  private async runNetwork(
    repoAbsPath: string,
    args: string[],
    sshAuthSock: string | undefined,
  ): Promise<void> {
    try {
      await this.gitRunner.run(repoAbsPath, args, {
        network: true,
        sshAuthSock,
      });
    } catch (err) {
      if (matchesAuthFailure(combinedOutput(err))) {
        throw new BadGatewayException({
          code: ERROR_CODES.GIT_AUTH_REQUIRED,
          message: 'Git remote authentication failed',
          detail: {
            hint: 'Open a terminal in this repo to authenticate (SSH agent / credential helper / gh), then retry.',
          },
        });
      }
      throw err;
    }
  }
}
