import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { AppModule } from '../src/app.module';

const SEEDED_LOGIN = 'seeded-admin@example.com';

interface TreeEntryBody {
  name: string;
  type: string;
  size?: number;
  isRepo?: boolean;
}

interface TreeResponseBody {
  path: string;
  entries: TreeEntryBody[];
}

interface FileResponseBody {
  binary: boolean;
  size: number;
  content?: string;
  truncated?: boolean;
}

/**
 * Exercises the real app (guards, middleware, module wiring included) via
 * supertest, same idiom as auth.e2e-spec.ts. `WEBUI_WORKSPACE_ROOT` is
 * pointed at a fresh mkdtemp dir for every test — never at the real
 * `~/workspace`.
 */
describe('Workspace fs (e2e)', () => {
  let app: INestApplication;
  let workspaceRoot: string;
  let stateDir: string;
  let prevWorkspaceRoot: string | undefined;
  let prevAdminLogins: string | undefined;
  let prevStateDir: string | undefined;

  beforeEach(async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'webui-fs-e2e-root-'));
    mkdirSync(join(workspaceRoot, 'sub'));
    writeFileSync(join(workspaceRoot, 'sub', 'hello.txt'), 'hello world');
    // Binary: a NUL byte in the first bytes.
    writeFileSync(
      join(workspaceRoot, 'sub', 'binary.dat'),
      Buffer.from([0x00, 0x01, 0x02, 0xff]),
    );
    // Bigger than the small `max` a test below requests, to prove truncation.
    writeFileSync(join(workspaceRoot, 'sub', 'big.txt'), 'x'.repeat(1000));
    // Symlink escaping the workspace entirely.
    symlinkSync('/', join(workspaceRoot, 'escape'));

    stateDir = mkdtempSync(join(tmpdir(), 'webui-fs-e2e-state-'));

    prevWorkspaceRoot = process.env.WEBUI_WORKSPACE_ROOT;
    prevAdminLogins = process.env.WEBUI_ADMIN_LOGINS;
    prevStateDir = process.env.WEBUI_STATE_DIR;
    process.env.WEBUI_WORKSPACE_ROOT = workspaceRoot;
    process.env.WEBUI_ADMIN_LOGINS = SEEDED_LOGIN;
    process.env.WEBUI_STATE_DIR = stateDir;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();

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

    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('GET /api/fs/tree with no identity header -> 401 AUTH_REQUIRED', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/fs/tree?path=.')
      .expect(401);
    expect(res.body).toEqual({
      code: 'AUTH_REQUIRED',
      message: 'Authentication required',
    });
  });

  it('GET /api/fs/tree lists a directory: file sizes present, dotfiles included, symlinks silently omitted', async () => {
    writeFileSync(join(workspaceRoot, 'sub', '.dotfile'), 'x');
    const res = await request(app.getHttpServer())
      .get('/api/fs/tree?path=sub')
      .set('tailscale-user-login', SEEDED_LOGIN)
      .expect(200);

    const body = res.body as TreeResponseBody;
    expect(body.path).toBe('sub');
    const byName = new Map(body.entries.map((e) => [e.name, e]));
    expect(byName.get('hello.txt')).toMatchObject({ type: 'file', size: 11 });
    expect(byName.get('.dotfile')).toMatchObject({ type: 'file' });
  });

  it('GET /api/fs/tree marks a directory containing .git as isRepo:true', async () => {
    const repoDir = join(workspaceRoot, 'a-repo');
    mkdirSync(join(repoDir, '.git'), { recursive: true });
    const res = await request(app.getHttpServer())
      .get('/api/fs/tree?path=.')
      .set('tailscale-user-login', SEEDED_LOGIN)
      .expect(200);
    const body = res.body as TreeResponseBody;
    expect(body.entries.find((e) => e.name === 'a-repo')).toMatchObject({
      isRepo: true,
    });
    expect(body.entries.find((e) => e.name === 'sub')).toMatchObject({
      isRepo: false,
    });
  });

  describe('containment rejections', () => {
    it.each([['../..'], ['/etc'], ['escape/etc']])(
      'GET /api/fs/tree?path=%s -> 403 PATH_OUTSIDE_WORKSPACE',
      async (path) => {
        const res = await request(app.getHttpServer())
          .get(`/api/fs/tree?path=${encodeURIComponent(path)}`)
          .set('tailscale-user-login', SEEDED_LOGIN)
          .expect(403);
        expect(res.body).toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
      },
    );

    it.each([['../..'], ['/etc'], ['escape/etc']])(
      'GET /api/fs/file?path=%s -> 403 PATH_OUTSIDE_WORKSPACE',
      async (path) => {
        const res = await request(app.getHttpServer())
          .get(`/api/fs/file?path=${encodeURIComponent(path)}`)
          .set('tailscale-user-login', SEEDED_LOGIN)
          .expect(403);
        expect(res.body).toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
      },
    );
  });

  it('GET /api/fs/file on a binary file -> binary:true with no content', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/fs/file?path=sub/binary.dat')
      .set('tailscale-user-login', SEEDED_LOGIN)
      .expect(200);
    const body = res.body as FileResponseBody;
    expect(body).toMatchObject({ binary: true, size: 4 });
    expect(body.content).toBeUndefined();
  });

  it('GET /api/fs/file with max smaller than the file -> truncated:true', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/fs/file?path=sub/big.txt&max=10')
      .set('tailscale-user-login', SEEDED_LOGIN)
      .expect(200);
    const body = res.body as FileResponseBody;
    expect(body).toMatchObject({
      binary: false,
      truncated: true,
      size: 1000,
    });
    expect(body.content).toHaveLength(10);
  });

  it('GET /api/fs/file reads a whole small file when it fits under max, with truncated:false', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/fs/file?path=sub/hello.txt')
      .set('tailscale-user-login', SEEDED_LOGIN)
      .expect(200);
    expect(res.body).toEqual({
      binary: false,
      content: 'hello world',
      truncated: false,
      size: 11,
    });
  });
});
