import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';

interface RegisterResponse {
  user: { id: string; email: string; name: string; role: string };
  tenant: { id: string; slug: string; name: string };
  accessToken: string;
  refreshToken: string;
}

interface TenantResponse {
  id: string;
  slug: string;
  subscription: { status: string; trialEndsAt: string };
}

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
}

interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
}

interface ErrorResponse {
  code: string;
  message: string;
}

describe('Onboarding completo (e2e)', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    setTestEnv();
    container = await startTestPostgres();
    app = await buildTestApp();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('registers owner, returns tokens, GET /admin/tenant works', async () => {
    const register = await request(app.getHttpServer())
      .post('/auth/register/owner')
      .send({
        email: 'gugu@example.com',
        password: 'StrongPass!1',
        name: 'Gugu',
        tenantName: 'Gugu Barbeiro',
        slug: 'gugubarbeiro',
      })
      .expect(201);

    const body = register.body as RegisterResponse;
    expect(body.user.email).toBe('gugu@example.com');
    expect(body.tenant.slug).toBe('gugubarbeiro');
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();

    const token = body.accessToken;

    const tenant = await request(app.getHttpServer())
      .get('/admin/tenant')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const tBody = tenant.body as TenantResponse;
    expect(tBody.slug).toBe('gugubarbeiro');
    expect(tBody.subscription.status).toBe('trialing');
    expect(new Date(tBody.subscription.trialEndsAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects duplicate slug', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/register/owner')
      .send({
        email: 'other@example.com',
        password: 'StrongPass!1',
        name: 'Outro',
        tenantName: 'Outra Barbearia',
        slug: 'gugubarbeiro',
      })
      .expect(409);
    expect((res.body as ErrorResponse).code).toBe('SLUG_TAKEN');
  });

  it('rejects reserved slug', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/register/owner')
      .send({
        email: 'admin@example.com',
        password: 'StrongPass!1',
        name: 'Admin',
        tenantName: 'Admin Barbearia',
        slug: 'admin',
      })
      .expect(409);
    expect((res.body as ErrorResponse).code).toBe('SLUG_RESERVED');
  });

  it('login + refresh works end-to-end', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'gugu@example.com', password: 'StrongPass!1' })
      .expect(200);
    const lBody = login.body as LoginResponse;
    expect(lBody.accessToken).toBeTruthy();
    const refresh = lBody.refreshToken;

    const refreshed = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: refresh })
      .expect(200);
    const rBody = refreshed.body as RefreshResponse;
    expect(rBody.accessToken).toBeTruthy();
    expect(rBody.refreshToken).not.toBe(refresh);
  });

  it('reuse of rotated refresh token is detected and revoked', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'gugu@example.com', password: 'StrongPass!1' })
      .expect(200);
    const refresh = (login.body as LoginResponse).refreshToken;

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: refresh })
      .expect(200);

    // Reusing the same refresh again
    const reuse = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: refresh })
      .expect(401);
    expect((reuse.body as ErrorResponse).code).toBe('REFRESH_REUSED');
  });

});

describe('Throttle (isolated app instance)', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    setTestEnv();
    container = await startTestPostgres();
    app = await buildTestApp();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('throttles register/owner em 4ª request consecutiva (3/60s/IP)', async () => {
    const server = app.getHttpServer();

    // 3 signups com slugs e emails distintos devem passar (limite 3/60s)
    for (let i = 0; i < 3; i++) {
      await request(server)
        .post('/auth/register/owner')
        .send({
          email: `throttle${i}@example.com`,
          password: 'StrongPass!1',
          name: `Throttle ${i}`,
          tenantName: `Throttle Barber ${i}`,
          slug: `throttle-${i}`,
        })
        .expect(201);
    }

    // 4ª request no mesmo IP em < 60s deve retornar 429 Too Many Requests
    await request(server)
      .post('/auth/register/owner')
      .send({
        email: 'throttle3@example.com',
        password: 'StrongPass!1',
        name: 'Throttle 3',
        tenantName: 'Throttle Barber 3',
        slug: 'throttle-3',
      })
      .expect(429);
  });
});
