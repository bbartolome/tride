import { Injectable } from '@nestjs/common';
// This is a SECOND, deliberate `child_process` chokepoint — distinct from
// (and not a violation of) GitRunner's single-chokepoint invariant (F61).
// GitRunner owns every invocation of the `git` binary; TmuxService owns
// every invocation of the `tmux` binary. Different binary, different
// hardening needs (no repo cwd validation, no network timeout tiers, no
// pathspec handling) — folding the two together would just make GitRunner
// harder to reason about for no benefit.
import { execFile } from 'child_process';
import { AsyncMutex } from '../common/async-mutex';
import { WebuiConfigService } from '../config/webui-config.service';
import type { TerminalMode } from './session-name.util';

export interface TmuxSessionInfo {
  name: string;
  /** Milliseconds since the epoch (tmux reports `session_created` in
   * seconds; we normalize to ms to match every other timestamp in the
   * app). */
  createdAt: number;
  label: string;
  mode: TerminalMode;
  cwd: string;
}

export interface TmuxCreateOptions {
  name: string;
  absCwd: string;
  mode: TerminalMode;
  label: string;
}

export class TmuxCommandError extends Error {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly args: string[];

  constructor(opts: {
    exitCode: number;
    stdout: string;
    stderr: string;
    args: string[];
  }) {
    super(`tmux ${opts.args.join(' ')} exited with code ${opts.exitCode}`);
    this.name = 'TmuxCommandError';
    this.exitCode = opts.exitCode;
    this.stdout = opts.stdout;
    this.stderr = opts.stderr;
    this.args = opts.args;
  }
}

// Server-generated names only ever take this shape (see
// session-name.util.ts). Guarding it anyway, before it reaches argv, is
// the same idiom as the stash-ref allowlist (F104) — cheap insurance
// against a future caller passing something unvalidated through.
const SESSION_NAME_RE = /^wui-[0-9a-f]{12}$/;

// tmux reports "no server for this socket" in two different shapes
// depending on whether the socket file exists at all: "error connecting
// to <path> (No such file or directory)" when it was never created, or
// "no server running on <path>" when a stale socket file is left behind
// after the server exited (e.g. the last session was killed). Both mean
// the same thing to us: zero sessions.
const NO_SERVER_RE = /no server running|error connecting to/i;
const NO_SUCH_SESSION_RE = /can't find session/i;

// A printable character, not a control byte: tmux's format renderer
// sanitizes control characters appearing in the *template* text (not just
// substituted values) before writing them out - '\t' silently becomes '_',
// and other control bytes (e.g. '\x1f') come back octal-escaped as the
// literal 4-character text "\037" rather than the raw byte. Either way the
// chosen separator never survives, so every field collapses into one
// unsplittable string and TmuxService.create's post-creation lookup could
// never find the session it had just made - every create() call failed
// with "not found immediately after creation". '|' is confirmed to pass
// through unmangled. It cannot appear in session_name (hex-only, server-
// generated), session_created (digits) or @webui_mode ('shell'/'claude');
// parseShellLabel() rejects it from the one freeform field, @webui_label,
// specifically so it can't collide here either.
export const FIELD_SEP = '|';
const LIST_FORMAT = [
  '#{session_name}',
  '#{session_created}',
  '#{@webui_label}',
  '#{@webui_mode}',
  '#{session_path}',
].join(FIELD_SEP);

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ExecFileErrorShape {
  code?: number | string | null;
}

/**
 * Single chokepoint for every `tmux` invocation. Sessions themselves are
 * the only source of truth for label/mode/cwd (via `@webui_label` /
 * `@webui_mode` session options and `session_path`) — there is no
 * side-car registry file, so sessions survive a Nest process restart with
 * zero reconciliation work.
 */
@Injectable()
export class TmuxService {
  // Guards the has-session -> new-session / kill-session window so two
  // concurrent create() (or create()/kill()) calls for the same session
  // name cannot race tmux itself. Reads (exists/list) don't need it.
  private readonly mutex = new AsyncMutex();

  constructor(private readonly config: WebuiConfigService) {}

  async exists(name: string): Promise<boolean> {
    this.assertValidName(name);
    return this.existsUnlocked(name);
  }

  async list(): Promise<TmuxSessionInfo[]> {
    const { exitCode, stdout, stderr } = await this.run(
      ['list-sessions', '-F', LIST_FORMAT],
      { allowFailure: true },
    );
    if (exitCode !== 0) {
      if (NO_SERVER_RE.test(stderr) || NO_SERVER_RE.test(stdout)) {
        return [];
      }
      throw new TmuxCommandError({
        exitCode,
        stdout,
        stderr,
        args: ['list-sessions', '-F', LIST_FORMAT],
      });
    }
    return this.parseList(stdout);
  }

