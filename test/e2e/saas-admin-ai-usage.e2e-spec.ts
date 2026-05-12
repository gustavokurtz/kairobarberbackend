import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import { createSaasOwner, createTenantOwner } from '../support/saas';
import { PrismaService } from 'src/infra/prisma/prisma.service';

describe('SaaS admin — ai-usage (e2e)', () => {
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

  it('lista tenants com quota > 0 ordenados desc', async () => {
    const saas = await createSaasOwner(app, { email: 'saas-ai@test.io' });
    const a = await createTenantOwner(app, 'aiusage-a', 'a@ai.test');
    const b = await createTenantOwner(app, 'aiusage-b', 'b@ai.test');
    const prisma = app.get(PrismaService);
    await prisma.subscription.update({
      where: { tenantId: a.tenantId },
      data: { aiQuotaUsedThisMonth: 5 },
    });
    await prisma.subscription.update({
      where: { tenantId: b.tenantId },
      data: { aiQuotaUsedThisMonth: 20 },
    });

    const res = await request(app.getHttpServer())
      .get('/saas/ai-usage')
      .set('Authorization', `Bearer ${saas.accessToken}`)
      .expect(200);
    const body = res.body as {
      windowMonth: string;
      total: number;
      data: Array<{ tenantSlug: string; aiQuotaUsedThisMonth: number }>;
    };
    expect(body.windowMonth).toMatch(/^\d{4}-\d{2}$/);
    expect(body.total).toBe(2);
    expect(body.data[0].tenantSlug).toBe('aiusage-b');
    expect(body.data[0].aiQuotaUsedThisMonth).toBe(20);
    expect(body.data[1].tenantSlug).toBe('aiusage-a');
  });
});
