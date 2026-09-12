import {
  BadRequestException,
  GatewayTimeoutException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  UnprocessableEntityException,
} from '@nestjs/common';
import * as childProcess from 'child_process';
import { tmpdir } from 'os';
import { AsyncMutex } from '../common/async-mutex';
import { ERROR_CODES } from '../common/error-codes';

export interface GitRunOptions {
  /** Use the 120s network timeout instead of the default 30s. */
  network?: boolean;
  /** Explicit timeout override, wins over `network`. */
  timeoutMs?: number;
  /** Resolve with a nonzero exitCode instead of throwing. */
  allowFailure?: boolean;
  /** Injected by T13's opportunistic keychain pickup; GitRunner knows
   * nothing about *where* this comes from. */
  sshAuthSock?: string;
}

export interface GitRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class GitCommandError extends Error {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly args: string[];
  readonly timedOut: boolean;

  constructor(opts: {
    exitCode: number;
    stdout: string;
    stderr: string;
    args: string[];
    timedOut: boolean;
  }) {
    const outcome = opts.timedOut
      ? 'timed out'
      : `exited with code ${opts.exitCode}`;
    super(`git ${opts.args.join(' ')} ${outcome}`);
    this.name = 'GitCommandError';
    this.exitCode = opts.exitCode;
    this.stdout = opts.stdout;
    this.stderr = opts.stderr;
    this.args = opts.args;
    this.timedOut = opts.timedOut;
  }
}

// Callers can never pass these — `cwd` already carries the repo location,
// and honoring any of these from caller-controlled argv would let a
// caller point git somewhere WorkspacePathService never validated.
const BANNED_EXACT_ARGS = new Set(['-C', '--git-dir', '--work-tree']);
const BANNED_ARG_PREFIXES = ['--git-dir=', '--work-tree='];

/**
 * Builds the hardened environment every git invocation runs under.
 *
 * Deliberately does NOT forward `GIT_AUTHOR_*`/`GIT_COMMITTER_*` (or any
 * other ambient git env) — commits made through the app must resolve
 * identity from the target repo's own (local) config, never from whatever
 * happens to be set in this process's environment.
 */
function buildEnv(sshAuthSock?: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: 'C.UTF-8',
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/true',
    SSH_ASKPASS: '/bin/true',
    SSH_ASKPASS_REQUIRE: 'never',
    GIT_SSH_COMMAND:
      'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10',
    ...(sshAuthSock ? { SSH_AUTH_SOCK: sshAuthSock } : {}),
  };
}

interface ExecFileErrorShape {
  code?: number | string | null;
  killed?: boolean;
  signal?: string | null;
}

/**
 * The single chokepoint every git invocation in the app goes through.
 *
 * No constructor dependencies: `cwd` always arrives pre-validated by the
 * caller (via `WorkspacePathService`/`GitRepoService`), so this class never
 * touches path resolution itself. Tests instantiate it directly with `new
 * GitRunner()`.
 */
@Injectable()
export class GitRunner {
  // Per-cwd mutex, lazily created. Every run() — reads included, not just
  // index-mutating writes — goes through it: two concurrent git invocations
  // against the same working tree can otherwise race on index.lock.
  private readonly mutexes = new Map<string, AsyncMutex>();

  private mutexFor(cwd: string): AsyncMutex {
    let mutex = this.mutexes.get(cwd);
    if (!mutex) {
      mutex = new AsyncMutex();
      this.mutexes.set(cwd, mutex);
    }
    return mutex;
  }

  async run(
    cwd: string,
    args: string[],
    opts: GitRunOptions = {},
  ): Promise<GitRunResult> {
    for (const arg of args) {
      if (
        BANNED_EXACT_ARGS.has(arg) ||
        BANNED_ARG_PREFIXES.some((prefix) => arg.startsWith(prefix))
      ) {
        // Programmer error, not a client-facing condition — a caller
        // building argv must never include these, full stop.
        throw new Error(
          `GitRunner.run: argument "${arg}" is banned; cwd already carries the repo location`,
        );
      }
    }

    return this.mutexFor(cwd).runExclusive(() => this.spawn(cwd, args, opts));
  }

