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

  it('GET /api/git/diff with no identity header -> 401 AUTH_REQUIRED', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/git/diff')
      .query({ repo: 'plain-repo' })
      .expect(401);
    expect(res.body).toEqual({
      code: 'AUTH_REQUIRED',
      message: 'Authentication required',
    });
  });

  it('GET /api/git/diff reports different output for staged vs unstaged changes to the same file', async () => {
    writeFileSync(join(workspace.plainRepo, 'a.txt'), 'one\ntwo\nthree\n');
    execFileSync('git', ['add', '--', 'a.txt'], { cwd: workspace.plainRepo });
    execFileSync('git', ['commit', '--quiet', '-m', 'add a.txt'], {
      cwd: workspace.plainRepo,
    });
    writeFileSync(
      join(workspace.plainRepo, 'a.txt'),
      'one\nTWO-STAGED\nthree\n',
    );
    execFileSync('git', ['add', '--', 'a.txt'], { cwd: workspace.plainRepo });
    writeFileSync(
      join(workspace.plainRepo, 'a.txt'),
      'one\nTWO-STAGED\nthree\nFOUR-UNSTAGED\n',
    );

    const staged = await request(app.getHttpServer())
      .get('/api/git/diff')
      .query({ repo: 'plain-repo', path: 'a.txt', staged: '1' })
      .set('tailscale-user-login', SEEDED_LOGIN)
      .expect(200);
    const unstaged = await request(app.getHttpServer())
      .get('/api/git/diff')
      .query({ repo: 'plain-repo', path: 'a.txt' })
      .set('tailscale-user-login', SEEDED_LOGIN)
      .expect(200);

    expect((staged.body as { text: string }).text).toContain('+TWO-STAGED');
    expect((unstaged.body as { text: string }).text).toContain(
      '+FOUR-UNSTAGED',
    );
  });

  it('GET /api/git/diff detects a binary file and returns {binary:true}', async () => {
    writeFileSync(
      join(workspace.plainRepo, 'bin.dat'),
      Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]),
    );
    execFileSync('git', ['add', '--', 'bin.dat'], {
      cwd: workspace.plainRepo,
    });

    const res = await request(app.getHttpServer())
      .get('/api/git/diff')
      .query({ repo: 'plain-repo', path: 'bin.dat', staged: '1' })
      .set('tailscale-user-login', SEEDED_LOGIN)
      .expect(200);

    expect(res.body).toEqual({ binary: true });
  });

  it('GET /api/git/diff/summary with no identity header -> 401 AUTH_REQUIRED', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/git/diff/summary')
      .query({ repo: 'plain-repo' })
      .expect(401);
    expect(res.body).toEqual({
      code: 'AUTH_REQUIRED',
      message: 'Authentication required',
    });
  });

  it('GET /api/git/diff/summary reports a binary file, a colliding rename, and an ordinary change with the record after the rename intact', async () => {
    writeFileSync(join(workspace.plainRepo, 'old.txt'), 'line one\nline two\n');
    writeFileSync(join(workspace.plainRepo, 'third.txt'), 'third content\n');
    writeFileSync(join(workspace.plainRepo, 'bin.dat'), 'placeholder\n');
    execFileSync('git', ['add', '-A'], { cwd: workspace.plainRepo });
    execFileSync('git', ['commit', '--quiet', '-m', 'seed files'], {
      cwd: workspace.plainRepo,
    });

    // Engineered collision (F71 applied to numstat, per F70): the renamed
    // file's NEW path is itself shaped exactly like a valid numstat record,
    // so an under-consuming cursor would produce a convincing phantom entry
    // rather than obvious garbage.
    execFileSync('git', ['mv', 'old.txt', '1\t1\tdecoy.txt'], {
      cwd: workspace.plainRepo,
    });
    writeFileSync(
      join(workspace.plainRepo, 'third.txt'),
      'third content\nmodified\n',
    );
    writeFileSync(
      join(workspace.plainRepo, 'bin.dat'),
      Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x42, 0x49, 0x4e]),
    );
    execFileSync('git', ['add', '-A'], { cwd: workspace.plainRepo });

    const res = await request(app.getHttpServer())
      .get('/api/git/diff/summary')
      .query({ repo: 'plain-repo', staged: '1' })
      .set('tailscale-user-login', SEEDED_LOGIN)
      .expect(200);

    const summary = res.body as Array<Record<string, unknown>>;
    expect(summary).toHaveLength(3);
    expect(summary[0]).toMatchObject({
      path: '1\t1\tdecoy.txt',
      origPath: 'old.txt',
    });
    // The record positioned right after the rename — exactly the position
    // a desynced cursor would corrupt into a phantom "decoy.txt" entry —
    // must be the real binary entry.
    expect(summary[1]).toMatchObject({ path: 'bin.dat', binary: true });
    expect(summary).toContainEqual(
      expect.objectContaining({ path: 'third.txt', added: 1, deleted: 0 }),
    );
  });

  it('GET /api/git/show with no identity header -> 401 AUTH_REQUIRED', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/git/show')
      .query({ repo: 'plain-repo', rev: 'HEAD' })
      .expect(401);
    expect(res.body).toEqual({
      code: 'AUTH_REQUIRED',
      message: 'Authentication required',
    });
  });

  it('GET /api/git/show returns the header and diff of a commit, restrictable by path, and accepts a bare SHA', async () => {
    writeFileSync(join(workspace.plainRepo, 'x.txt'), 'one\n');
    writeFileSync(join(workspace.plainRepo, 'y.txt'), 'one\n');
    execFileSync('git', ['add', '-A'], { cwd: workspace.plainRepo });
    execFileSync('git', ['commit', '--quiet', '-m', 'seed x and y'], {
      cwd: workspace.plainRepo,
    });
    writeFileSync(join(workspace.plainRepo, 'x.txt'), 'one\ntwo\n');
    writeFileSync(join(workspace.plainRepo, 'y.txt'), 'one\ntwo\n');
    execFileSync('git', ['add', '-A'], { cwd: workspace.plainRepo });
    execFileSync('git', ['commit', '--quiet', '-m', 'touch x and y'], {
      cwd: workspace.plainRepo,
    });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: workspace.plainRepo,
    })
      .toString()
      .trim();

    // Bare SHA, no path filter, proves checkRefFormat is not applied (F59).
    const full = await request(app.getHttpServer())
      .get('/api/git/show')
      .query({ repo: 'plain-repo', rev: sha })
      .set('tailscale-user-login', SEEDED_LOGIN)
      .expect(200);
    expect(full.body).toMatchObject({
      header: { sha, message: 'touch x and y' },
    });
    expect((full.body as { diffText: string }).diffText).toContain('a/x.txt');
    expect((full.body as { diffText: string }).diffText).toContain('a/y.txt');

    const scoped = await request(app.getHttpServer())
      .get('/api/git/show')
      .query({ repo: 'plain-repo', rev: sha, path: 'x.txt' })
      .set('tailscale-user-login', SEEDED_LOGIN)
      .expect(200);
    expect((scoped.body as { diffText: string }).diffText).toContain('a/x.txt');
    expect((scoped.body as { diffText: string }).diffText).not.toContain(
      'a/y.txt',
    );
  });

  it('GET /api/git/show with no rev param -> 400 VALIDATION_ERROR', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/git/show')
      .query({ repo: 'plain-repo' })
      .set('tailscale-user-login', SEEDED_LOGIN)
      .expect(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('GET /api/git/log with no identity header -> 401 AUTH_REQUIRED', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/git/log')
      .query({ repo: 'plain-repo' })
      .expect(401);
    expect(res.body).toEqual({
      code: 'AUTH_REQUIRED',
      message: 'Authentication required',
    });
  });

  it('GET /api/git/log paginates with limit/skip and scopes to a path, and survives a delimiter-laden commit message', async () => {
    const shas: string[] = [];
    const commit = (relPath: string, content: string, message: string) => {
      writeFileSync(join(workspace.plainRepo, relPath), content);
      execFileSync('git', ['add', '-A'], { cwd: workspace.plainRepo });
      execFileSync('git', ['commit', '--quiet', '-m', message], {
        cwd: workspace.plainRepo,
      });
      shas.push(
        execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: workspace.plainRepo,
        })
          .toString()
          .trim(),
      );
    };

    commit('a.txt', '1\n', 'commit 1');
    commit('scoped.txt', 'v1\n', 'commit 2 touches scoped.txt');
    commit('b.txt', '1\n', 'commit 3');
    const trickyMessage =
      'Weird subject\n\nLine with \x1f US and \x1e RS embedded\nlast line';
    commit('scoped.txt', 'v2\n', trickyMessage);
    commit('c.txt', '1\n', 'commit 5');

    const page = await request(app.getHttpServer())
      .get('/api/git/log')
      .query({ repo: 'plain-repo', limit: 2, skip: 0 })
      .set('tailscale-user-login', SEEDED_LOGIN)
      .expect(200);
    const pageEntries = page.body as Array<Record<string, unknown>>;
    expect(pageEntries.map((e) => e.sha)).toEqual([shas[4], shas[3]]);
    // The delimiter-laden message survives the fixed-format parse intact.
    expect(pageEntries[1].message).toBe(trickyMessage);

    const nextPage = await request(app.getHttpServer())
      .get('/api/git/log')
      .query({ repo: 'plain-repo', limit: 2, skip: 2 })
      .set('tailscale-user-login', SEEDED_LOGIN)
      .expect(200);
    expect(
      (nextPage.body as Array<Record<string, unknown>>).map((e) => e.sha),
    ).toEqual([shas[2], shas[1]]);

    const scoped = await request(app.getHttpServer())
      .get('/api/git/log')
      .query({ repo: 'plain-repo', path: 'scoped.txt' })
      .set('tailscale-user-login', SEEDED_LOGIN)
      .expect(200);
    expect(
      (scoped.body as Array<Record<string, unknown>>).map((e) => e.sha),
    ).toEqual([shas[3], shas[1]]);
  });
});
