import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { AppModule } from '../src/app.module';

const SEEDED_LOGIN = 'seeded-admin@example.com';

interface TerminalSummaryBody {
  id: string;
  cwd: string;
  mode: string;
  label: string;
  createdAt: number;
}

/**
 * Exercises the real app (guards, middleware, module wiring included) via
 * supertest, same idiom as git.e2e-spec.ts/workspace.e2e-spec.ts.
 * `WEBUI_WORKSPACE_ROOT` is a fresh mkdtemp dir per test, and — per the
 * isolation pattern F122 establishes for T17-T19 — the tmux socket name AND
 * `TMUX_TMPDIR` are also unique per test, torn down with a `kill-server` in
 * `afterEach`.
 */
describe('Terminal (e2e)', () => {
  let app: INestApplication;
  let workspaceRoot: string;
  let stateDir: string;
  let tmuxSocket: string;
  let tmuxTmpDir: string;
  let tmuxConfPath: string;
  let prevWorkspaceRoot: string | undefined;
  let prevAdminLogins: string | undefined;
  let prevStateDir: string | undefined;
  let prevTmuxSocket: string | undefined;
  let prevTmuxConf: string | undefined;
  let prevTmuxTmpDir: string | undefined;

  beforeEach(async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'webui-term-e2e-root-'));
    mkdirSync(join(workspaceRoot, 'proj'));
    writeFileSync(join(workspaceRoot, 'a-file.txt'), 'not a directory\n');

    stateDir = mkdtempSync(join(tmpdir(), 'webui-term-e2e-state-'));

    tmuxSocket = `webui-term-e2e-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    tmuxTmpDir = mkdtempSync(join(tmpdir(), 'webui-term-e2e-tmux-'));
    tmuxConfPath = join(tmuxTmpDir, 'tmux.conf');
    writeFileSync(tmuxConfPath, 'set -g status off\n');

    prevWorkspaceRoot = process.env.WEBUI_WORKSPACE_ROOT;
    prevAdminLogins = process.env.WEBUI_ADMIN_LOGINS;
    prevStateDir = process.env.WEBUI_STATE_DIR;
    prevTmuxSocket = process.env.WEBUI_TMUX_SOCKET;
    prevTmuxConf = process.env.WEBUI_TMUX_CONF;
    prevTmuxTmpDir = process.env.TMUX_TMPDIR;

    process.env.WEBUI_WORKSPACE_ROOT = workspaceRoot;
    process.env.WEBUI_ADMIN_LOGINS = SEEDED_LOGIN;
    process.env.WEBUI_STATE_DIR = stateDir;
    process.env.WEBUI_TMUX_SOCKET = tmuxSocket;
    process.env.WEBUI_TMUX_CONF = tmuxConfPath;
    process.env.TMUX_TMPDIR = tmuxTmpDir;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();

    try {
      execFileSync('tmux', ['-L', tmuxSocket, 'kill-server'], {
        stdio: 'ignore',
        env: process.env,
      });
    } catch {
      // Nonzero + "no server running" is expected once every session has
      // already been killed — best-effort cleanup, not an assertion.
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

    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(tmuxTmpDir, { recursive: true, force: true });
  });

  /** Direct, out-of-band proof that a session exists — not just "the API
   * said 200" — by asking the real tmux binary on this test's own socket. */
  function hasSession(id: string): boolean {
    try {
      execFileSync('tmux', ['-L', tmuxSocket, 'has-session', '-t', id], {
        stdio: 'ignore',
        env: process.env,
      });
      return true;
    } catch {
      return false;
    }
  }

  function listSessionNamesRaw(): string {
    try {
      return execFileSync(
        'tmux',
        ['-L', tmuxSocket, 'list-sessions', '-F', '#{session_name}'],
        { stdio: ['ignore', 'pipe', 'ignore'], env: process.env },
      ).toString();
    } catch {
      // "no server running"/"error connecting to" — no sessions at all yet.
      return '';
    }
  }

  /** Direct, out-of-band read of a `@webui_*` session option — used to
   * prove idempotency (F120) at the tmux level, not just via the API
   * response. */
  function sessionOption(id: string, option: string): string {
    return execFileSync(
      'tmux',
      ['-L', tmuxSocket, 'show-options', '-t', id, '-v', option],
      { stdio: ['ignore', 'pipe', 'ignore'], env: process.env },
    )
      .toString()
      .trim();
  }

  // -------------------------------------------------------------------
  // 401 coverage (F69): every route, no tailscale-user-login header.
  // -------------------------------------------------------------------

  it('GET /api/terminals with no identity header -> 401 AUTH_REQUIRED', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/terminals')
      .expect(401);
    expect(res.body).toEqual({
      code: 'AUTH_REQUIRED',
      message: 'Authentication required',
    });
  });

  it('POST /api/terminals with no identity header -> 401 AUTH_REQUIRED', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/terminals')
      .set('X-Webui-Request', '1')
      .send({ cwd: 'proj' })
      .expect(401);
    expect(res.body).toEqual({
      code: 'AUTH_REQUIRED',
      message: 'Authentication required',
    });
  });

  it('DELETE /api/terminals/:id with no identity header -> 401 AUTH_REQUIRED', async () => {
    const res = await request(app.getHttpServer())
      .delete('/api/terminals/wui-000000000000')
      .set('X-Webui-Request', '1')
      .expect(401);
    expect(res.body).toEqual({
      code: 'AUTH_REQUIRED',
      message: 'Authentication required',
    });
  });

  it('POST /api/terminals/:id/ticket with no identity header -> 401 AUTH_REQUIRED', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/terminals/wui-000000000000/ticket')
      .set('X-Webui-Request', '1')
      .expect(401);
    expect(res.body).toEqual({
      code: 'AUTH_REQUIRED',
      message: 'Authentication required',
    });
  });

  // -------------------------------------------------------------------
  // create — shell mode
  // -------------------------------------------------------------------

  it('POST /api/terminals creates a shell terminal, and the tmux session really exists', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/terminals')
      .set('X-Webui-Request', '1')
      .set('tailscale-user-login', SEEDED_LOGIN)
      .send({ cwd: 'proj' })
      .expect(200);

    const body = res.body as TerminalSummaryBody;
    expect(body.mode).toBe('shell');
    expect(body.cwd).toBe('proj');
    expect(typeof body.id).toBe('string');
    expect(typeof body.createdAt).toBe('number');

    expect(hasSession(body.id)).toBe(true);
  });

  it('POST /api/terminals twice with mode:"shell" and the same cwd yields two DIFFERENT ids (slot increments)', async () => {
    const first = await request(app.getHttpServer())
      .post('/api/terminals')
      .set('X-Webui-Request', '1')
      .set('tailscale-user-login', SEEDED_LOGIN)
      .send({ cwd: 'proj' })
      .expect(200);
    const second = await request(app.getHttpServer())
      .post('/api/terminals')
      .set('X-Webui-Request', '1')
      .set('tailscale-user-login', SEEDED_LOGIN)
      .send({ cwd: 'proj' })
      .expect(200);

    const firstId = (first.body as TerminalSummaryBody).id;
    const secondId = (second.body as TerminalSummaryBody).id;
    expect(secondId).not.toBe(firstId);
    expect(hasSession(firstId)).toBe(true);
    expect(hasSession(secondId)).toBe(true);
  });

  // -------------------------------------------------------------------
  // create — claude mode idempotency (F114/F120)
  // -------------------------------------------------------------------

  it('POST /api/terminals twice with mode:"claude", same cwd, different labels -> same id, one session, first label wins (T19 quick-launch)', async () => {
    const first = await request(app.getHttpServer())
      .post('/api/terminals')
      .set('X-Webui-Request', '1')
      .set('tailscale-user-login', SEEDED_LOGIN)
      .send({ cwd: 'proj', mode: 'claude', label: 'test-a' })
      .expect(200);
    const second = await request(app.getHttpServer())
      .post('/api/terminals')
      .set('X-Webui-Request', '1')
      .set('tailscale-user-login', SEEDED_LOGIN)
      .send({ cwd: 'proj', mode: 'claude', label: 'test-b' })
      .expect(200);

    const firstBody = first.body as TerminalSummaryBody;
    const secondBody = second.body as TerminalSummaryBody;
    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.label).toBe('test-a');
    expect(hasSession(firstBody.id)).toBe(true);

    const list = await request(app.getHttpServer())
      .get('/api/terminals')
      .set('tailscale-user-login', SEEDED_LOGIN)
      .expect(200);
    const sessions = list.body as TerminalSummaryBody[];
    expect(sessions.filter((s) => s.mode === 'claude')).toHaveLength(1);

    // Direct proof, from tmux itself rather than the API, that the second
    // call attached to the existing session instead of spawning a second
    // Claude: exactly one session with this name exists, and its
    // `@webui_label`/`@webui_mode` options are unchanged from the first
    // call (F120's idempotency — attaching means "get what's there", not
    // "merge in whatever was passed this time").
    const sessionNames = listSessionNamesRaw()
      .split('\n')
      .filter((line) => line.length > 0);
    expect(sessionNames.filter((name) => name === firstBody.id)).toHaveLength(
      1,
    );
    expect(sessionOption(firstBody.id, '@webui_label')).toBe('test-a');
    expect(sessionOption(firstBody.id, '@webui_mode')).toBe('claude');
  });

  // -------------------------------------------------------------------
  // cwd validation / containment (F39)
  // -------------------------------------------------------------------

  it.each([['../..'], ['/etc']])(
    'POST /api/terminals with cwd=%s -> 403 PATH_OUTSIDE_WORKSPACE',
    async (cwd) => {
      const res = await request(app.getHttpServer())
        .post('/api/terminals')
        .set('X-Webui-Request', '1')
        .set('tailscale-user-login', SEEDED_LOGIN)
        .send({ cwd })
        .expect(403);
      expect(res.body).toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
    },
  );

  it('POST /api/terminals with cwd pointing at a file -> 400 VALIDATION_ERROR (not a `-c <file>` tmux invocation)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/terminals')
      .set('X-Webui-Request', '1')
      .set('tailscale-user-login', SEEDED_LOGIN)
      .send({ cwd: 'a-file.txt' })
      .expect(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('POST /api/terminals with a non-existent cwd -> 400 VALIDATION_ERROR (not the generic 404)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/terminals')
      .set('X-Webui-Request', '1')
      .set('tailscale-user-login', SEEDED_LOGIN)
      .send({ cwd: 'does-not-exist' })
      .expect(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  // -------------------------------------------------------------------
  // claude label validation — rejected before any tmux call
  // -------------------------------------------------------------------

  // Leading-dash cases matter beyond ordinary validation: the label is a
  // positional argument to `claude` in the T19 quick-launch, so
  // '--dangerously-skip-permissions' would be parsed as a flag rather
  // than a session name.
  it.each([
    [undefined],
    ['bad label'],
    ['; rm -rf /'],
    ['--flag'],
    ['--dangerously-skip-permissions'],
    ['-x'],
  ])(
    'POST /api/terminals mode:"claude" with label=%p -> 400 VALIDATION_ERROR, no tmux session created',
    async (label) => {
      const before = listSessionNamesRaw();

      const body: Record<string, unknown> = { cwd: 'proj', mode: 'claude' };
      if (label !== undefined) {
        body.label = label;
      }
      const res = await request(app.getHttpServer())
        .post('/api/terminals')
        .set('X-Webui-Request', '1')
        .set('tailscale-user-login', SEEDED_LOGIN)
        .send(body)
        .expect(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });

      expect(listSessionNamesRaw()).toBe(before);
    },
  );

  it('POST /api/terminals with an invalid mode -> 400 VALIDATION_ERROR', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/terminals')
      .set('X-Webui-Request', '1')
      .set('tailscale-user-login', SEEDED_LOGIN)
      .send({ cwd: 'proj', mode: 'bogus' })
      .expect(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  // -------------------------------------------------------------------
  // delete
  // -------------------------------------------------------------------

  it('DELETE /api/terminals/:id removes the tmux session; deleting again -> 404 TERMINAL_NOT_FOUND', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/terminals')
      .set('X-Webui-Request', '1')
      .set('tailscale-user-login', SEEDED_LOGIN)
      .send({ cwd: 'proj' })
      .expect(200);
    const id = (created.body as TerminalSummaryBody).id;
    expect(hasSession(id)).toBe(true);

    await request(app.getHttpServer())
      .delete(`/api/terminals/${id}`)
      .set('X-Webui-Request', '1')
      .set('tailscale-user-login', SEEDED_LOGIN)
      .expect(204);
    expect(hasSession(id)).toBe(false);

    const res = await request(app.getHttpServer())
      .delete(`/api/terminals/${id}`)
      .set('X-Webui-Request', '1')
      .set('tailscale-user-login', SEEDED_LOGIN)
      .expect(404);
    expect(res.body).toMatchObject({ code: 'TERMINAL_NOT_FOUND' });
  });

  it('DELETE /api/terminals/:id for an id that never existed -> 404 TERMINAL_NOT_FOUND', async () => {
    const res = await request(app.getHttpServer())
      .delete('/api/terminals/wui-000000000000')
      .set('X-Webui-Request', '1')
      .set('tailscale-user-login', SEEDED_LOGIN)
      .expect(404);
    expect(res.body).toMatchObject({ code: 'TERMINAL_NOT_FOUND' });
  });

  it('DELETE /api/terminals/:id with a malformed id -> 404 TERMINAL_NOT_FOUND, not a 500', async () => {
    const res = await request(app.getHttpServer())
      .delete('/api/terminals/not-a-valid-session-name')
      .set('X-Webui-Request', '1')
      .set('tailscale-user-login', SEEDED_LOGIN)
      .expect(404);
    expect(res.body).toMatchObject({ code: 'TERMINAL_NOT_FOUND' });
  });

  // -------------------------------------------------------------------
  // ticket (F114)
  // -------------------------------------------------------------------

  it('POST /api/terminals/:id/ticket mints a ticket shaped {ticket, expiresAt}', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/terminals')
      .set('X-Webui-Request', '1')
      .set('tailscale-user-login', SEEDED_LOGIN)
      .send({ cwd: 'proj' })
      .expect(200);
    const id = (created.body as TerminalSummaryBody).id;

    const res = await request(app.getHttpServer())
      .post(`/api/terminals/${id}/ticket`)
      .set('X-Webui-Request', '1')
      .set('tailscale-user-login', SEEDED_LOGIN)
      .expect(200);

    const body = res.body as { ticket: string; expiresAt: number };
    expect(typeof body.ticket).toBe('string');
    expect(body.ticket.length).toBeGreaterThan(0);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  it('POST /api/terminals/:id/ticket for an unknown id -> 404 TERMINAL_NOT_FOUND', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/terminals/wui-000000000000/ticket')
      .set('X-Webui-Request', '1')
      .set('tailscale-user-login', SEEDED_LOGIN)
      .expect(404);
    expect(res.body).toMatchObject({ code: 'TERMINAL_NOT_FOUND' });
  });
});
