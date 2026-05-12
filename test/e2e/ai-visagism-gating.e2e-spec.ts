import request from 'supertest';
import { HttpStatus, INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { createTenantOwner } from '../support/saas';
import { startTestRedis, flushTestRedis, StartedRedis } from '../support/billing';
import { freshConsentAt, loadPhotoBuffer } from '../support/ai-visagism';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('AI Visagism — gating (e2e)', () => {
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

  it('404 quando tenant suspended', async () => {
    const server = app.getHttpServer() as Express.Application;
    const { tenantId } = await createTenantOwner(
      app,
      'suspended-ai-shop',
      'suspended-ai@kairo.test',
    );
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new Error('tenant');
    await prisma.tenant.update({ where: { id: tenantId }, data: { suspendedAt: new Date() } });

    const res = await request(server)
      .post(`/public/${tenant.slug}/ai/visagism/consultations`)
      .field('consentAcceptedAt', freshConsentAt())
      .attach('photo', loadPhotoBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(HttpStatus.NOT_FOUND);
  });

  it('402 SUBSCRIPTION_INACTIVE quando subscription past_due', async () => {
    const server = app.getHttpServer() as Express.Application;
    const { tenantId } = await createTenantOwner(app, 'pastdue-ai-shop', 'pastdue-ai@kairo.test');
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new Error('tenant');
    await prisma.subscription.update({
      where: { tenantId },
      data: { status: 'past_due' },
    });
    const res = await request(server)
      .post(`/public/${tenant.slug}/ai/visagism/consultations`)
      .field('consentAcceptedAt', freshConsentAt())
      .attach('photo', loadPhotoBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(HttpStatus.PAYMENT_REQUIRED);
    expect((res.body as { code: string }).code).toBe('SUBSCRIPTION_INACTIVE');
  });

  it('400 AI_CONSENT_STALE quando consentAcceptedAt > 1h atrás', async () => {
    const server = app.getHttpServer() as Express.Application;
    const { tenantId } = await createTenantOwner(
      app,
      'stale-consent-shop',
      'stale-consent@kairo.test',
    );
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new Error('tenant');
    const oldConsent = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const res = await request(server)
      .post(`/public/${tenant.slug}/ai/visagism/consultations`)
      .field('consentAcceptedAt', oldConsent)
      .attach('photo', loadPhotoBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect((res.body as { code: string }).code).toBe('AI_CONSENT_STALE');
  });

  it('400 AI_PHOTO_INVALID quando MIME falsificado (jpeg declarado, png real)', async () => {
    const server = app.getHttpServer() as Express.Application;
    const { tenantId } = await createTenantOwner(app, 'fake-mime-shop', 'fake-mime@kairo.test');
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new Error('tenant');
    const png = readFileSync(join(process.cwd(), 'test/fixtures/photo-256.png'));
    const res = await request(server)
      .post(`/public/${tenant.slug}/ai/visagism/consultations`)
      .field('consentAcceptedAt', freshConsentAt())
      .attach('photo', png, { filename: 'fake.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect((res.body as { code: string }).code).toBe('AI_PHOTO_INVALID');
  });
});
