import { Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { AiConsultationStatus, Prisma } from '@prisma/client';
import { AuditService } from 'src/common/audit/audit.service';
import { AuditActions } from 'src/common/audit/audit-actions';
import {
  JOB_AI_ANALYSIS,
  JOB_AI_CLEANUP,
  JOB_AI_GENERATION,
  JOB_AI_QUOTA_RESET,
  QUEUE_AI_VISAGISM,
} from 'src/infra/queues/queue-names';
import { STORAGE_PROVIDER } from 'src/modules/storage/storage.provider';
import type { StorageProvider } from 'src/modules/storage/storage.provider';
import { AiConsultationRepository } from './repositories/ai-consultation.repository';
import { QuotaService } from './quota/quota.service';
import type { VisagismProvider } from './providers/visagism.provider';
import { VISAGISM_PROVIDER, AI_VISAGISM_CLEANUP_BATCH_SIZE } from './ai-visagism.constants';
import { VisagismAnalysis } from './ai-visagism.types';

interface AnalysisJobData {
  consultationId: string;
  tenantId: string;
}

interface GenerationJobData {
  consultationId: string;
  tenantId: string;
  suggestionId: string;
}

@Processor(QUEUE_AI_VISAGISM)
export class AiVisagismProcessor extends WorkerHost {
  constructor(
    private readonly repo: AiConsultationRepository,
    private readonly quota: QuotaService,
    private readonly audit: AuditService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(VISAGISM_PROVIDER) private readonly provider: VisagismProvider,
    cfg: ConfigService,
    private readonly logger: Logger,
  ) {
    super();
    // cfg is reserved for future config-reads (e.g., dynamic batch size).
    void cfg;
  }

  async process(job: Job): Promise<unknown> {
    this.logger.log({ event: 'ai_visagism.job_started', name: job.name, id: job.id });

    switch (job.name) {
      case JOB_AI_ANALYSIS:
        return this.runAnalysis(job.data as AnalysisJobData, job);
      case JOB_AI_GENERATION:
        return this.runGeneration(job.data as GenerationJobData, job);
      case JOB_AI_CLEANUP:
        return this.runCleanup();
      case JOB_AI_QUOTA_RESET:
        return this.runQuotaReset();
      default:
        throw new Error(`unknown job: ${job.name}`);
    }
  }

  private async runAnalysis(data: AnalysisJobData, job: Job): Promise<{ ok: true }> {
    const consultation = await this.repo.findById(data.consultationId);
    if (!consultation) {
      this.logger.warn({
        event: 'ai_visagism.analysis_consultation_missing',
        id: data.consultationId,
      });
      return { ok: true };
    }
    if (consultation.expiredAt || !consultation.inputPhotoR2Key) {
      this.logger.warn({ event: 'ai_visagism.analysis_skipped_expired', id: consultation.id });
      return { ok: true };
    }
    if (consultation.status !== AiConsultationStatus.queued) {
      this.logger.warn({
        event: 'ai_visagism.analysis_unexpected_status',
        id: consultation.id,
        status: consultation.status,
      });
      return { ok: true };
    }

    try {
      await this.repo.setProcessing(consultation.id);
      const buffer = await this.storage.download(consultation.inputPhotoR2Key);
      const mime = this.guessMimeFromKey(consultation.inputPhotoR2Key);
      const result = await this.provider.analyze({ photoBuffer: buffer, mimeType: mime });

      await this.repo.setCompleted({
        id: consultation.id,
        analysisJson: result.analysis as unknown as Prisma.InputJsonValue,
        costCentsToAdd: result.costCents,
      });
      await this.audit.record({
        action: AuditActions.AI_ANALYSIS_COMPLETED,
        tenantId: consultation.tenantId,
        targetType: 'ai_consultation',
        targetId: consultation.id,
        diff: { costCents: result.costCents, providerMeta: result.providerMeta },
      });
      return { ok: true };
    } catch (err) {
      const attemptsLeft = (job.opts.attempts ?? 1) - (job.attemptsMade + 1);
      if (attemptsLeft > 0) {
        throw err;
      }
      await this.repo.setFailed({
        id: consultation.id,
        errorReason: (err as Error).message.slice(0, 500),
      });
      await this.quota.refund(consultation.tenantId);
      await this.audit.record({
        action: AuditActions.AI_CONSULTATION_FAILED,
        tenantId: consultation.tenantId,
        targetType: 'ai_consultation',
        targetId: consultation.id,
        diff: { stage: 'analysis', error: (err as Error).message },
      });
      return { ok: true };
    }
  }

  private async runGeneration(data: GenerationJobData, job: Job): Promise<{ ok: true }> {
    const consultation = await this.repo.findById(data.consultationId);
    if (!consultation || consultation.expiredAt || !consultation.inputPhotoR2Key) {
      return { ok: true };
    }
    const analysis = consultation.analysisJson as unknown as VisagismAnalysis | null;
    const suggestion = analysis?.suggestions.find((s) => s.id === data.suggestionId);
    if (!suggestion) {
      await this.repo.setFailed({ id: consultation.id, errorReason: 'suggestion_not_found' });
      return { ok: true };
    }

    try {
      const buffer = await this.storage.download(consultation.inputPhotoR2Key);
      const mime = this.guessMimeFromKey(consultation.inputPhotoR2Key);
      const result = await this.provider.generateImage({
        photoBuffer: buffer,
        mimeType: mime,
        suggestion,
      });
      const ext = result.imageMimeType.split('/')[1];
      const uploaded = await this.storage.uploadBuffer({
        tenantId: consultation.tenantId,
        buffer: result.imageBuffer,
        contentType: result.imageMimeType,
        extension: ext,
        prefix: 'ai-visagism/output',
      });
      await this.repo.setGenerated({
        id: consultation.id,
        outputPhotoR2Key: uploaded.r2Key,
        costCentsToAdd: result.costCents,
      });
      await this.audit.record({
        action: AuditActions.AI_GENERATION_COMPLETED,
        tenantId: consultation.tenantId,
        targetType: 'ai_consultation',
        targetId: consultation.id,
        diff: {
          costCents: result.costCents,
          suggestionId: suggestion.id,
          providerMeta: result.providerMeta,
        },
      });
      return { ok: true };
    } catch (err) {
      const attemptsLeft = (job.opts.attempts ?? 1) - (job.attemptsMade + 1);
      if (attemptsLeft > 0) throw err;
      await this.repo.setFailed({
        id: consultation.id,
        errorReason: (err as Error).message.slice(0, 500),
      });
      await this.audit.record({
        action: AuditActions.AI_CONSULTATION_FAILED,
        tenantId: consultation.tenantId,
        targetType: 'ai_consultation',
        targetId: consultation.id,
        diff: { stage: 'generation', error: (err as Error).message },
      });
      return { ok: true };
    }
  }

  private async runCleanup(): Promise<{ processed: number }> {
    const now = new Date();
    const due = await this.repo.findDueForCleanup(now, AI_VISAGISM_CLEANUP_BATCH_SIZE);
    let processed = 0;
    for (const row of due) {
      const { updated, previousInputKey, previousOutputKey } = await this.repo.markExpiredIfDue(
        row.id,
      );
      if (!updated) continue;
      if (previousInputKey) await this.storage.delete(previousInputKey);
      if (previousOutputKey) await this.storage.delete(previousOutputKey);
      await this.audit.record({
        action: AuditActions.AI_CONSULTATION_EXPIRED,
        tenantId: row.tenantId,
        targetType: 'ai_consultation',
        targetId: row.id,
        diff: { reason: 'retention_policy' },
      });
      processed++;
    }
    this.logger.log({ event: 'ai_visagism.cleanup_done', processed, found: due.length });
    return { processed };
  }

  private async runQuotaReset(): Promise<{ resetCount: number }> {
    const resetCount = await this.quota.resetAll();
    return { resetCount };
  }

  private guessMimeFromKey(key: string): string {
    if (key.endsWith('.jpg') || key.endsWith('.jpeg')) return 'image/jpeg';
    if (key.endsWith('.png')) return 'image/png';
    if (key.endsWith('.webp')) return 'image/webp';
    return 'application/octet-stream';
  }
}
