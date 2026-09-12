import {
  ConflictException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { WebuiConfigService } from '../config/webui-config.service';
import { UsersService } from './users.service';

function createConfig(
  stateDir: string,
  adminLogins: string[],
): WebuiConfigService {
  return {
    config: {
      port: 8088,
      workspaceRoot: '/root/workspace',
      adminLogins: new Set(adminLogins),
      stateDir,
      tmuxSocket: 'webui',
    },
  } as unknown as WebuiConfigService;
}

describe('UsersService', () => {
  let stateDir: string;
  let service: UsersService;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'users-service-'));
  });

  afterEach(() => {
    service?.onModuleDestroy();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function makeService(
    adminLogins: string[] = ['admin@example.com'],
  ): UsersService {
    service = new UsersService(createConfig(stateDir, adminLogins));
    return service;
  }

  it('resolves a seeded login as admin/seeded on isAllowed', async () => {
    const svc = makeService(['admin@example.com']);
    await expect(svc.isAllowed('admin@example.com')).resolves.toEqual({
      role: 'admin',
      seeded: true,
    });
  });

  it('returns null for an unknown login', async () => {
    const svc = makeService(['admin@example.com']);
    await expect(svc.isAllowed('nobody@example.com')).resolves.toBeNull();
  });

  it('refuses all three mutations against a seeded login with 409 SEEDED_IMMUTABLE', async () => {
    const svc = makeService(['admin@example.com']);

    await expect(
      svc.add('admin@example.com', 'user', 'admin@example.com'),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      svc.update('admin@example.com', 'user'),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.remove('admin@example.com')).rejects.toBeInstanceOf(
      ConflictException,
    );

    try {
      await svc.add('admin@example.com', 'user', 'admin@example.com');
      throw new Error('expected to throw');
    } catch (err) {
      expect((err as ConflictException).getResponse()).toMatchObject({
        code: 'SEEDED_IMMUTABLE',
      });
    }
  });

  it('add/list/update/remove happy path for a runtime user', async () => {
    const svc = makeService(['admin@example.com']);

    const added = await svc.add(
      'newbie@example.com',
      'user',
      'admin@example.com',
    );
    expect(added).toMatchObject({ login: 'newbie@example.com', role: 'user' });

    let list = await svc.list();
    expect(list).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          login: 'newbie@example.com',
          role: 'user',
          seeded: false,
        }),
        expect.objectContaining({
          login: 'admin@example.com',
          role: 'admin',
          seeded: true,
        }),
      ]),
    );

    const updated = await svc.update('newbie@example.com', 'admin');
    expect(updated.role).toBe('admin');

    await svc.remove('newbie@example.com');
    list = await svc.list();
    expect(list.find((u) => u.login === 'newbie@example.com')).toBeUndefined();
  });

  it('rejects a duplicate runtime add with 409', async () => {
    const svc = makeService(['admin@example.com']);
    await svc.add('newbie@example.com', 'user', 'admin@example.com');
    await expect(
      svc.add('newbie@example.com', 'user', 'admin@example.com'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('serves seeded reads but 503s mutations when users.json is malformed', async () => {
    const svc = makeService(['admin@example.com']);
    writeFileSync(join(stateDir, 'users.json'), '{not valid json');

    await expect(svc.isAllowed('admin@example.com')).resolves.toEqual({
      role: 'admin',
      seeded: true,
    });
    await expect(
      svc.add('newbie@example.com', 'user', 'admin@example.com'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('reloads after an out-of-band edit changes the file mtime', async () => {
    const svc = makeService(['admin@example.com']);
    await svc.add('newbie@example.com', 'user', 'admin@example.com');

    const filePath = join(stateDir, 'users.json');
    const before = statSync(filePath);
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        users: [
          {
            login: 'newbie@example.com',
            role: 'user',
            addedBy: 'admin@example.com',
            addedAt: new Date().toISOString(),
          },
          {
            login: 'hand-added@example.com',
            role: 'admin',
            addedBy: 'ssh',
            addedAt: new Date().toISOString(),
          },
        ],
      }),
    );
    // Force a distinct mtime, independent of filesystem timestamp
    // resolution, so the reload is deterministically triggered.
    const future = new Date(before.mtime.getTime() + 5000);
    utimesSync(filePath, future, future);

    await expect(svc.isAllowed('hand-added@example.com')).resolves.toEqual({
      role: 'admin',
      seeded: false,
    });
  });

  it('persists users.json as mode 0600 with no leftover tmp file', async () => {
    const svc = makeService(['admin@example.com']);
    await svc.add('newbie@example.com', 'user', 'admin@example.com');

    const filePath = join(stateDir, 'users.json');
    const stats = statSync(filePath);
    expect(stats.mode & 0o777).toBe(0o600);

    const leftovers = readdirSync(stateDir).filter((name) =>
      name.includes('.tmp-'),
    );
    expect(leftovers).toEqual([]);
  });

  it('a seeded login shadows a runtime entry of the same login', async () => {
    const filePath = join(stateDir, 'users.json');
    // Simulate a stale runtime entry that predates this login being
    // promoted to a seeded admin via WEBUI_ADMIN_LOGINS.
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        users: [
          {
            login: 'admin@example.com',
            role: 'user',
            addedBy: 'x',
            addedAt: new Date().toISOString(),
          },
        ],
      }),
    );
    const svc = makeService(['admin@example.com']);

    await expect(svc.isAllowed('admin@example.com')).resolves.toEqual({
      role: 'admin',
      seeded: true,
    });
    const list = await svc.list();
    expect(list.filter((u) => u.login === 'admin@example.com')).toEqual([
      {
        login: 'admin@example.com',
        role: 'admin',
        addedBy: '',
        addedAt: '',
        seeded: true,
      },
    ]);
  });

  it('warns on an interval while the allowlist is empty and stops after onModuleDestroy', () => {
    jest.useFakeTimers();
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const svc = makeService([]);
      svc.onModuleInit();

      jest.advanceTimersByTime(60_000);
      expect(warnSpy).toHaveBeenCalled();

      svc.onModuleDestroy();
      warnSpy.mockClear();
      jest.advanceTimersByTime(120_000);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      jest.useRealTimers();
    }
  });
});
