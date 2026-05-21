import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import { StartedRedis, flushTestRedis, startTestRedis } from '../support/billing';
import { PrismaService } from 'src/infra/prisma/prisma.service';

describe('Billing — past_due gating (e2e)', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let redis: StartedRedis;

  beforeAll(async () => {
    setTestEnv();
    container = await startTestPostgres();
    redis = await startTestRedis();
    app = await buildTestApp();
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await flushTestRedis(redis.url);
    await redis.container.stop();
    await container.stop();
  });

  // Hash determinístico do slug pra X-Forwarded-For: cada `registerAndLogin` vira
  // um "cliente" distinto pro throttler, evitando bater no @Throttle(3/60s) do
  // /auth/register/owner quando o spec faz 8+ signups em sequência. Funciona porque
  // o custom ThrottlerBehindProxyGuard usa req.ips[0] (populado via trust proxy).
  function slugToFakeIp(slug: string): string {
    let h = 0;
    for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
    // 10.x.x.x privado, evita confundir com IPs públicos reais em logs
    return `10.${(h >>> 16) & 0xff}.${(h >>> 8) & 0xff}.${h & 0xff}`;
  }

  async function registerAndLogin(slug: string): Promise<{
    accessToken: string;
    tenantId: string;
  }> {
    const server = app.getHttpServer() as unknown as import('http').Server;
    const fakeIp = slugToFakeIp(slug);
    const reg = await request(server)
      .post('/auth/register/owner')
      .set('X-Forwarded-For', fakeIp)
      .send({
        email: `${slug}@bill.test`,
        password: 'StrongPass!1',
        name: `Owner ${slug}`,
        tenantName: `Barber ${slug}`,
        slug,
      })
      .expect(201);
    const body = reg.body as { accessToken: string; tenant: { id: string } };
    return { accessToken: body.accessToken, tenantId: body.tenant.id };
  }

  async function forcePastDue(
    prisma: PrismaService,
    tenantId: string,
    opts: { currentPeriodEnd: Date | null },
  ): Promise<void> {
    await prisma.subscription.update({
      where: { tenantId },
      data: {
        status: 'past_due',
        currentPeriodEnd: opts.currentPeriodEnd,
        // Preapproval ID precisa ser único por tenant (UNIQUE no schema), senão
        // múltiplos testes payment-origin colidem.
        mpPreapprovalId: opts.currentPeriodEnd ? `mp_${tenantId}` : null,
      },
    });
  }

  describe('cenário trial-origin (currentPeriodEnd null)', () => {
    it('POST /admin/services em past_due retorna 402 SUBSCRIPTION_PAST_DUE', async () => {
      const { accessToken, tenantId } = await registerAndLogin('past-trial-1');
      const prisma = app.get(PrismaService);
      await forcePastDue(prisma, tenantId, { currentPeriodEnd: null });

      const server = app.getHttpServer() as unknown as import('http').Server;
      const res = await request(server)
        .post('/admin/services')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'Corte', durationMin: 30, priceCents: 5000 })
        .expect(402);
      expect((res.body as { code: string }).code).toBe('SUBSCRIPTION_PAST_DUE');
    });

    it('GET /admin/services em past_due retorna 200', async () => {
      const { accessToken, tenantId } = await registerAndLogin('past-trial-2');
      const prisma = app.get(PrismaService);
      await forcePastDue(prisma, tenantId, { currentPeriodEnd: null });

      const server = app.getHttpServer() as unknown as import('http').Server;
      await request(server)
        .get('/admin/services')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
    });

    it('GET /admin/billing/status retorna origin=trial', async () => {
      const { accessToken, tenantId } = await registerAndLogin('past-trial-3');
      const prisma = app.get(PrismaService);
      await forcePastDue(prisma, tenantId, { currentPeriodEnd: null });

      const server = app.getHttpServer() as unknown as import('http').Server;
      const res = await request(server)
        .get('/admin/billing/status')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      const body = res.body as {
        origin: string | null;
        status: string;
        deadlineAt: string | null;
      };
      expect(body.origin).toBe('trial');
      expect(body.status).toBe('past_due');
      expect(body.deadlineAt).toBeDefined();
    });

    it('GET /public/{slug} em past_due retorna 404', async () => {
      const { tenantId } = await registerAndLogin('past-trial-4');
      const prisma = app.get(PrismaService);
      await forcePastDue(prisma, tenantId, { currentPeriodEnd: null });

      const server = app.getHttpServer() as unknown as import('http').Server;
      await request(server).get('/public/past-trial-4/services').expect(404);
    });
  });

  describe('cenário payment-origin (currentPeriodEnd não-null)', () => {
    it('POST /admin/services em past_due (payment-origin) retorna 402 — mesma resposta', async () => {
      const { accessToken, tenantId } = await registerAndLogin('past-payment-1');
      const prisma = app.get(PrismaService);
      await forcePastDue(prisma, tenantId, {
        currentPeriodEnd: new Date('2026-05-10T12:00:00Z'),
      });

      const server = app.getHttpServer() as unknown as import('http').Server;
      const res = await request(server)
        .post('/admin/services')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'Corte', durationMin: 30, priceCents: 5000 })
        .expect(402);
      expect((res.body as { code: string }).code).toBe('SUBSCRIPTION_PAST_DUE');
    });

    it('GET /admin/billing/status retorna origin=payment', async () => {
      const { accessToken, tenantId } = await registerAndLogin('past-payment-2');
      const prisma = app.get(PrismaService);
      await forcePastDue(prisma, tenantId, {
        currentPeriodEnd: new Date('2026-05-10T12:00:00Z'),
      });

      const server = app.getHttpServer() as unknown as import('http').Server;
      const res = await request(server)
        .get('/admin/billing/status')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      const body = res.body as { origin: string; hasCheckout: boolean };
      expect(body.origin).toBe('payment');
      expect(body.hasCheckout).toBe(true);
    });

    it('POST /admin/billing/checkout em past_due (qualquer origem) libera (whitelist)', async () => {
      const { accessToken, tenantId } = await registerAndLogin('past-payment-3');
      const prisma = app.get(PrismaService);
      await prisma.tenant.update({
        where: { id: tenantId },
        data: { documentNumber: '12345678901' },
      });
      await forcePastDue(prisma, tenantId, {
        currentPeriodEnd: new Date('2026-05-10T12:00:00Z'),
      });

      const server = app.getHttpServer() as unknown as import('http').Server;
      const res = await request(server)
        .post('/admin/billing/checkout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({});
      expect([200, 201]).toContain(res.status);
      expect((res.body as { initPoint: string }).initPoint).toBeDefined();
    });
  });

  describe('estados não-bloqueantes', () => {
    it('POST /admin/services em trialing retorna 201', async () => {
      const { accessToken } = await registerAndLogin('trial-write-ok');
      const server = app.getHttpServer() as unknown as import('http').Server;
      await request(server)
        .post('/admin/services')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'Corte trial', durationMin: 30, priceCents: 5000 })
        .expect(201);
    });
  });
});
