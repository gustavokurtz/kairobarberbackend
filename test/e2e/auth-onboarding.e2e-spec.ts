import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaService } from '../../src/infra/prisma/prisma.service';
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

describe('Email normalize — lookup case-variant (isolated)', () => {
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

  it('login funciona com email case-variant após signup (lookup normalize)', async () => {
    const server = app.getHttpServer();

    await request(server)
      .post('/auth/register/owner')
      .send({
        email: 'CaseLookup@Example.com',
        password: 'StrongPass!1',
        name: 'Case Lookup',
        tenantName: 'Case Lookup Barber',
        slug: 'case-lookup',
      })
      .expect(201);

    const login = await request(server)
      .post('/auth/login')
      .send({ email: 'caselookup@example.com', password: 'StrongPass!1' })
      .expect(200);

    const body = login.body as LoginResponse;
    expect(body.accessToken).toBeTruthy();
  });
});

describe('Email normalize — duplicate detection (isolated)', () => {
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

  it('rejeita signup com email case-variant do existente (409)', async () => {
    const server = app.getHttpServer();

    await request(server)
      .post('/auth/register/owner')
      .send({
        email: 'dupCase@Example.com',
        password: 'StrongPass!1',
        name: 'Dup Case',
        tenantName: 'Dup Case Barber',
        slug: 'dup-case-1',
      })
      .expect(201);

    const conflict = await request(server)
      .post('/auth/register/owner')
      .send({
        email: 'DUPCASE@example.com',
        password: 'StrongPass!1',
        name: 'Dup Case 2',
        tenantName: 'Dup Case Barber 2',
        slug: 'dup-case-2',
      })
      .expect(409);

    const body = conflict.body as ErrorResponse;
    expect(body.code).toBe('EMAIL_ALREADY_REGISTERED');
  });
});

describe('Email normalize — write lowercase (isolated)', () => {
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

  it('grava email normalizado (lowercase) no DB após signup', async () => {
    const server = app.getHttpServer();

    const reg = await request(server)
      .post('/auth/register/owner')
      .send({
        email: 'NormalizeWrite@Example.com',
        password: 'StrongPass!1',
        name: 'Normalize Write',
        tenantName: 'Normalize Write Barber',
        slug: 'normalize-write',
      })
      .expect(201);

    const body = reg.body as RegisterResponse;
    expect(body.user.email).toBe('normalizewrite@example.com');
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

describe('DB unique constraint LOWER(email) (isolated app instance)', () => {
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

  it('DB rejeita INSERT direto com email case-variant (constraint funcional)', async () => {
    const server = app.getHttpServer();

    // Registrar via API — grava email normalizado (lowercase) pela T4
    await request(server)
      .post('/auth/register/owner')
      .send({
        email: 'dbconstraint@example.com',
        password: 'StrongPass!1',
        name: 'DB Constraint',
        tenantName: 'DB Constraint Barber',
        slug: 'db-constraint',
      })
      .expect(201);

    // Bypassar service e tentar INSERT direto via Prisma com case-variant
    // Sem o índice funcional, Postgres aceita (case-sensitive @unique).
    // Com o índice funcional, deve falhar.
    const prisma = app.get(PrismaService);

    await expect(
      prisma.user.create({
        data: {
          email: 'DBConstraint@Example.com', // case-variant deliberado
          passwordHash: 'fakehash',
          name: 'Bypass',
          role: 'tenant_owner',
        },
      }),
    ).rejects.toThrow(/Unique constraint|user_email_lower_unique|already exists|unique/i);
  });
});