  async runWithPathspecs(
    cwd: string,
    argsBeforeDashDash: string[],
    pathspecs: string[],
    opts?: GitRunOptions,
  ): Promise<GitRunResult> {
    for (const pathspec of pathspecs) {
      this.assertNotOptionLike(pathspec, 'pathspec');
    }
    return this.run(cwd, [...argsBeforeDashDash, '--', ...pathspecs], opts);
  }

  async checkRefFormat(name: string): Promise<boolean> {
    // Needs no repo — any cwd that exists will do.
    const { exitCode } = await this.run(
      tmpdir(),
      ['check-ref-format', '--branch', name],
      { allowFailure: true },
    );
    return exitCode === 0;
  }

  /**
   * `git checkout -- --evil` is a real bug class: anything that ultimately
   * becomes a pathspec or positional revision must be rejected up front if
   * it starts with `-`, since after that point git itself may interpret it
   * as an option instead of a literal value.
   */
  assertNotOptionLike(value: string, label: string): void {
    if (value.startsWith('-')) {
      throw new BadRequestException({
        code: ERROR_CODES.INVALID_PATHSPEC,
        message: `${label} must not start with "-": ${JSON.stringify(value)}`,
      });
    }
  }

  private spawn(
    cwd: string,
    args: string[],
    opts: GitRunOptions,
  ): Promise<GitRunResult> {
    const timeout = opts.timeoutMs ?? (opts.network ? 120_000 : 30_000);
    return new Promise<GitRunResult>((resolvePromise, rejectPromise) => {
      childProcess.execFile(
        'git',
        args,
        {
          cwd,
          shell: false,
          timeout,
          killSignal: 'SIGKILL',
          maxBuffer: 32 * 1024 * 1024,
          env: buildEnv(opts.sshAuthSock),
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolvePromise({ stdout, stderr, exitCode: 0 });
            return;
          }

          const execErr = error as ExecFileErrorShape;
          // Node signals a timeout kill via `killed: true` with the
          // `killSignal` we asked for; there's no separate `timedOut`
          // flag to read off the raw error.
          const timedOut = execErr.killed === true;
          let exitCode: number;
          if (typeof execErr.code === 'number') {
            exitCode = execErr.code;
          } else {
            exitCode = timedOut ? -1 : 1;
          }

          if (opts.allowFailure && !timedOut) {
            resolvePromise({ stdout, stderr, exitCode });
            return;
          }

          rejectPromise(
            new GitCommandError({ exitCode, stdout, stderr, args, timedOut }),
          );
        },
      );
    });
  }
}

/**
 * Shared mapper every controller calls in its `catch`. Callers that need a
 * more specific code (stderr pattern matching for auth failures, missing
 * refs, etc. — T11-T14) inspect `GitCommandError.stderr` themselves and
 * throw their own `HttpException` *before* falling back to this.
 */
export function toHttpException(err: unknown): HttpException {
  if (err instanceof HttpException) {
    // Already shaped (e.g. INVALID_PATHSPEC) — never swallow it.
    return err;
  }

  if (err instanceof GitCommandError) {
    if (err.timedOut) {
      return new GatewayTimeoutException({
        code: ERROR_CODES.GIT_TIMEOUT,
        message: 'git command timed out',
      });
    }
    return new UnprocessableEntityException({
      code: ERROR_CODES.GIT_COMMAND_FAILED,
      message: 'git command failed',
      detail: {
        exitCode: err.exitCode,
        args: err.args,
        stderr: err.stderr.slice(0, 4000),
      },
    });
  }

  const message = err instanceof Error ? err.message : 'Unexpected error';
  return new InternalServerErrorException({
    code: ERROR_CODES.INTERNAL_ERROR,
    message,
  });
}
