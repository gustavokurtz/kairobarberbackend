import request from 'supertest';
import { HttpStatus, INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AiConsultationStatus } from '@prisma/client';
import { createTenantOwner } from '../support/saas';
import {
  loadPhotoBuffer,
  freshConsentAt,
  runAnalysisJob,
  findConsultation,
} from '../support/ai-visagism';
import { StartedRedis, startTestRedis, flushTestRedis } from '../support/billing';

describe('AI Visagism — happy path (e2e)', () => {
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
    await prisma.subscription.updateMany({ data: { aiQuotaUsedThisMonth: 0 } });
  });

  it('cria consulta, processa análise, polling retorna status=completed com analysisJson', async () => {
    const server = app.getHttpServer() as Express.Application;
    const { tenantId } = await createTenantOwner(app, 'visagism-shop', 'visagism-owner@kairo.test');
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new Error('tenant not found');

    const photo = loadPhotoBuffer();

    // POST cria consulta
    const createRes = await request(server)
      .post(`/public/${tenant.slug}/ai/visagism/consultations`)
      .field('consentAcceptedAt', freshConsentAt())
      .attach('photo', photo, { filename: 'photo.jpg', contentType: 'image/jpeg' });

    expect(createRes.status).toBe(HttpStatus.CREATED);
    expect(createRes.body).toMatchObject({
      id: expect.any(String),
      viewToken: expect.any(String),
      status: AiConsultationStatus.queued,
      quota: { used: 1, limit: 10 },
    });
    const { id, viewToken } = createRes.body as { id: string; viewToken: string };

    // Roda o worker inline
    await runAnalysisJob(app, id, tenantId);

    // Verifica row no banco
    const row = await findConsultation(prisma, id);
    expect(row?.status).toBe(AiConsultationStatus.completed);
    expect(row?.analysisJson).toMatchObject({
      faceShape: expect.any(String),
      suggestions: expect.any(Array),
    });

    // GET com token
    const getRes = await request(server)
      .get(`/public/ai/visagism/consultations/${id}`)
      .query({ token: viewToken });

    expect(getRes.status).toBe(HttpStatus.OK);
    expect(getRes.body).toMatchObject({
      id,
      status: AiConsultationStatus.completed,
      hasGeneratedImage: false,
    });
    expect(
      (getRes.body as { analysis: { suggestions: unknown[] } }).analysis.suggestions.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('GET sem token retorna 400', async () => {
    const server = app.getHttpServer() as Express.Application;
    const { tenantId } = await createTenantOwner(app, 'no-token-shop', 'no-token@kairo.test');
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new Error('tenant');
    const create = await request(server)
      .post(`/public/${tenant.slug}/ai/visagism/consultations`)
      .field('consentAcceptedAt', freshConsentAt())
      .attach('photo', loadPhotoBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' });
    expect(create.status).toBe(HttpStatus.CREATED);
    const id = (create.body as { id: string }).id;
    const res = await request(server).get(`/public/ai/visagism/consultations/${id}`);
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it('GET com token errado retorna 404', async () => {
    const server = app.getHttpServer() as Express.Application;
    const { tenantId } = await createTenantOwner(app, 'bad-token-shop', 'bad-token@kairo.test');
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new Error('tenant');
    const create = await request(server)
      .post(`/public/${tenant.slug}/ai/visagism/consultations`)
      .field('consentAcceptedAt', freshConsentAt())
      .attach('photo', loadPhotoBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' });
    const id = (create.body as { id: string }).id;
    const res = await request(server)
      .get(`/public/ai/visagism/consultations/${id}`)
      .query({ token: 'X'.repeat(43) });
    expect(res.status).toBe(HttpStatus.NOT_FOUND);
    expect((res.body as { code: string }).code).toBe('AI_CONSULTATION_NOT_FOUND');
  });
});