  /**
   * Idempotent: if `name` already has a session, returns it UNCHANGED —
   * attaching means "get what's there", not "merge in whatever label was
   * passed this time".
   */
  async create(opts: TmuxCreateOptions): Promise<TmuxSessionInfo> {
    this.assertValidName(opts.name);
    return this.mutex.runExclusive(async () => {
      const existing = await this.findUnlocked(opts.name);
      if (existing) {
        return existing;
      }

      if (opts.mode === 'claude') {
        // Supplying ANY command to `new-session` switches tmux from the
        // login-shell form to its implicit `${SHELL} -c` form, which is a
        // NON-login shell — /etc/profile.d/sdkman.sh would not be sourced
        // and Java/Maven would be invisible to Claude's own tool calls
        // inside this session (F119). The explicit `bash -lc '...'` here
        // is what restores a login shell around the command.
        //
        // `; exec bash -l` keeps the pane alive (as a plain login shell)
        // after `claude` exits, rather than the session vanishing.
        //
        // No quoting/escaping is added on top of the template string, by
        // construction, not oversight: `opts.absCwd` never appears inside
        // this string (it's the separate `-c` argv element above), and
        // `opts.label` was already validated by the controller against
        // /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/ (F126) — starting alphanumeric
        // rules out a leading dash being read as a flag, and the character
        // class excludes spaces, quotes, semicolons and every other shell
        // metacharacter. The whole payload is one argv element passed to
        // execFile with shell:false, so there is exactly one shell parse:
        // bash -lc's own. Do not add quoting/escaping here.
        await this.run([
          'new-session',
          '-d',
          '-s',
          opts.name,
          '-c',
          opts.absCwd,
          'bash',
          '-lc',
          `claude --remote-control ${opts.label}; exec bash -l`,
        ]);
      } else {
        // No trailing command: this is the login-shell form (tmux prefixes
        // argv[0] with `-`), which is how the pane inherits the devcontainer
        // .bashrc block, SDKMAN, and the npm-global PATH — see
        // src/webui-tmux.conf's comment. Do not add a command here.
        await this.run([
          'new-session',
          '-d',
          '-s',
          opts.name,
          '-c',
          opts.absCwd,
        ]);
      }
      await this.run([
        'set-option',
        '-t',
        opts.name,
        '@webui_label',
        opts.label,
      ]);
      await this.run(['set-option', '-t', opts.name, '@webui_mode', opts.mode]);

      const created = await this.findUnlocked(opts.name);
      if (!created) {
        // Should be unreachable — we just created it under the mutex —
        // but fail loudly rather than returning undefined-shaped data.
        throw new Error(
          `TmuxService.create: session "${opts.name}" not found immediately after creation`,
        );
      }
      return created;
    });
  }

  /** Idempotent: killing a session that doesn't exist is a no-op. */
  async kill(name: string): Promise<void> {
    this.assertValidName(name);
    await this.mutex.runExclusive(async () => {
      const { exitCode, stdout, stderr } = await this.run(
        ['kill-session', '-t', name],
        { allowFailure: true },
      );
      if (exitCode === 0) {
        return;
      }
      if (
        NO_SUCH_SESSION_RE.test(stderr) ||
        NO_SUCH_SESSION_RE.test(stdout) ||
        NO_SERVER_RE.test(stderr) ||
        NO_SERVER_RE.test(stdout)
      ) {
        return;
      }
      throw new TmuxCommandError({
        exitCode,
        stdout,
        stderr,
        args: ['kill-session', '-t', name],
      });
    });
  }

  private async existsUnlocked(name: string): Promise<boolean> {
    const { exitCode } = await this.run(['has-session', '-t', name], {
      allowFailure: true,
    });
    return exitCode === 0;
  }

  private async findUnlocked(name: string): Promise<TmuxSessionInfo | null> {
    const sessions = await this.list();
    return sessions.find((session) => session.name === name) ?? null;
  }

  private parseList(stdout: string): TmuxSessionInfo[] {
    return stdout
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const [name, createdSeconds, label, mode, cwd] = line.split(FIELD_SEP);
        return {
          name,
          createdAt: Number(createdSeconds) * 1000,
          label: label ?? '',
          mode: (mode ?? 'shell') as TerminalMode,
          cwd,
        };
      });
  }

  private assertValidName(name: string): void {
    if (!SESSION_NAME_RE.test(name)) {
      throw new Error(
        `TmuxService: refusing to operate on invalid session name ${JSON.stringify(name)}`,
      );
    }
  }

  private run(
    args: string[],
    opts: { allowFailure?: boolean } = {},
  ): Promise<RunResult> {
    const { socket, confPath } = this.socketAndConf();
    const fullArgs = ['-L', socket, '-f', confPath, ...args];
    return new Promise<RunResult>((resolvePromise, rejectPromise) => {
      execFile(
        'tmux',
        fullArgs,
        {
          shell: false,
          timeout: 10_000,
          killSignal: 'SIGKILL',
          // Pass the environment explicitly so this and PtyService resolve
          // the same tmux socket. tmux locates its socket via TMUX_TMPDIR,
          // and PtyService already passes env explicitly; leaving it implicit
          // here means the two can disagree about where the server lives —
          // create/list succeed against one directory while the attach looks
          // in another and reports "no sessions".
          env: process.env,
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolvePromise({ stdout, stderr, exitCode: 0 });
            return;
          }
          const execErr = error as ExecFileErrorShape;
          const exitCode = typeof execErr.code === 'number' ? execErr.code : 1;
          if (opts.allowFailure) {
            resolvePromise({ stdout, stderr, exitCode });
            return;
          }
          rejectPromise(
            new TmuxCommandError({ exitCode, stdout, stderr, args: fullArgs }),
          );
        },
      );
    });
  }

  private socketAndConf(): { socket: string; confPath: string } {
    const { tmuxSocket, tmuxConfPath } = this.config.config;
    return { socket: tmuxSocket, confPath: tmuxConfPath };
  }
}
