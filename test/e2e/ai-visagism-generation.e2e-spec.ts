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
  runAnalysisJob,
  runGenerationJob,
  findConsultation,
} from '../support/ai-visagism';
import { AiConsultationStatus } from '@prisma/client';
import { AiVisagismService } from 'src/modules/ai-visagism/ai-visagism.service';

describe('AI Visagism — geração de imagem (e2e)', () => {
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

  it('happy path: pede geração com suggestionId válido → status=generated + imageUrl assinada', async () => {
    const server = app.getHttpServer() as Express.Application;
    const { tenantId } = await createTenantOwner(app, 'gen-happy-shop', 'gen-happy@kairo.test');
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new Error('tenant');
    const create = await request(server)
      .post(`/public/${tenant.slug}/ai/visagism/consultations`)
      .field('consentAcceptedAt', freshConsentAt())
      .attach('photo', loadPhotoBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' });
    expect(create.status).toBe(HttpStatus.CREATED);
    const { id, viewToken } = create.body as { id: string; viewToken: string };
    await runAnalysisJob(app, id, tenantId);

    const completed = await findConsultation(prisma, id);
    const firstSuggestionId = (completed?.analysisJson as { suggestions: { id: string }[] })
      .suggestions[0].id;

    const genRes = await request(server)
      .post(`/public/ai/visagism/consultations/${id}/generate-image`)
      .query({ token: viewToken })
      .send({ suggestionId: firstSuggestionId });
    expect(genRes.status).toBe(HttpStatus.CREATED);
    expect((genRes.body as { status: string }).status).toBe(AiConsultationStatus.generating);

    await runGenerationJob(app, id, tenantId, firstSuggestionId);

    const finalRow = await findConsultation(prisma, id);
    expect(finalRow?.status).toBe(AiConsultationStatus.generated);
    expect(finalRow?.outputPhotoR2Key).not.toBeNull();

    const imgRes = await request(server)
      .get(`/public/ai/visagism/consultations/${id}/image`)
      .query({ token: viewToken });
    expect(imgRes.status).toBe(HttpStatus.OK);
    expect((imgRes.body as { url: string }).url).toMatch(/storage\.local\/get\/.+/);
    expect((imgRes.body as { expiresInSeconds: number }).expiresInSeconds).toBe(300);
  });

  it('409 AI_CONSULTATION_NOT_READY se análise ainda não completou', async () => {
    const server = app.getHttpServer() as Express.Application;
    const { tenantId } = await createTenantOwner(
      app,
      'gen-not-ready-shop',
      'gen-not-ready@kairo.test',
    );
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new Error('tenant');
    const create = await request(server)
      .post(`/public/${tenant.slug}/ai/visagism/consultations`)
      .field('consentAcceptedAt', freshConsentAt())
      .attach('photo', loadPhotoBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' });
    const { id, viewToken } = create.body as { id: string; viewToken: string };
    // não roda analysisJob

    const res = await request(server)
      .post(`/public/ai/visagism/consultations/${id}/generate-image`)
      .query({ token: viewToken })
      .send({ suggestionId: 'any-id' });
    expect(res.status).toBe(HttpStatus.CONFLICT);
    expect((res.body as { code: string }).code).toBe('AI_CONSULTATION_NOT_READY');
  });

  it('404 AI_SUGGESTION_NOT_FOUND se suggestionId não bate', async () => {
    const server = app.getHttpServer() as Express.Application;
    const { tenantId } = await createTenantOwner(app, 'gen-bad-sug-shop', 'gen-bad-sug@kairo.test');
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new Error('tenant');
    const create = await request(server)
      .post(`/public/${tenant.slug}/ai/visagism/consultations`)
      .field('consentAcceptedAt', freshConsentAt())
      .attach('photo', loadPhotoBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' });
    const { id, viewToken } = create.body as { id: string; viewToken: string };
    await runAnalysisJob(app, id, tenantId);
    const res = await request(server)
      .post(`/public/ai/visagism/consultations/${id}/generate-image`)
      .query({ token: viewToken })
      .send({ suggestionId: 'inexistente-xyz' });
    expect(res.status).toBe(HttpStatus.NOT_FOUND);
    expect((res.body as { code: string }).code).toBe('AI_SUGGESTION_NOT_FOUND');
  });

  it('409 AI_GENERATION_ALREADY_REQUESTED na segunda chamada', async () => {
    const { tenantId } = await createTenantOwner(app, 'gen-dup-shop', 'gen-dup@kairo.test');
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new Error('tenant');

    // Este teste valida o erro AI_GENERATION_ALREADY_REQUESTED na regra de negócio
    // (não a camada HTTP). Usamos o service direto para evitar o throttler
    // 3/min/IP do POST /consultations e do POST /generate-image, que é
    // compartilhado entre os 4 testes deste describe.
    const service = app.get(AiVisagismService);
    const created = await service.create({
      tenantId,
      customerId: null,
      barberId: null,
      photoBuffer: loadPhotoBuffer(),
      photoMimeType: 'image/jpeg',
      consentAcceptedAt: new Date(),
      requestNow: new Date(),
    });
    const id = created.id;
    const viewToken = created.viewToken;

    await runAnalysisJob(app, id, tenantId);
    const completed = await findConsultation(prisma, id);
    const sid = (completed?.analysisJson as { suggestions: { id: string }[] }).suggestions[0].id;

    await service.requestImageGeneration({
      consultationId: id,
      plainToken: viewToken,
      suggestionId: sid,
    });
    await runGenerationJob(app, id, tenantId, sid);

    // Segunda chamada deve rejeitar com AI_GENERATION_ALREADY_REQUESTED + status 409.
    await expect(
      service.requestImageGeneration({
        consultationId: id,
        plainToken: viewToken,
        suggestionId: sid,
      }),
    ).rejects.toMatchObject({
      opts: { code: 'AI_GENERATION_ALREADY_REQUESTED', status: HttpStatus.CONFLICT },
    });
  });
});
