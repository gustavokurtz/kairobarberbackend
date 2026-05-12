import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import {
  StartedRedis,
  flushTestRedis,
  getConsoleBillingProvider,
  startTestRedis,
} from '../support/billing';

describe('Billing — checkout → sync → active (e2e)', () => {
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

  it('barbeiro registra → checkout → sync simulado → status active + currentPeriodEnd', async () => {
    const server = app.getHttpServer() as unknown as import('http').Server;

    const reg = await request(server)
      .post('/auth/register/owner')
      .send({
        email: 'owner@bill.test',
        password: 'StrongPass!1',
        name: 'Owner',
        tenantName: 'BillBarber',
        slug: 'bill',
      })
      .expect(201);
    const token = (reg.body as { accessToken: string }).accessToken;

    // 1) Subscription começa trialing
    const sub0 = await request(server)
      .get('/admin/billing/subscription')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect((sub0.body as { status: string }).status).toBe('trialing');
    expect((sub0.body as { hasCheckout: boolean }).hasCheckout).toBe(false);

    // 2) Checkout cria preapproval no Console provider
    const checkout = await request(server)
      .post('/admin/billing/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(200);
    const initPoint = (checkout.body as { initPoint: string }).initPoint;
    expect(initPoint).toMatch(/^http/);
    const preapprovalId = new URL(initPoint).searchParams.get('preapproval_id');
    expect(preapprovalId).toBeTruthy();

    // 3) Simula MP aprovando o pagamento
    const provider = getConsoleBillingProvider(app);
    provider.__test_advance(preapprovalId!, 'authorized', new Date('2026-06-12T12:00:00Z'));

    // 4) Front chama /sync após retorno do checkout
    const synced = await request(server)
      .post('/admin/billing/sync')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect((synced.body as { status: string }).status).toBe('active');
    expect((synced.body as { currentPeriodEnd: string | null }).currentPeriodEnd).toBe(
      '2026-06-12T12:00:00.000Z',
    );

    // 5) Re-checkout em assinatura ativa → 409
    await request(server)
      .post('/admin/billing/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(409)
      .expect(({ body }) => {
        expect((body as { code: string }).code).toBe('SUBSCRIPTION_ALREADY_ACTIVE');
      });
  });
});
