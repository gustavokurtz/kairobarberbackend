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
  runBillingJobsNow,
  startTestRedis,
} from '../support/billing';
import { PrismaService } from 'src/infra/prisma/prisma.service';

describe('Billing — cron billing-sync (e2e)', () => {
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

  it('cron sincroniza mudança remota authorized → paused → cancelled', async () => {
    const server = app.getHttpServer();
    const prisma = app.get(PrismaService);

    const reg = await request(server)
      .post('/auth/register/owner')
      .send({
        email: 'cron@bill.test',
        password: 'StrongPass!1',
        name: 'Cron Owner',
        tenantName: 'Cron Barber',
        slug: 'cron-bill',
      })
      .expect(201);
    const token = (reg.body as { accessToken: string }).accessToken;

    const checkout = await request(server)
      .post('/admin/billing/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(200);
    const preapprovalId = new URL(
      (checkout.body as { initPoint: string }).initPoint,
    ).searchParams.get('preapproval_id')!;

    await prisma.subscription.updateMany({
      where: { mpPreapprovalId: preapprovalId },
      data: { nextSyncAt: new Date('2026-01-01T00:00:00Z') },
    });

    const provider = getConsoleBillingProvider(app);

    provider.__test_advance(preapprovalId, 'authorized', new Date('2026-06-12T12:00:00Z'));
    await runBillingJobsNow(app);
    expect(
      (
        await prisma.subscription.findUniqueOrThrow({
          where: { mpPreapprovalId: preapprovalId },
        })
      ).status,
    ).toBe('active');

    await prisma.subscription.updateMany({
      where: { mpPreapprovalId: preapprovalId },
      data: { nextSyncAt: new Date('2026-01-01T00:00:00Z') },
    });

    provider.__test_advance(preapprovalId, 'paused', null);
    await runBillingJobsNow(app);
    expect(
      (
        await prisma.subscription.findUniqueOrThrow({
          where: { mpPreapprovalId: preapprovalId },
        })
      ).status,
    ).toBe('past_due');

    await prisma.subscription.updateMany({
      where: { mpPreapprovalId: preapprovalId },
      data: { nextSyncAt: new Date('2026-01-01T00:00:00Z') },
    });

    provider.__test_advance(preapprovalId, 'cancelled', null);
    await runBillingJobsNow(app);
    const final = await prisma.subscription.findUniqueOrThrow({
      where: { mpPreapprovalId: preapprovalId },
    });
    expect(final.status).toBe('cancelled');
    expect(final.nextSyncAt).toBeNull();
  });
});
