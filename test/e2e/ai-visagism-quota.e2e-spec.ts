import request from 'supertest';
import { HttpStatus, INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { createTenantOwner } from '../support/saas';
import { startTestRedis, flushTestRedis, StartedRedis } from '../support/billing';
import {
  freshConsentAt,
  loadPhotoBuffer,
  runQuotaResetJob,
  setQuotaUsage,
} from '../support/ai-visagism';

describe('AI Visagism — cota mensal (e2e)', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let redis: StartedRedis;
  let prisma: PrismaService;

  beforeAll(async () => {
    setTestEnv();
    process.env.STORAGE_PROVIDER = 'console';
    process.env.THROTTLE_LIMIT = '1000';
    process.env.AI_VISAGISM_PROVIDER = 'console';
    container = await startTestPostgres();
    redis = await startTestRedis();
    app = await buildTestApp();
    prisma = app.get(PrismaService);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await flushTestRedis(redis.url);
    await redis.container.stop();
    await container.stop();
  });

  beforeEach(async () => {
    await prisma.aiConsultation.deleteMany({});
  });

  it('429 AI_QUOTA_EXCEEDED quando aiQuotaUsedThisMonth >= limite (trialing → 10)', async () => {
    const server = app.getHttpServer() as Express.Application;
    const { tenantId } = await createTenantOwner(app, 'quota-shop', 'quota-test@kairo.test');
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new Error('tenant');
    // Tenant novo é trialing — limite efetivo é 10. Setar uso em 10 já estoura.
    await setQuotaUsage(prisma, tenantId, 10);

    const res = await request(server)
      .post(`/public/${tenant.slug}/ai/visagism/consultations`)
      .field('consentAcceptedAt', freshConsentAt())
      .attach('photo', loadPhotoBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect((res.body as { code: string }).code).toBe('AI_QUOTA_EXCEEDED');
    expect((res.body as { details: { limit: number } }).details.limit).toBe(10);
  });

  it('runQuotaResetJob zera aiQuotaUsedThisMonth para todos tenants', async () => {
    const { tenantId: t1 } = await createTenantOwner(app, 'reset-shop-1', 'reset-1@kairo.test');
    const { tenantId: t2 } = await createTenantOwner(app, 'reset-shop-2', 'reset-2@kairo.test');
    await setQuotaUsage(prisma, t1, 47);
    await setQuotaUsage(prisma, t2, 100);

    await runQuotaResetJob(app);

    const s1 = await prisma.subscription.findUnique({ where: { tenantId: t1 } });
    const s2 = await prisma.subscription.findUnique({ where: { tenantId: t2 } });
    expect(s1?.aiQuotaUsedThisMonth).toBe(0);
    expect(s2?.aiQuotaUsedThisMonth).toBe(0);
  });
});
