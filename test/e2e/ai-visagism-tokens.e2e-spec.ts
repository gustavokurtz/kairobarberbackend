import request from 'supertest';
import { HttpStatus, INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { createTenantOwner } from '../support/saas';
import { startTestRedis, flushTestRedis, StartedRedis } from '../support/billing';
import { freshConsentAt, loadPhotoBuffer, runAnalysisJob } from '../support/ai-visagism';

describe('AI Visagism — tokens e tenancy (e2e)', () => {
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

  it('GET /image antes da geração retorna 409 AI_CONSULTATION_NOT_READY', async () => {
    const server = app.getHttpServer() as Express.Application;
    const { tenantId } = await createTenantOwner(
      app,
      'image-conflict-shop',
      'image-conflict@kairo.test',
    );
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new Error('tenant');
    const create = await request(server)
      .post(`/public/${tenant.slug}/ai/visagism/consultations`)
      .field('consentAcceptedAt', freshConsentAt())
      .attach('photo', loadPhotoBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' });
    const { id, viewToken } = create.body as { id: string; viewToken: string };
    await runAnalysisJob(app, id, tenantId);
    const res = await request(server)
      .get(`/public/ai/visagism/consultations/${id}/image`)
      .query({ token: viewToken });
    expect(res.status).toBe(HttpStatus.CONFLICT);
    expect((res.body as { code: string }).code).toBe('AI_CONSULTATION_NOT_READY');
  });

  it('viewToken serve apenas para a consulta dele (não cross-consultation)', async () => {
    const server = app.getHttpServer() as Express.Application;
    const { tenantId } = await createTenantOwner(app, 'cross-token-shop', 'cross-token@kairo.test');
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new Error('tenant');
    const a = await request(server)
      .post(`/public/${tenant.slug}/ai/visagism/consultations`)
      .field('consentAcceptedAt', freshConsentAt())
      .attach('photo', loadPhotoBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' });
    const b = await request(server)
      .post(`/public/${tenant.slug}/ai/visagism/consultations`)
      .field('consentAcceptedAt', freshConsentAt())
      .attach('photo', loadPhotoBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' });

    const swap = await request(server)
      .get(`/public/ai/visagism/consultations/${(a.body as { id: string }).id}`)
      .query({ token: (b.body as { viewToken: string }).viewToken });
    expect(swap.status).toBe(HttpStatus.NOT_FOUND);
  });
});
