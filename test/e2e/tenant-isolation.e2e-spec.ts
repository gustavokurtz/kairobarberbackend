import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import { tenantAls } from 'src/infra/prisma/prisma.service';

interface RegisterResponse {
  user: { id: string; email: string; name: string; role: string };
  tenant: { id: string; slug: string; name: string };
  accessToken: string;
  refreshToken: string;
}

interface SubscriptionRow {
  id: string;
  tenantId: string;
  status: string;
}

interface TenantResponse {
  id: string;
  slug: string;
}

interface ErrorResponse {
  code: string;
  message: string;
}

describe('Tenant Isolation (e2e) — CRÍTICO', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;

  let tokenA: string;
  let tenantAId: string;
  let tokenB: string;
  let tenantBId: string;

  beforeAll(async () => {
    setTestEnv();
    container = await startTestPostgres();
    app = await buildTestApp();

    const ra = await request(app.getHttpServer()).post('/auth/register/owner').send({
      email: 'a@example.com',
      password: 'StrongPass!1',
      name: 'Owner A',
      tenantName: 'Barbearia A',
      slug: 'barbearia-a',
    });
    if (ra.status !== 201)
      throw new Error(`Failed to register A: ${ra.status} ${JSON.stringify(ra.body)}`);
    const rb1 = ra.body as RegisterResponse;
    tokenA = rb1.accessToken;
    tenantAId = rb1.tenant.id;

    const rb = await request(app.getHttpServer()).post('/auth/register/owner').send({
      email: 'b@example.com',
      password: 'StrongPass!1',
      name: 'Owner B',
      tenantName: 'Barbearia B',
      slug: 'barbearia-b',
    });
    if (rb.status !== 201)
      throw new Error(`Failed to register B: ${rb.status} ${JSON.stringify(rb.body)}`);
    const rb2 = rb.body as RegisterResponse;
    tokenB = rb2.accessToken;
    tenantBId = rb2.tenant.id;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('tenant A only sees its own subscription via scoped middleware', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/tenant/subscription-debug')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    const rows = res.body as SubscriptionRow[];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].tenantId).toBe(tenantAId);
  });

  it('tenant B only sees its own subscription', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/tenant/subscription-debug')
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(200);
    const rows = res.body as SubscriptionRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].tenantId).toBe(tenantBId);
  });

  it('GET /admin/tenant of A does not leak data of B (and vice-versa)', async () => {
    const a = await request(app.getHttpServer())
      .get('/admin/tenant')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    const b = await request(app.getHttpServer())
      .get('/admin/tenant')
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(200);
    const ab = a.body as TenantResponse;
    const bb = b.body as TenantResponse;
    expect(ab.id).toBe(tenantAId);
    expect(bb.id).toBe(tenantBId);
    expect(ab.slug).not.toBe(bb.slug);
  });

  it('no auth header -> 401 on /admin/tenant', async () => {
    const res = await request(app.getHttpServer()).get('/admin/tenant').expect(401);
    expect((res.body as ErrorResponse).code).toBe('UNAUTHENTICATED');
  });

  it('scoped middleware also filters Barber for tenants A and B', async () => {
    // Create a barber for each tenant via raw scoped client (mirrors what BarbersService will do)
    // We use PrismaService directly via the Nest container.
    const { PrismaService } = await import('src/infra/prisma/prisma.service');
    const prisma = app.get(PrismaService);

    // Create barbers using the unscoped client (tenantId provided explicitly) to seed test data.
    // The isolation test is on findMany — whether scoped.barber.findMany() filters by tenant.
    await prisma.barber.create({
      data: { displayName: 'Barbeiro A1', tenantId: tenantAId },
    });
    await prisma.barber.create({
      data: { displayName: 'Barbeiro B1', tenantId: tenantBId },
    });

    // Use enterWith so Prisma's N-API callbacks inherit the same ALS context
    // (mirrors how JWT guard mutates the store set by the HTTP ALS middleware).
    const seenByA = await new Promise<{ displayName: string }[]>((resolve, reject) => {
      tenantAls.run({ tenantId: tenantAId }, () => {
        prisma.scoped.barber.findMany().then(resolve).catch(reject);
      });
    });
    const seenByB = await new Promise<{ displayName: string }[]>((resolve, reject) => {
      tenantAls.run({ tenantId: tenantBId }, () => {
        prisma.scoped.barber.findMany().then(resolve).catch(reject);
      });
    });

    expect(seenByA.map((b) => b.displayName)).toEqual(['Barbeiro A1']);
    expect(seenByB.map((b) => b.displayName)).toEqual(['Barbeiro B1']);
  });
});
