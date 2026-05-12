import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import { createSaasOwner, createTenantOwner } from '../support/saas';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { createHash } from 'crypto';

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

  it('?detailed=true inclui recentConsultations por tenant', async () => {
    const saas = await createSaasOwner(app, { email: 'saas-ai-detailed@test.io' });
    const tenant = await createTenantOwner(app, 'aiusage-detailed', 'detailed@ai.test');
    const prisma = app.get(PrismaService);

    // Give the tenant some quota usage so it shows up in the snapshot
    await prisma.subscription.update({
      where: { tenantId: tenant.tenantId },
      data: { aiQuotaUsedThisMonth: 3 },
    });

    // Insert an AiConsultation row directly via Prisma
    const viewTokenHash = createHash('sha256').update('dummy-token-detailed').digest('hex');
    await prisma.aiConsultation.create({
      data: {
        tenantId: tenant.tenantId,
        viewTokenHash,
        consentAcceptedAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        inputPhotoR2Key: 'test/photo.jpg',
      },
    });

    const res = await request(app.getHttpServer())
      .get('/saas/ai-usage')
      .query({ detailed: 'true' })
      .set('Authorization', `Bearer ${saas.accessToken}`);

    expect(res.status).toBe(200);

    const body = res.body as {
      data: Array<{ tenantSlug: string; recentConsultations?: unknown[] }>;
    };

    const item = body.data.find((d) => d.tenantSlug === 'aiusage-detailed');
    expect(item).toBeDefined();
    expect(item).toHaveProperty('recentConsultations');
    expect(Array.isArray(item!.recentConsultations)).toBe(true);
    expect(item!.recentConsultations!.length).toBeGreaterThanOrEqual(1);

    const consultation = item!.recentConsultations![0] as {
      id: string;
      status: string;
      providerCostCents: number;
      createdAt: string;
      expiredAt: string | null;
    };
    expect(consultation).toHaveProperty('id');
    expect(consultation).toHaveProperty('status');
    expect(consultation).toHaveProperty('providerCostCents');
    expect(consultation).toHaveProperty('createdAt');
    expect(consultation).toHaveProperty('expiredAt');
    expect(consultation.expiredAt).toBeNull();
  });
});
