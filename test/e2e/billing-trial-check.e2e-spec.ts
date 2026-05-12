import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import {
  StartedRedis,
  flushTestRedis,
  resetBillingClock,
  runBillingJobsNow,
  setBillingClock,
  startTestRedis,
} from '../support/billing';
import { PrismaService } from 'src/infra/prisma/prisma.service';

describe('Billing — trial-check (e2e)', () => {
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
    resetBillingClock();
    await app.close();
    await flushTestRedis(redis.url);
    await redis.container.stop();
    await container.stop();
  });

  afterEach(() => resetBillingClock());

  it('trial expirado → past_due e past_due > 7d → cancelled', async () => {
    const server = app.getHttpServer() as unknown as import('http').Server;
    const prisma: PrismaService = app.get(PrismaService);

    await request(server)
      .post('/auth/register/owner')
      .send({
        email: 'trial@bill.test',
        password: 'StrongPass!1',
        name: 'Trial Owner',
        tenantName: 'Trial Barber',
        slug: 'trial-x',
      })
      .expect(201);

    const sub = await prisma.subscription.findFirstOrThrow({
      where: { tenant: { slug: 'trial-x' } },
    });
    expect(sub.status).toBe('trialing');

    setBillingClock(new Date(Date.now() + 15 * 24 * 60 * 60 * 1000));
    await runBillingJobsNow(app);

    const afterTrial = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(afterTrial.status).toBe('past_due');

    const clockMs = Number(process.env.BILLING_NOW_OVERRIDE_MS);
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { updatedAt: new Date(clockMs - 8 * 24 * 60 * 60 * 1000) },
    });

    await runBillingJobsNow(app);

    const afterGrace = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(afterGrace.status).toBe('cancelled');
    expect(afterGrace.nextSyncAt).toBeNull();
  });
});
