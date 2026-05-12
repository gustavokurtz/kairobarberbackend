import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import { createSaasOwner, createTenantOwner } from '../support/saas';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AuditActions } from 'src/common/audit/audit-actions';

describe('SaaS admin — dashboard (e2e)', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    setTestEnv();
    container = await startTestPostgres();
    app = await buildTestApp();
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('retorna MRR/ARR baseados em subscriptions active e métricas a partir do AuditLog', async () => {
    const saas = await createSaasOwner(app, { email: 'saas-dash@test.io' });
    const t1 = await createTenantOwner(app, 'dash1', 'd1@bar.test');
    await createTenantOwner(app, 'dash2', 'd2@bar.test');

    const prisma = app.get(PrismaService);
    await prisma.subscription.update({
      where: { tenantId: t1.tenantId },
      data: { status: 'active', currentPeriodEnd: new Date('2026-06-12') },
    });
    await prisma.auditLog.create({
      data: {
        action: AuditActions.SUBSCRIPTION_ACTIVATED,
        tenantId: t1.tenantId,
        targetType: 'subscription',
      },
    });

    const dash = await request(app.getHttpServer())
      .get('/saas/dashboard')
      .set('Authorization', `Bearer ${saas.accessToken}`)
      .expect(200);
    const body = dash.body as {
      mrrCents: number;
      arrCents: number;
      tenantsActive: number;
      activatedLast30d: number;
      trialsStartedLast60d: number;
      churn30d: number;
      trialConversion30d: number;
    };
    expect(body.mrrCents).toBe(4990);
    expect(body.arrCents).toBe(4990 * 12);
    expect(body.tenantsActive).toBe(2);
    expect(body.activatedLast30d).toBe(1);
    expect(body.trialsStartedLast60d).toBeGreaterThanOrEqual(2);
    expect(body.churn30d).toBe(0);
    expect(body.trialConversion30d).toBeGreaterThan(0);
  });
});
