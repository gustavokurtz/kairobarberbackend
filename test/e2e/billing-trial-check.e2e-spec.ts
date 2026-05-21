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
  resetBillingClock,
  runBillingJobsNow,
  setBillingClock,
  startTestRedis,
} from '../support/billing';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { BillingService } from 'src/modules/billing/billing.service';

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

  it('trial expirado → past_due e past_due > 1d → cancelled', async () => {
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
      data: { updatedAt: new Date(clockMs - 2 * 24 * 60 * 60 * 1000) },
    });

    await runBillingJobsNow(app);

    const afterGrace = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(afterGrace.status).toBe('cancelled');
    expect(afterGrace.nextSyncAt).toBeNull();
  });

  // Regression: payment-origin past_due (mpPreapprovalId não-null) entra no
  // findDueForSync → runBillingSync chama applyRemoteState → repo.update toca
  // lastSyncedAt/nextSyncAt. Antes do fix, esses updates bumpavam `updatedAt`
  // (campo @updatedAt), fazendo a janela de grace nunca expirar (sync 1x/hora
  // sempre "renovava" o relógio). Esse teste prova que sync runs preservam
  // updatedAt em transições no-op (past_due → past_due).
  it('runBillingSync em past_due payment-origin preserva updatedAt (status no-op)', async () => {
    const server = app.getHttpServer() as unknown as import('http').Server;
    const prisma: PrismaService = app.get(PrismaService);
    const billing = app.get(BillingService);

    await request(server)
      .post('/auth/register/owner')
      .send({
        email: 'pay@bill.test',
        password: 'StrongPass!1',
        name: 'Pay Owner',
        tenantName: 'Pay Barber',
        slug: 'pay-x',
      })
      .expect(201);

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: 'pay-x' } });

    const provider = getConsoleBillingProvider(app);
    const created = await provider.createPreapproval({
      tenantId: tenant.id,
      tenantSlug: 'pay-x',
      payerEmail: 'pay@bill.test',
      payerName: 'Pay',
      reason: 'test',
      amountCents: 4990,
      frequency: 'months',
    });
    // Remote 'paused' → mapea pra past_due no sync. Status já past_due localmente,
    // logo transição é no-op e updatedAt deve ser preservado.
    provider.__test_advance(created.preapprovalId, 'paused', null);

    // Marca past_due 12h atrás (dentro da janela de 1d — grace ainda válido,
    // trial-check não vai cancelar). nextSyncAt no passado pra forçar pickup.
    const pastDueAt = new Date(Date.now() - 12 * 60 * 60 * 1000);
    await prisma.subscription.update({
      where: { tenantId: tenant.id },
      data: {
        status: 'past_due',
        currentPeriodEnd: new Date('2026-05-01'),
        mpPreapprovalId: created.preapprovalId,
        nextSyncAt: new Date(Date.now() - 60_000),
        updatedAt: pastDueAt,
      },
    });

    // Roda APENAS o sync (sem trial-check) 3 vezes — simula 3 horas de cron.
    // Cada chamada faz repo.update tocando lastSyncedAt/nextSyncAt mas, com o
    // fix, NÃO toca em updatedAt porque o status mapped é igual ao local.
    for (let i = 0; i < 3; i++) {
      // Re-arma nextSyncAt no passado pra que cada loop pegue a row de novo
      // (computeNextSyncAt empurra pra 2h adiante por padrão em past_due).
      // Passa updatedAt explícito pra evitar que o @updatedAt do Prisma
      // contamine nosso próprio teste.
      await prisma.subscription.update({
        where: { tenantId: tenant.id },
        data: {
          nextSyncAt: new Date(Date.now() - 60_000),
          updatedAt: pastDueAt,
        },
      });
      await billing.runBillingSync();
    }

    const afterSyncs = await prisma.subscription.findUniqueOrThrow({
      where: { tenantId: tenant.id },
    });
    expect(afterSyncs.status).toBe('past_due');
    // updatedAt deve continuar = pastDueAt original (sem drift do sync).
    // Tolerância de 2s pra absorver round-trip do Postgres/Prisma.
    expect(afterSyncs.updatedAt.getTime()).toBeLessThanOrEqual(pastDueAt.getTime() + 2000);

    // Agora avança updatedAt pra fora da janela e prova que trial-check cancela.
    // (Sem o fix, isso nunca aconteceria porque os syncs já teriam re-bumpado.)
    await prisma.subscription.update({
      where: { tenantId: tenant.id },
      data: { updatedAt: new Date(Date.now() - 30 * 60 * 60 * 1000) },
    });
    await billing.runTrialCheck();

    const finalSub = await prisma.subscription.findUniqueOrThrow({
      where: { tenantId: tenant.id },
    });
    expect(finalSub.status).toBe('cancelled');
  });
});
