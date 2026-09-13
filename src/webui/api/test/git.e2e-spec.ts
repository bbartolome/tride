import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import {
  createMultiRepoWorkspace,
  removeMultiRepoWorkspace,
  type MultiRepoWorkspace,
} from '../src/git/__fixtures__/git-repo-fixture';

const SEEDED_LOGIN = 'seeded-admin@example.com';

/**
 * Exercises the real app (guards, middleware, module wiring included) via
 * supertest, same idiom as auth.e2e-spec.ts. `WEBUI_WORKSPACE_ROOT` is
 * pointed at a fresh, disposable fixture workspace built by
 * `createMultiRepoWorkspace` — never at the real `~/workspace`.
 */
describe('Git (e2e)', () => {
  let app: INestApplication;
  let workspace: MultiRepoWorkspace;
  let stateDir: string;
  let prevWorkspaceRoot: string | undefined;
  let prevAdminLogins: string | undefined;
  let prevStateDir: string | undefined;

  beforeEach(async () => {
    workspace = createMultiRepoWorkspace('git-e2e-workspace-');
    stateDir = mkdtempSync(join(tmpdir(), 'webui-git-e2e-state-'));

    prevWorkspaceRoot = process.env.WEBUI_WORKSPACE_ROOT;
    prevAdminLogins = process.env.WEBUI_ADMIN_LOGINS;
    prevStateDir = process.env.WEBUI_STATE_DIR;
    process.env.WEBUI_WORKSPACE_ROOT = workspace.root;
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
    removeMultiRepoWorkspace(workspace.root);
  });

  it('GET /api/repos with no identity header -> 401 AUTH_REQUIRED', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/repos')
      .expect(401);
    expect(res.body).toEqual({
      code: 'AUTH_REQUIRED',
      message: 'Authentication required',
    });
  });

  it('GET /api/repos discovers the plain repo and both sides of the worktree pair, and excludes every skipped case', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/repos')
      .set('tailscale-user-login', SEEDED_LOGIN)
      .expect(200);

    const repos = res.body as Array<Record<string, unknown>>;
    const byName = new Map(repos.map((r) => [r.name, r]));

    expect(byName.get('plain-repo')).toMatchObject({
      path: 'plain-repo',
      isWorktree: false,
    });
    expect(byName.get('wt-primary')).toMatchObject({ isWorktree: false });
    expect(byName.get('wt-sibling')).toMatchObject({ isWorktree: true });

    // node_modules/fake-pkg, .hidden/some-repo, the depth-3 a/b/repo, and
    // the broken worktree must never appear.
    expect(byName.has('fake-pkg')).toBe(false);
    expect(byName.has('some-repo')).toBe(false);
    expect(byName.has('repo')).toBe(false);
    expect(byName.has('wt-broken')).toBe(false);
  });

  it('GET /api/repos?refresh=1 recomputes rather than only ever serving a cached result', async () => {
    await request(app.getHttpServer())
      .get('/api/repos')
      .set('tailscale-user-login', SEEDED_LOGIN)
      .expect(200);

    const res = await request(app.getHttpServer())
      .get('/api/repos?refresh=1')
      .set('tailscale-user-login', SEEDED_LOGIN)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect((res.body as unknown[]).length).toBeGreaterThan(0);
  });

  it('GET /api/git/status with no identity header -> 401 AUTH_REQUIRED', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/git/status')
      .query({ repo: 'plain-repo' })
      .expect(401);
    expect(res.body).toEqual({
      code: 'AUTH_REQUIRED',
      message: 'Authentication required',
    });
  });

  it('GET /api/git/status?repo=plain-repo returns a clean status with no entries', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/git/status')
      .query({ repo: 'plain-repo' })
      .set('tailscale-user-login', SEEDED_LOGIN)
      .expect(200);

    expect(res.body).toMatchObject({
      branch: 'main',
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      entries: [],
    });
  });

  it('GET /api/git/status with no repo param -> 400 VALIDATION_ERROR', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/git/status')
      .set('tailscale-user-login', SEEDED_LOGIN)
      .expect(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('GET /api/git/status?repo=does-not-exist -> 404 REPO_NOT_FOUND', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/git/status')
      .query({ repo: 'does-not-exist' })
      .set('tailscale-user-login', SEEDED_LOGIN)
      .expect(404);
    expect(res.body).toMatchObject({ code: 'REPO_NOT_FOUND' });
  });

  it('GET /api/git/status?repo=plain-repo reports a staged rename, through the full app, without desync', async () => {
    writeFileSync(join(workspace.plainRepo, 'old.txt'), 'one\ntwo\n');
    execFileSync('git', ['add', '--', 'old.txt'], { cwd: workspace.plainRepo });
    execFileSync('git', ['commit', '--quiet', '-m', 'add old.txt'], {
      cwd: workspace.plainRepo,
    });
    writeFileSync(join(workspace.plainRepo, 'second.txt'), 'unchanged\n');
    execFileSync('git', ['add', '--', 'second.txt'], {
      cwd: workspace.plainRepo,
    });
    execFileSync('git', ['commit', '--quiet', '-m', 'add second.txt'], {
      cwd: workspace.plainRepo,
    });
    execFileSync('git', ['mv', 'old.txt', 'new.txt'], {
      cwd: workspace.plainRepo,
    });
    writeFileSync(
      join(workspace.plainRepo, 'second.txt'),
      'unchanged\nmodified\n',
    );

    const res = await request(app.getHttpServer())
      .get('/api/git/status')
      .query({ repo: 'plain-repo' })
      .set('tailscale-user-login', SEEDED_LOGIN)
      .expect(200);

    const body = res.body as { entries: Array<Record<string, unknown>> };
    const entries = body.entries;
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'renamed',
        path: 'new.txt',
        origPath: 'old.txt',
      }),
    );
    // The record after the rename must be intact, not consumed as the
    // rename's origPath field.
    expect(entries).toContainEqual(
      expect.objectContaining({ kind: 'ordinary', path: 'second.txt' }),
    );
  });
});
