import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import type { RawData } from 'ws';
import { WebSocket } from 'ws';
import { AppModule } from '../src/app.module';

// The success-path tests spawn a real login shell and wait for real
// PTY/tmux round trips (plus small startup-settle sleeps) — comfortably
// over jest's default 5s per-test timeout.
jest.setTimeout(20_000);

const SEEDED_LOGIN = 'seeded-admin@example.com';
const WS_PATH = '/ws/term';

interface TicketBody {
  ticket: string;
  expiresAt: number;
}

/**
 * Exercises the real `/ws/term` upgrade path end to end: real HTTP upgrade
 * over a real listening socket, real tmux, real `@lydell/node-pty`. Follows
 * the F122 isolation pattern established in T16/T17: a unique
 * `WEBUI_TMUX_SOCKET` and a fresh `TMUX_TMPDIR` per test, torn down with
 * `kill-server` in `afterEach`.
 *
 * `app.init()` alone never binds a real port (Nest's testing harness leaves
 * that to `app.listen()`, which this suite deliberately never calls) — a
 * WebSocket upgrade needs an actual TCP socket to connect to, so this suite
 * calls `app.getHttpServer().listen(0)` itself and reads the ephemeral port
 * back off `address()`.
 */
// ws types a frame as Buffer | ArrayBuffer | Buffer[]. Normalise once rather
// than per-branch: String() on the non-Buffer members yields '[object
// ArrayBuffer]', which would silently turn a text frame into unparseable junk.
function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

