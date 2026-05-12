import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import { StartedRedis, flushTestRedis, startTestRedis } from '../support/billing';
import { PrismaService } from 'src/infra/prisma/prisma.service';

describe('Billing — gating admin + storefront (e2e)', () => {
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

  it('cancelled bloqueia /admin/services (402) mas libera /admin/billing/* e bloqueia storefront (404)', async () => {
    const server = app.getHttpServer();
    const prisma = app.get(PrismaService);

    const reg = await request(server)
      .post('/auth/register/owner')
      .send({
        email: 'gate@bill.test',
        password: 'StrongPass!1',
        name: 'Gate Owner',
        tenantName: 'Gate Barber',
        slug: 'gate-bill',
      })
      .expect(201);
    const token = (reg.body as { accessToken: string }).accessToken;

    await request(server)
      .post('/admin/services')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Corte', durationMin: 30, priceCents: 4500 })
      .expect(201);

    await request(server).get('/public/gate-bill/services').expect(200);

    await prisma.subscription.updateMany({
      where: { tenant: { slug: 'gate-bill' } },
      data: { status: 'cancelled', nextSyncAt: null },
    });

    await request(server)
      .get('/admin/services')
      .set('Authorization', `Bearer ${token}`)
      .expect(402)
      .expect(({ body }) => {
        expect((body as { code: string }).code).toBe('SUBSCRIPTION_INACTIVE');
      });

    await request(server)
      .get('/admin/billing/subscription')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect(({ body }) => {
        expect((body as { status: string }).status).toBe('cancelled');
      });

    // Storefront 404 enquanto cancelled (antes do re-checkout que reseta pra trialing)
    await request(server).get('/public/gate-bill/services').expect(404);

    // Checkout em cancelled cria preapproval novo e volta pra trialing (per plan Decision 4)
    await request(server)
      .post('/admin/billing/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(200);

    // Storefront volta a responder 200 depois do re-checkout
    await request(server).get('/public/gate-bill/services').expect(200);
  });

  it('past_due NÃO bloqueia admin nem storefront (gating só dispara em cancelled)', async () => {
    const server = app.getHttpServer();
    const prisma = app.get(PrismaService);

    const reg = await request(server)
      .post('/auth/register/owner')
      .send({
        email: 'pd@bill.test',
        password: 'StrongPass!1',
        name: 'PD Owner',
        tenantName: 'PD Barber',
        slug: 'pd-bill',
      })
      .expect(201);
    const token = (reg.body as { accessToken: string }).accessToken;

    await prisma.subscription.updateMany({
      where: { tenant: { slug: 'pd-bill' } },
      data: { status: 'past_due' },
    });

    await request(server)
      .get('/admin/services')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    await request(server).get('/public/pd-bill/services').expect(200);
  });
});
