import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'net';
import { hostname, tmpdir } from 'os';
import { join } from 'path';
import { resolveSshAuthSock } from './ssh-auth-sock.util';

describe('resolveSshAuthSock', () => {
  let home: string;
  let keychainFile: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ssh-auth-sock-home-'));
    mkdirSync(join(home, '.keychain'));
    keychainFile = join(home, '.keychain', `${hostname()}-sh`);
    prevHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('returns the socket path when the keychain file names a real Unix socket', async () => {
    const socketPath = join(home, 'agent.sock');
    const server: Server = createServer();
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise);
      server.listen(socketPath, resolvePromise);
    });

    try {
      writeFileSync(
        keychainFile,
        `SSH_AUTH_SOCK=${socketPath}; export SSH_AUTH_SOCK;\nSSH_AGENT_PID=1234; export SSH_AGENT_PID;\n`,
      );

      expect(resolveSshAuthSock()).toBe(socketPath);
    } finally {
      await new Promise<void>((resolvePromise) =>
        server.close(() => resolvePromise()),
      );
    }
  });

  it('rejects a candidate that exists but is a plain file, not a socket', () => {
    const plainFile = join(home, 'not-a-socket');
    writeFileSync(plainFile, 'definitely not a socket\n');
    writeFileSync(
      keychainFile,
      `SSH_AUTH_SOCK=${plainFile}; export SSH_AUTH_SOCK;\n`,
    );

    expect(resolveSshAuthSock()).toBeUndefined();
  });

  it('returns undefined when the keychain file does not exist at all', () => {
    // Never created in this test — beforeEach only made the parent dir.
    expect(resolveSshAuthSock()).toBeUndefined();
  });

  it('returns undefined for a malformed keychain file (no SSH_AUTH_SOCK= line)', () => {
    writeFileSync(keychainFile, 'this file has nothing useful in it\n');
    expect(resolveSshAuthSock()).toBeUndefined();
  });

  it('returns undefined when HOME points somewhere unreadable/nonexistent', () => {
    process.env.HOME = join(home, 'does-not-exist');
    expect(resolveSshAuthSock()).toBeUndefined();
  });
});
