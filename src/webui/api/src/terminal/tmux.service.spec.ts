// Node's builtin `child_process` exports are non-configurable, so
// `jest.spyOn` cannot patch the real module in place (F54). `jest.mock`
// swaps the whole module out of the registry instead — `execFile` stays
// wired to the real implementation (so every other test here still spawns
// real tmux, matching the project's precedent of testing against the real
// binary rather than mocks), but becomes a `jest.fn` we can assert calls
// against.
jest.mock('child_process', () => {
  const actual =
    jest.requireActual<typeof import('child_process')>('child_process');
  return { ...actual, execFile: jest.fn(actual.execFile) };
});

import * as childProcess from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WebuiConfigService } from '../config/webui-config.service';
import { TmuxService } from './tmux.service';

describe('TmuxService (against real tmux)', () => {
  let socket: string;
  let tmuxTmpDir: string;
  let confPath: string;
  let prevSocket: string | undefined;
  let prevConf: string | undefined;
  let prevTmuxTmpDir: string | undefined;
  let service: TmuxService;

  beforeEach(() => {
    // Unique socket name AND a unique TMUX_TMPDIR per test: tmux resolves
    // -L <name> to $TMUX_TMPDIR/tmux-<uid>/<name>, so without a fresh
    // TMUX_TMPDIR two parallel test files sharing the default /tmp/tmux-<uid>
    // directory could still collide on housekeeping (e.g. a stale socket
    // from a killed server), and it makes teardown a plain `rm -rf`.
    socket = `webui-test-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    tmuxTmpDir = mkdtempSync(join(tmpdir(), 'webui-tmux-test-'));
    confPath = join(tmuxTmpDir, 'tmux.conf');
    writeFileSync(confPath, 'set -g status off\n');

    prevSocket = process.env.WEBUI_TMUX_SOCKET;
    prevConf = process.env.WEBUI_TMUX_CONF;
    prevTmuxTmpDir = process.env.TMUX_TMPDIR;
    process.env.WEBUI_TMUX_SOCKET = socket;
    process.env.WEBUI_TMUX_CONF = confPath;
    process.env.TMUX_TMPDIR = tmuxTmpDir;

    service = new TmuxService(new WebuiConfigService());
  });

  afterEach(() => {
    try {
      childProcess.execFileSync('tmux', ['-L', socket, 'kill-server'], {
        stdio: 'ignore',
        env: process.env,
      });
    } catch {
      // Nonzero + "no server running" is expected once the last session in
      // a test has already been killed — best-effort cleanup, not an
      // assertion.
    }

    if (prevSocket === undefined) {
      delete process.env.WEBUI_TMUX_SOCKET;
    } else {
      process.env.WEBUI_TMUX_SOCKET = prevSocket;
    }
    if (prevConf === undefined) {
      delete process.env.WEBUI_TMUX_CONF;
    } else {
      process.env.WEBUI_TMUX_CONF = prevConf;
    }
    if (prevTmuxTmpDir === undefined) {
      delete process.env.TMUX_TMPDIR;
    } else {
      process.env.TMUX_TMPDIR = prevTmuxTmpDir;
    }

    rmSync(tmuxTmpDir, { recursive: true, force: true });
  });

  it('exists() is false for a session that was never created', async () => {
    await expect(service.exists('wui-000000000000')).resolves.toBe(false);
  });

  it('list() on a server with no sessions returns [], not a throw', async () => {
    await expect(service.list()).resolves.toEqual([]);
  });

  it('create() then exists() -> true; list() shows it with correct label, mode and cwd', async () => {
    const info = await service.create({
      name: 'wui-aaaaaaaaaaaa',
      absCwd: tmuxTmpDir,
      mode: 'shell',
      label: 'Shell 1',
    });

    expect(info.name).toBe('wui-aaaaaaaaaaaa');
    expect(info.mode).toBe('shell');
    expect(info.label).toBe('Shell 1');
    expect(info.cwd).toBe(tmuxTmpDir);
    expect(typeof info.createdAt).toBe('number');
    expect(Number.isFinite(info.createdAt)).toBe(true);

    await expect(service.exists('wui-aaaaaaaaaaaa')).resolves.toBe(true);

    const sessions = await service.list();
    expect(sessions).toEqual([info]);
  });

  it('create() twice with the same name yields one session; label unchanged from the first call', async () => {
    const first = await service.create({
      name: 'wui-bbbbbbbbbbbb',
      absCwd: tmuxTmpDir,
      mode: 'shell',
      label: 'First label',
    });
    const second = await service.create({
      name: 'wui-bbbbbbbbbbbb',
      absCwd: tmuxTmpDir,
      mode: 'claude',
      label: 'Second label',
    });

    expect(second).toEqual(first);
    expect(second.label).toBe('First label');
    expect(second.mode).toBe('shell');

    const sessions = await service.list();
    expect(sessions).toHaveLength(1);
  });

  it('kill() removes the session; kill() again does not throw', async () => {
    await service.create({
      name: 'wui-cccccccccccc',
      absCwd: tmuxTmpDir,
      mode: 'shell',
      label: 'To be killed',
    });

    await service.kill('wui-cccccccccccc');
    await expect(service.exists('wui-cccccccccccc')).resolves.toBe(false);

    await expect(service.kill('wui-cccccccccccc')).resolves.toBeUndefined();
  });

  it('rejects a name that fails the allowlist before any tmux call', async () => {
    const execFileMock = childProcess.execFile as unknown as jest.Mock;
    execFileMock.mockClear();

    await expect(service.exists('not-a-valid-name')).rejects.toThrow(
      /invalid session name/,
    );
    expect(execFileMock).not.toHaveBeenCalled();

    await expect(
      service.create({
        name: '../../etc/passwd',
        absCwd: tmuxTmpDir,
        mode: 'shell',
        label: 'x',
      }),
    ).rejects.toThrow(/invalid session name/);
    expect(execFileMock).not.toHaveBeenCalled();

    await expect(service.kill('wui-tooshort')).rejects.toThrow(
      /invalid session name/,
    );
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('concurrent create() of the same name results in exactly one session', async () => {
    const opts = {
      name: 'wui-dddddddddddd',
      absCwd: tmuxTmpDir,
      mode: 'shell' as const,
      label: 'Race',
    };

    // Fire both without awaiting between them, so they interleave inside
    // the has-session -> new-session window the AsyncMutex is meant to
    // serialize.
    const [a, b] = await Promise.all([
      service.create(opts),
      service.create(opts),
    ]);

    expect(a).toEqual(b);

    const sessions = await service.list();
    expect(sessions).toHaveLength(1);
  });
});
