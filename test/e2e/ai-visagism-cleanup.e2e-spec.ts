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
  expireConsultation,
  findConsultation,
  freshConsentAt,
  loadPhotoBuffer,
  runAnalysisJob,
  runCleanupJob,
} from '../support/ai-visagism';
import { AiConsultationStatus } from '@prisma/client';

describe('AI Visagism — cleanup LGPD (e2e)', () => {
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

  it('cleanup marca expiredAt, zera analysisJson, zera r2Keys, status=expired', async () => {
    const server = app.getHttpServer() as Express.Application;
    const { tenantId } = await createTenantOwner(app, 'cleanup-ai-shop', 'cleanup-ai@kairo.test');
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new Error('tenant');
    const create = await request(server)
      .post(`/public/${tenant.slug}/ai/visagism/consultations`)
      .field('consentAcceptedAt', freshConsentAt())
      .attach('photo', loadPhotoBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' });
    expect(create.status).toBe(HttpStatus.CREATED);
    const { id } = create.body as { id: string };
    await runAnalysisJob(app, id, tenantId);

    await expireConsultation(prisma, id);
    const before = await findConsultation(prisma, id);
    expect(before?.analysisJson).not.toBeNull();
    expect(before?.inputPhotoR2Key).not.toBeNull();

    const result = (await runCleanupJob(app)) as { processed: number };
    expect(result.processed).toBe(1);

    const after = await findConsultation(prisma, id);
    expect(after?.status).toBe(AiConsultationStatus.expired);
    expect(after?.expiredAt).not.toBeNull();
    expect(after?.analysisJson).toBeNull();
    expect(after?.inputPhotoR2Key).toBeNull();
    expect(after?.outputPhotoR2Key).toBeNull();
  });

  it('GET após cleanup retorna analysis=null (cliente não tem mais acesso aos dados)', async () => {
    const server = app.getHttpServer() as Express.Application;
    const { tenantId } = await createTenantOwner(
      app,
      'cleanup-view-shop',
      'cleanup-view@kairo.test',
    );
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new Error('tenant');
    const create = await request(server)
      .post(`/public/${tenant.slug}/ai/visagism/consultations`)
      .field('consentAcceptedAt', freshConsentAt())
      .attach('photo', loadPhotoBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' });
    const { id, viewToken } = create.body as { id: string; viewToken: string };
    await runAnalysisJob(app, id, tenantId);
    await expireConsultation(prisma, id);
    await runCleanupJob(app);

    const view = await request(server)
      .get(`/public/ai/visagism/consultations/${id}`)
      .query({ token: viewToken });
    expect(view.status).toBe(HttpStatus.OK);
    const body = view.body as {
      status: string;
      analysis: unknown;
      expiredAt: string | null;
    };
    expect(body.status).toBe(AiConsultationStatus.expired);
    expect(body.analysis).toBeNull();
    expect(body.expiredAt).not.toBeNull();
  });

  it('cleanup é idempotente — segunda run não reprocessa', async () => {
    const server = app.getHttpServer() as Express.Application;
    const { tenantId } = await createTenantOwner(
      app,
      'cleanup-idempotent-shop',
      'cleanup-idempotent@kairo.test',
    );
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new Error('tenant');
    const create = await request(server)
      .post(`/public/${tenant.slug}/ai/visagism/consultations`)
      .field('consentAcceptedAt', freshConsentAt())
      .attach('photo', loadPhotoBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' });
    const { id } = create.body as { id: string };
    await runAnalysisJob(app, id, tenantId);
    await expireConsultation(prisma, id);
    const first = (await runCleanupJob(app)) as { processed: number };
    const second = (await runCleanupJob(app)) as { processed: number };
    expect(first.processed).toBe(1);
    expect(second.processed).toBe(0);
  });
});
