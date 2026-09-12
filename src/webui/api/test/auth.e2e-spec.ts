import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { AppModule } from '../src/app.module';

const SEEDED_LOGIN = 'seeded-admin@example.com';

/**
 * Exercises the real app (guards, middleware, module wiring included) via
 * supertest against a live HTTP server — every other guard test in this
 * package instantiates the guard directly against a mocked
 * ExecutionContext, so none of them would fail if AuthModule were dropped
 * from AppModule's imports, or if the CSRF guard were silently bypassed.
 * See T3 findings F19/F20.
 */
describe('Auth (e2e)', () => {
  let app: INestApplication;
  let stateDir: string;
  let prevAdminLogins: string | undefined;
  let prevStateDir: string | undefined;

  beforeEach(async () => {
    // A fresh state dir per run so nothing leaks between test runs or into
    // the repo.
    stateDir = mkdtempSync(join(tmpdir(), 'webui-auth-e2e-'));
    prevAdminLogins = process.env.WEBUI_ADMIN_LOGINS;
    prevStateDir = process.env.WEBUI_STATE_DIR;
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
  });

  it('GET /healthz with no identity -> 200 (the @Public bypass still works)', async () => {
    await request(app.getHttpServer()).get('/healthz').expect(200).expect({
      status: 'ok',
    });
  });

  it('GET /api/me with no identity header -> 401 AUTH_REQUIRED', async () => {
    const res = await request(app.getHttpServer()).get('/api/me').expect(401);
    expect(res.body).toEqual({
      code: 'AUTH_REQUIRED',
      message: 'Authentication required',
    });
  });

  it('GET /api/me with an unknown login -> 403 NOT_ALLOWED', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/me')
      .set('tailscale-user-login', 'nobody@example.com')
      .expect(403);
    expect(res.body).toEqual({ code: 'NOT_ALLOWED', message: 'Not allowed' });
  });

  it('GET /api/me for a seeded admin -> 200 role=admin seeded=true', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/me')
      .set('tailscale-user-login', SEEDED_LOGIN)
      .expect(200);
    expect(res.body).toMatchObject({
      login: SEEDED_LOGIN,
      role: 'admin',
      seeded: true,
    });
  });

  it('POST /api/users with a valid identity but no X-Webui-Request header is rejected by the CSRF guard', async () => {
    await request(app.getHttpServer())
      .post('/api/users')
      .set('tailscale-user-login', SEEDED_LOGIN)
      .send({ login: 'newbie@example.com', role: 'user' })
      .expect(403);
  });

  it('POST /api/users with a valid identity and a foreign Origin is rejected by the CSRF guard', async () => {
    await request(app.getHttpServer())
      .post('/api/users')
      .set('tailscale-user-login', SEEDED_LOGIN)
      .set('X-Webui-Request', '1')
      .set('Origin', 'http://evil.example')
      .send({ login: 'newbie@example.com', role: 'user' })
      .expect(403);
  });

  it('POST /api/users with the correct triple succeeds and the new runtime user shows up via GET /api/me', async () => {
    await request(app.getHttpServer())
      .post('/api/users')
      .set('tailscale-user-login', SEEDED_LOGIN)
      .set('X-Webui-Request', '1')
      .send({ login: 'newbie@example.com', role: 'user' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/api/me')
      .set('tailscale-user-login', 'newbie@example.com')
      .expect(200);
    expect(res.body).toMatchObject({
      login: 'newbie@example.com',
      role: 'user',
      seeded: false,
    });
  });

  it('a runtime (non-admin) user calling POST /api/users -> 403', async () => {
    await request(app.getHttpServer())
      .post('/api/users')
      .set('tailscale-user-login', SEEDED_LOGIN)
      .set('X-Webui-Request', '1')
      .send({ login: 'newbie@example.com', role: 'user' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/users')
      .set('tailscale-user-login', 'newbie@example.com')
      .set('X-Webui-Request', '1')
      .send({ login: 'someone-else@example.com', role: 'user' })
      .expect(403);
  });

  it('DELETE /api/users/<a seeded login> -> 409, checked before the self-removal check', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/api/users/${encodeURIComponent(SEEDED_LOGIN)}`)
      .set('tailscale-user-login', SEEDED_LOGIN)
      .set('X-Webui-Request', '1')
      .expect(409);
    expect(res.body).toEqual({
      code: 'SEEDED_IMMUTABLE',
      message: 'Login is a seeded admin and cannot be removed',
    });
  });
});
