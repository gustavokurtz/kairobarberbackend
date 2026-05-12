import { INestApplication } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AiConsultationStatus } from '@prisma/client';
import { AiVisagismProcessor } from 'src/modules/ai-visagism/ai-visagism.processor';
import { Job } from 'bullmq';
import {
  JOB_AI_ANALYSIS,
  JOB_AI_CLEANUP,
  JOB_AI_GENERATION,
  JOB_AI_QUOTA_RESET,
} from 'src/infra/queues/queue-names';

export const PHOTO_FIXTURE_PATH = join(process.cwd(), 'test/fixtures/photo-256.jpg');

export function loadPhotoBuffer(): Buffer {
  return readFileSync(PHOTO_FIXTURE_PATH);
}

export function freshConsentAt(): string {
  return new Date().toISOString();
}

/** Executa o processor inline (sem BullMQ rodar). Usado em e2e pra simular o worker. */
export async function runAiJob(
  app: INestApplication,
  name: string,
  data: unknown,
  opts: { attemptsMade?: number; attempts?: number } = {},
): Promise<unknown> {
  const processor = app.get(AiVisagismProcessor);
  const fakeJob = {
    name,
    id: `inline-${Date.now()}`,
    data,
    attemptsMade: opts.attemptsMade ?? 0,
    opts: { attempts: opts.attempts ?? 3 },
  } as unknown as Job;
  return processor.process(fakeJob);
}

export async function runAnalysisJob(
  app: INestApplication,
  consultationId: string,
  tenantId: string,
) {
  return runAiJob(app, JOB_AI_ANALYSIS, { consultationId, tenantId });
}

export async function runGenerationJob(
  app: INestApplication,
  consultationId: string,
  tenantId: string,
  suggestionId: string,
) {
  return runAiJob(app, JOB_AI_GENERATION, { consultationId, tenantId, suggestionId });
}

export async function runCleanupJob(app: INestApplication) {
  return runAiJob(app, JOB_AI_CLEANUP, {});
}

export async function runQuotaResetJob(app: INestApplication) {
  return runAiJob(app, JOB_AI_QUOTA_RESET, {});
}

/** Conveniência: muda expiresAt manualmente pro passado pra simular retenção vencida. */
export async function expireConsultation(prisma: PrismaService, id: string) {
  await prisma.aiConsultation.update({
    where: { id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
}

export async function findConsultation(prisma: PrismaService, id: string) {
  return prisma.aiConsultation.findUnique({ where: { id } });
}

export async function setQuotaUsage(prisma: PrismaService, tenantId: string, used: number) {
  await prisma.subscription.update({
    where: { tenantId },
    data: { aiQuotaUsedThisMonth: used },
  });
}

export function expectStatus(c: { status: AiConsultationStatus }, expected: AiConsultationStatus) {
  if (c.status !== expected) {
    throw new Error(`expected status ${expected}, got ${c.status}`);
  }
}