describe('Terminal WebSocket gateway (e2e)', () => {
  let app: INestApplication;
  let port: number;
  let workspaceRoot: string;
  let projDir: string;
  let stateDir: string;
  let tmuxSocket: string;
  let tmuxTmpDir: string;
  let tmuxConfPath: string;
  let openSockets: WebSocket[];
  let homeDir: string;

  let prevWorkspaceRoot: string | undefined;
  let prevAdminLogins: string | undefined;
  let prevStateDir: string | undefined;
  let prevTmuxSocket: string | undefined;
  let prevTmuxConf: string | undefined;
  let prevTmuxTmpDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'webui-ws-e2e-root-'));
    projDir = join(workspaceRoot, 'proj');
    mkdirSync(projDir);

    stateDir = mkdtempSync(join(tmpdir(), 'webui-ws-e2e-state-'));

    tmuxSocket = `webui-ws-e2e-${process.pid}-${randomBytes(4).toString('hex')}`;
    tmuxTmpDir = mkdtempSync(join(tmpdir(), 'webui-ws-e2e-tmux-'));
    tmuxConfPath = join(tmuxTmpDir, 'tmux.conf');
    writeFileSync(tmuxConfPath, 'set -g status off\n');

    // Isolate HOME. The nonce round-trip test attaches a REAL login shell
    // (F119: tmux's own login-shell semantics, deliberately unmodified here),
    // and a login shell reads the real user's ~/.profile -> ~/.bashrc ->
    // ~/.bashrc.ext chain. On a real devcontainer host that last file is
    // personal and can do anything, including (as discovered) invoking
    // `keychain --eval --agents ssh <key>`, which blocks on an interactive
    // passphrase prompt whenever no agent is already unlocked in the
    // session. That hung this exact test for 5s of real wall-clock time
    // instead of failing fast, and made the suite's outcome depend on the
    // ambient state of whichever machine happens to run it -- not a
    // regression in the app, but a real hermeticity bug in this spec, found
    // by an actual login-shell hang rather than an assumption. An isolated
    // HOME with no rc files at all still exercises a genuine `-bash` login
    // shell (PtyService's argv is unchanged); it just starts clean.
    homeDir = mkdtempSync(join(tmpdir(), 'webui-ws-e2e-home-'));

    prevWorkspaceRoot = process.env.WEBUI_WORKSPACE_ROOT;
    prevAdminLogins = process.env.WEBUI_ADMIN_LOGINS;
    prevStateDir = process.env.WEBUI_STATE_DIR;
    prevTmuxSocket = process.env.WEBUI_TMUX_SOCKET;
    prevTmuxConf = process.env.WEBUI_TMUX_CONF;
    prevTmuxTmpDir = process.env.TMUX_TMPDIR;
    prevHome = process.env.HOME;

    process.env.WEBUI_WORKSPACE_ROOT = workspaceRoot;
    process.env.WEBUI_ADMIN_LOGINS = SEEDED_LOGIN;
    process.env.WEBUI_STATE_DIR = stateDir;
    process.env.WEBUI_TMUX_SOCKET = tmuxSocket;
    process.env.WEBUI_TMUX_CONF = tmuxConfPath;
    process.env.TMUX_TMPDIR = tmuxTmpDir;
    process.env.HOME = homeDir;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    const httpServer = app.getHttpServer() as import('http').Server;
    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });
    port = (httpServer.address() as AddressInfo).port;

    openSockets = [];
  });

  afterEach(async () => {
    await Promise.all(
      openSockets.map((ws) =>
        ws.readyState === WebSocket.CLOSED
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              ws.once('close', () => resolve());
              ws.terminate();
            }),
      ),
    );
    // Give the server's synchronous 'close' -> cleanup() -> proc.kill()
    // chain a beat to actually deliver the signal before kill-server.
    await new Promise((resolve) => setTimeout(resolve, 150));

    await app.close();

    try {
      execFileSync('tmux', ['-L', tmuxSocket, 'kill-server'], {
        stdio: 'ignore',
        env: process.env,
      });
    } catch {
      // "no server running"/"error connecting to" — nothing left to kill.
    }

    if (prevWorkspaceRoot === undefined) {
      delete process.env.WEBUI_WORKSPACE_ROOT;
    } else {
      process.env.WEBUI_WORKSPACE_ROOT = prevWorkspaceRoot;
    }
    if (prevAdminLogins === undefined) {
      delete process.env.WEBUI_ADMIN_LOGINS;
    } else {
      process.env.WEBUI_ADMIN_LOGINS = prevAdminLogins;
    }
    if (prevStateDir === undefined) {
      delete process.env.WEBUI_STATE_DIR;
    } else {
      process.env.WEBUI_STATE_DIR = prevStateDir;
    }
    if (prevTmuxSocket === undefined) {
      delete process.env.WEBUI_TMUX_SOCKET;
    } else {
      process.env.WEBUI_TMUX_SOCKET = prevTmuxSocket;
    }
    if (prevTmuxConf === undefined) {
      delete process.env.WEBUI_TMUX_CONF;
    } else {
      process.env.WEBUI_TMUX_CONF = prevTmuxConf;
    }
    if (prevTmuxTmpDir === undefined) {
      delete process.env.TMUX_TMPDIR;
    } else {
      process.env.TMUX_TMPDIR = prevTmuxTmpDir;
    }
    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }

    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(tmuxTmpDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // helpers
  // -----------------------------------------------------------------------

  function tmuxArgs(...rest: string[]): string[] {
    return ['-L', tmuxSocket, '-f', tmuxConfPath, ...rest];
  }

  /** Creates a real tmux session directly (bypassing the HTTP API — this
   * suite is about the WS gateway, not terminal creation, which T17 already
   * covers). */
  function createRawSession(name: string, absCwd: string): void {
    execFileSync(
      'tmux',
      tmuxArgs('new-session', '-d', '-s', name, '-c', absCwd),
      { stdio: 'ignore', env: process.env },
    );
    // TmuxService's own create() always sets these (they're how tmux is the
    // single source of truth for label/mode); an unset `@webui_mode` option
    // expands to an empty string via `#{@webui_mode}`, not "undefined", so
    // parseList()'s `mode ?? 'shell'` fallback never actually fires for a
    // session created without this — set it explicitly for realism.
    execFileSync(
      'tmux',
      tmuxArgs('set-option', '-t', name, '@webui_mode', 'shell'),
      { stdio: 'ignore', env: process.env },
    );
    execFileSync(
      'tmux',
      tmuxArgs('set-option', '-t', name, '@webui_label', 'Shell 1'),
      { stdio: 'ignore', env: process.env },
    );
  }

  function randomSessionId(): string {
    return `wui-${randomBytes(6).toString('hex')}`;
  }

  /** Types `text` into the pane followed by Enter — both the terminal's
   * character-echo and the shell's own output end up in the PTY's binary
   * stream either way, so this is only ever used to get a unique nonce
   * somewhere in that stream, never to depend on a prompt's exact shape. */
  function sendLine(name: string, text: string): void {
    execFileSync('tmux', tmuxArgs('send-keys', '-t', name, text, 'Enter'), {
      stdio: 'ignore',
      env: process.env,
    });
  }

  function wsUrl(params: Record<string, string>): string {
    const qs = new URLSearchParams(params).toString();
    return `ws://127.0.0.1:${port}${WS_PATH}${qs ? `?${qs}` : ''}`;
  }

  function originHeader(): string {
    return `http://127.0.0.1:${port}`;
  }

  interface Collected {
    text: Record<string, unknown>[];
    binary: Buffer[];
  }

  function connect(
    params: Record<string, string>,
    opts: { origin?: string | null; login?: string } = {},
  ): { ws: WebSocket; collected: Collected } {
    const headers: Record<string, string> = {};
    if (opts.login !== undefined) {
      headers['tailscale-user-login'] = opts.login;
    }
    const origin = opts.origin === undefined ? originHeader() : opts.origin;
    const ws = new WebSocket(wsUrl(params), {
      headers,
      ...(origin !== null ? { origin } : {}),
    });
    openSockets.push(ws);
    const collected: Collected = { text: [], binary: [] };
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        collected.binary.push(toBuffer(data));
      } else {
        try {
          collected.text.push(JSON.parse(toBuffer(data).toString('utf8')));
        } catch {
          // Not JSON — ignore for these tests.
        }
      }
    });
    return { ws, collected };
  }

  function waitForOpen(ws: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      if (ws.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
    });
  }

  function waitForUnexpectedResponse(
    ws: WebSocket,
  ): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      ws.once('unexpected-response', (_req, res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          let body: unknown;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            body = undefined;
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      });
      ws.once('open', () =>
        reject(new Error('expected unexpected-response, got open')),
      );
      // A hard socket error (rather than a well-formed HTTP rejection)
      // would otherwise hang this promise forever.
      ws.once('error', (err) => reject(err));
    });
  }

  async function waitForOutput(
    predicate: () => boolean,
    opts: { timeoutMs: number; pollMs: number },
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < opts.timeoutMs) {
      if (predicate()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, opts.pollMs));
    }
    if (!predicate()) {
      throw new Error('waitForOutput: timed out waiting for predicate');
    }
  }

  function containsNonce(collected: Collected, nonce: string): boolean {
    return Buffer.concat(collected.binary).toString('utf8').includes(nonce);
  }

  async function mintTicket(sessionId: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`/api/terminals/${sessionId}/ticket`)
      .set('X-Webui-Request', '1')
      .set('tailscale-user-login', SEEDED_LOGIN)
      .expect(200);
    return (res.body as TicketBody).ticket;
  }

  // -----------------------------------------------------------------------
  // rejections
  // -----------------------------------------------------------------------

  it('no identity header and no ticket -> unexpected-response 401 AUTH_REQUIRED', async () => {
    const id = randomSessionId();
    createRawSession(id, projDir);

    const { ws } = connect({ id });
    const { status, body } = await waitForUnexpectedResponse(ws);

    expect(status).toBe(401);
    expect(body).toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('wrong Origin -> unexpected-response 403, even with a valid identity header', async () => {
    const id = randomSessionId();
    createRawSession(id, projDir);

    const { ws } = connect(
      { id },
      { login: SEEDED_LOGIN, origin: 'http://evil.example' },
    );
    const { status } = await waitForUnexpectedResponse(ws);

    expect(status).toBe(403);
  });

  it('missing Origin entirely -> unexpected-response 403', async () => {
    const id = randomSessionId();
    createRawSession(id, projDir);

    const { ws } = connect({ id }, { login: SEEDED_LOGIN, origin: null });
    const { status } = await waitForUnexpectedResponse(ws);

    expect(status).toBe(403);
  });

  it('unknown id -> unexpected-response 404 TERMINAL_NOT_FOUND', async () => {
    const id = randomSessionId(); // well-formed, never created
    const { ws } = connect({ id }, { login: SEEDED_LOGIN });
    const { status, body } = await waitForUnexpectedResponse(ws);

    expect(status).toBe(404);
    expect(body).toMatchObject({ code: 'TERMINAL_NOT_FOUND' });
  });

  it('malformed id -> unexpected-response 400 VALIDATION_ERROR', async () => {
    const { ws } = connect(
      { id: 'not-a-valid-session-name' },
      { login: SEEDED_LOGIN },
    );
    const { status, body } = await waitForUnexpectedResponse(ws);

    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  // -----------------------------------------------------------------------
  // success paths
  // -----------------------------------------------------------------------

  it('valid header path: 101 -> attach -> ready -> real PTY output containing a nonce typed via tmux send-keys', async () => {
    const id = randomSessionId();
    createRawSession(id, projDir);

    const { ws, collected } = connect({ id }, { login: SEEDED_LOGIN });
    await waitForOpen(ws);

    ws.send(JSON.stringify({ type: 'attach', cols: 80, rows: 24 }));

    await waitForOutput(() => collected.text.some((m) => m.type === 'ready'), {
      timeoutMs: 5000,
      pollMs: 25,
    });
    const ready = collected.text.find((m) => m.type === 'ready');
    expect(ready).toMatchObject({ type: 'ready', session: id, mode: 'shell' });

    const nonce = `webui-nonce-${randomBytes(8).toString('hex')}`;
    // Give the shell inside the pane a moment to finish starting up before
    // typing into it — NOT asserted on; just avoids racing bash's own
    // startup output with our injected line.
    await new Promise((resolve) => setTimeout(resolve, 300));
    sendLine(id, `echo ${nonce}`);

    await waitForOutput(() => containsNonce(collected, nonce), {
      timeoutMs: 5000,
      pollMs: 25,
    });
  });

  it('ticket path: no identity header, valid ?ticket= -> same success', async () => {
    const id = randomSessionId();
    createRawSession(id, projDir);
    const ticket = await mintTicket(id);

    const { ws, collected } = connect({ id, ticket });
    await waitForOpen(ws);

    ws.send(JSON.stringify({ type: 'attach', cols: 80, rows: 24 }));
    await waitForOutput(() => collected.text.some((m) => m.type === 'ready'), {
      timeoutMs: 5000,
      pollMs: 25,
    });

    const nonce = `webui-nonce-${randomBytes(8).toString('hex')}`;
    await new Promise((resolve) => setTimeout(resolve, 300));
    sendLine(id, `echo ${nonce}`);
    await waitForOutput(() => containsNonce(collected, nonce), {
      timeoutMs: 5000,
      pollMs: 25,
    });
  });

  it('reused ticket: a second connection attempt with the same ticket is rejected (single-use)', async () => {
    const id = randomSessionId();
    createRawSession(id, projDir);
    const ticket = await mintTicket(id);

    const first = connect({ id, ticket });
    await waitForOpen(first.ws);
    await new Promise<void>((resolve) => {
      first.ws.once('close', () => resolve());
      first.ws.close();
    });

    const second = connect({ id, ticket });
    const { status, body } = await waitForUnexpectedResponse(second.ws);
    expect(status).toBe(401);
    expect(body).toMatchObject({ code: 'TICKET_INVALID' });
  });

  it('ticket minted for session A used against session B -> rejected', async () => {
    const idA = randomSessionId();
    const idB = randomSessionId();
    createRawSession(idA, projDir);
    createRawSession(idB, projDir);
    const ticketForA = await mintTicket(idA);

    const { ws } = connect({ id: idB, ticket: ticketForA });
    const { status, body } = await waitForUnexpectedResponse(ws);

    expect(status).toBe(401);
    expect(body).toMatchObject({ code: 'TICKET_INVALID' });
  });
});
