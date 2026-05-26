import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { QuotaService } from './quota.service';
import { QuotaRepository } from './quota.repository';

function makeService(trialLimit = 10, activeLimit = 30) {
  const repo: jest.Mocked<
    Pick<QuotaRepository, 'tryIncrement' | 'refund' | 'resetAll' | 'getStatus'>
  > = {
    tryIncrement: jest.fn(),
    refund: jest.fn(),
    resetAll: jest.fn(),
    getStatus: jest.fn(),
  };
  const cfg = {
    getOrThrow: <T>(k: string): T => {
      if (k === 'AI_VISAGISM_TRIAL_QUOTA') return trialLimit as unknown as T;
      if (k === 'AI_VISAGISM_ACTIVE_QUOTA') return activeLimit as unknown as T;
      return undefined as unknown as T;
    },
  } as unknown as ConfigService;
  const logger = { log: jest.fn(), warn: jest.fn() } as unknown as Logger;
  const service = new QuotaService(repo as unknown as QuotaRepository, cfg, logger);
  return { service, repo, logger };
}

describe('QuotaService', () => {
  describe('chargeOrThrow — sucesso por status', () => {
    it('trialing 9→10: incrementa e retorna limit=10', async () => {
      const { service, repo } = makeService(10, 30);
      repo.tryIncrement.mockResolvedValueOnce({ used: 10, status: 'trialing' });
      await expect(service.chargeOrThrow('t1')).resolves.toEqual({
        used: 10,
        limit: 10,
        status: 'trialing',
      });
      expect(repo.tryIncrement).toHaveBeenCalledWith('t1', 10, 30);
    });

    it('active 29→30: incrementa e retorna limit=30', async () => {
      const { service, repo } = makeService(10, 30);
      repo.tryIncrement.mockResolvedValueOnce({ used: 30, status: 'active' });
      await expect(service.chargeOrThrow('t1')).resolves.toEqual({
        used: 30,
        limit: 30,
        status: 'active',
      });
    });
  });

  describe('chargeOrThrow — estouro (null do repo)', () => {
    it('trialing estourado: 429 com details.limit=10', async () => {
      const { service, repo } = makeService(10, 30);
      repo.tryIncrement.mockResolvedValueOnce(null);
      repo.getStatus.mockResolvedValueOnce('trialing');
      await expect(service.chargeOrThrow('t1')).rejects.toMatchObject({
        opts: {
          code: 'AI_QUOTA_EXCEEDED',
          status: 429,
          details: { limit: 10 },
        },
      });
      expect(repo.getStatus).toHaveBeenCalledWith('t1');
    });

    it('active estourado: 429 com details.limit=30', async () => {
      const { service, repo } = makeService(10, 30);
      repo.tryIncrement.mockResolvedValueOnce(null);
      repo.getStatus.mockResolvedValueOnce('active');
      await expect(service.chargeOrThrow('t1')).rejects.toMatchObject({
        opts: {
          code: 'AI_QUOTA_EXCEEDED',
          status: 429,
          details: { limit: 30 },
        },
      });
    });

    it('past_due (CASE retorna 0): 429 com details.limit=0', async () => {
      const { service, repo } = makeService(10, 30);
      repo.tryIncrement.mockResolvedValueOnce(null);
      repo.getStatus.mockResolvedValueOnce('past_due');
      await expect(service.chargeOrThrow('t1')).rejects.toMatchObject({
        opts: {
          code: 'AI_QUOTA_EXCEEDED',
          status: 429,
          details: { limit: 0 },
        },
      });
    });

    it('tenant sem subscription (getStatus null): 429 com details.limit=0', async () => {
      const { service, repo } = makeService(10, 30);
      repo.tryIncrement.mockResolvedValueOnce(null);
      repo.getStatus.mockResolvedValueOnce(null);
      await expect(service.chargeOrThrow('t1')).rejects.toMatchObject({
        opts: {
          code: 'AI_QUOTA_EXCEEDED',
          status: 429,
          details: { limit: 0 },
        },
      });
    });
  });

  describe('refund (inalterado)', () => {
    it('engole erro do repo e loga warn', async () => {
      const { service, repo, logger } = makeService();
      repo.refund.mockRejectedValueOnce(new Error('db down'));
      await expect(service.refund('t1')).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'ai_visagism.quota_refund_failed' }),
      );
    });
  });

  describe('resetAll (inalterado)', () => {
    it('devolve count do repo e loga', async () => {
      const { service, repo } = makeService();
      repo.resetAll.mockResolvedValueOnce(42);
      await expect(service.resetAll()).resolves.toBe(42);
    });
  });

  describe('limites expostos', () => {
    it('trialLimit e activeLimit refletem env', () => {
      const { service } = makeService(7, 21);
      expect(service.trialLimit).toBe(7);
      expect(service.activeLimit).toBe(21);
    });
  });
});
