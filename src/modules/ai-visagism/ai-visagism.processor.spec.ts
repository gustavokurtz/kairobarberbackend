import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiConsultationStatus } from '@prisma/client';
import { AiVisagismProcessor } from './ai-visagism.processor';
import { AiConsultationRepository } from './repositories/ai-consultation.repository';
import { QuotaService } from './quota/quota.service';
import { AuditService } from 'src/common/audit/audit.service';
import { JOB_AI_ANALYSIS, JOB_AI_CLEANUP, JOB_AI_QUOTA_RESET } from 'src/infra/queues/queue-names';

function makeProcessor() {
  const repo = {
    findById: jest.fn(),
    setProcessing: jest.fn().mockResolvedValue({}),
    setCompleted: jest.fn().mockResolvedValue({}),
    setFailed: jest.fn().mockResolvedValue({}),
    findDueForCleanup: jest.fn().mockResolvedValue([]),
    markExpiredIfDue: jest.fn(),
    setGenerating: jest.fn().mockResolvedValue({}),
    setGenerated: jest.fn().mockResolvedValue({}),
  };
  const quota = { refund: jest.fn(), resetAll: jest.fn().mockResolvedValue(7) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const storage = {
    download: jest.fn().mockResolvedValue(Buffer.from('photo')),
    uploadBuffer: jest.fn(),
    delete: jest.fn(),
    presignGet: jest.fn(),
    presignUpload: jest.fn(),
  };
  const provider = {
    analyze: jest.fn(),
    generateImage: jest.fn(),
    healthCheck: jest.fn(),
  };
  const cfg = { getOrThrow: jest.fn() } as unknown as ConfigService;
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as Logger;

  const p = new AiVisagismProcessor(
    repo as unknown as AiConsultationRepository,
    quota as unknown as QuotaService,
    audit as unknown as AuditService,
    storage,
    provider,
    cfg,
    logger,
  );
  return { p, repo, quota, audit, storage, provider };
}

function makeJob(name: string, data: unknown, attemptsMade = 0, attempts = 3) {
  return {
    name,
    id: 'job-1',
    data,
    attemptsMade,
    opts: { attempts },
  } as never;
}

describe('AiVisagismProcessor', () => {
  it('analysis: happy path → setCompleted + audit AI_ANALYSIS_COMPLETED', async () => {
    const { p, repo, provider, audit } = makeProcessor();
    repo.findById.mockResolvedValueOnce({
      id: 'c1',
      tenantId: 't1',
      status: AiConsultationStatus.queued,
      inputPhotoR2Key: 'tenants/t1/ai-visagism/input/abc.jpg',
      expiredAt: null,
      analysisJson: null,
    });
    provider.analyze.mockResolvedValueOnce({
      analysis: { faceShape: 'oval', description: 'x', suggestions: [] },
      costCents: 1,
      providerMeta: { provider: 'groq' },
    });
    await p.process(makeJob(JOB_AI_ANALYSIS, { consultationId: 'c1', tenantId: 't1' }));
    expect(repo.setProcessing).toHaveBeenCalledWith('c1');
    expect(repo.setCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1', costCentsToAdd: 1 }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ai.analysis_completed', tenantId: 't1' }),
    );
  });

  it('analysis: erro com retries restantes → relança (BullMQ retenta)', async () => {
    const { p, repo, provider } = makeProcessor();
    repo.findById.mockResolvedValueOnce({
      id: 'c1',
      tenantId: 't1',
      status: AiConsultationStatus.queued,
      inputPhotoR2Key: 'tenants/t1/ai-visagism/input/abc.jpg',
      expiredAt: null,
    });
    provider.analyze.mockRejectedValueOnce(new Error('groq 500'));
    await expect(
      p.process(makeJob(JOB_AI_ANALYSIS, { consultationId: 'c1', tenantId: 't1' }, 0, 3)),
    ).rejects.toThrow('groq 500');
    expect(repo.setFailed).not.toHaveBeenCalled();
  });

  it('analysis: erro na última tentativa → setFailed + refund + audit', async () => {
    const { p, repo, provider, quota, audit } = makeProcessor();
    repo.findById.mockResolvedValueOnce({
      id: 'c1',
      tenantId: 't1',
      status: AiConsultationStatus.queued,
      inputPhotoR2Key: 'tenants/t1/ai-visagism/input/abc.jpg',
      expiredAt: null,
    });
    provider.analyze.mockRejectedValueOnce(new Error('groq 500'));
    await p.process(makeJob(JOB_AI_ANALYSIS, { consultationId: 'c1', tenantId: 't1' }, 2, 3));
    expect(repo.setFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1', errorReason: expect.stringContaining('groq 500') }),
    );
    expect(quota.refund).toHaveBeenCalledWith('t1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ai.consultation_failed' }),
    );
  });

  it('analysis: consulta já expirou → noop', async () => {
    const { p, repo, provider } = makeProcessor();
    repo.findById.mockResolvedValueOnce({
      id: 'c1',
      tenantId: 't1',
      status: AiConsultationStatus.queued,
      inputPhotoR2Key: null,
      expiredAt: new Date(),
    });
    await p.process(makeJob(JOB_AI_ANALYSIS, { consultationId: 'c1', tenantId: 't1' }));
    expect(provider.analyze).not.toHaveBeenCalled();
  });

  it('cleanup: processa expirados, deleta R2 keys, audit por item', async () => {
    const { p, repo, storage, audit } = makeProcessor();
    repo.findDueForCleanup.mockResolvedValueOnce([
      { id: 'c1', tenantId: 't1', expiresAt: new Date() },
      { id: 'c2', tenantId: 't2', expiresAt: new Date() },
    ]);
    repo.markExpiredIfDue.mockImplementation(async (id: string) => ({
      updated: true,
      previousInputKey: `tenants/${id}/ai-visagism/input/x.jpg`,
      previousOutputKey: null,
    }));
    const result = await p.process(makeJob(JOB_AI_CLEANUP, {}));
    expect(result).toEqual({ processed: 2 });
    expect(storage.delete).toHaveBeenCalledTimes(2);
    expect(audit.record).toHaveBeenCalledTimes(2);
  });

  it('quota-reset: chama QuotaService.resetAll', async () => {
    const { p, quota } = makeProcessor();
    const result = await p.process(makeJob(JOB_AI_QUOTA_RESET, {}));
    expect(quota.resetAll).toHaveBeenCalled();
    expect(result).toEqual({ resetCount: 7 });
  });
});
