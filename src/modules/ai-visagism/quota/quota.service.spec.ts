import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { QuotaService } from './quota.service';
import { QuotaRepository } from './quota.repository';

function makeService(limit = 3) {
  const repo: jest.Mocked<Pick<QuotaRepository, 'tryIncrement' | 'refund' | 'resetAll'>> = {
    tryIncrement: jest.fn(),
    refund: jest.fn(),
    resetAll: jest.fn(),
  };
  const cfg = {
    getOrThrow: <T>(k: string) =>
      k === 'AI_VISAGISM_MONTHLY_QUOTA' ? (limit as unknown as T) : (undefined as unknown as T),
  } as unknown as ConfigService;
  const logger = { log: jest.fn(), warn: jest.fn() } as unknown as Logger;
  const service = new QuotaService(repo as unknown as QuotaRepository, cfg, logger);
  return { service, repo, logger };
}

describe('QuotaService', () => {
  it('chargeOrThrow retorna {used, limit} quando incremento sucede', async () => {
    const { service, repo } = makeService(3);
    repo.tryIncrement.mockResolvedValueOnce(1);
    await expect(service.chargeOrThrow('t1')).resolves.toEqual({ used: 1, limit: 3 });
    expect(repo.tryIncrement).toHaveBeenCalledWith('t1', 3);
  });

  it('chargeOrThrow lança DomainException AI_QUOTA_EXCEEDED quando esgotada', async () => {
    const { service, repo } = makeService(3);
    repo.tryIncrement.mockResolvedValueOnce(null);
    await expect(service.chargeOrThrow('t1')).rejects.toMatchObject({
      opts: { code: 'AI_QUOTA_EXCEEDED', status: 429 },
    });
    expect(repo.tryIncrement).toHaveBeenCalled();
  });

  it('refund engole erro do repo e loga warn', async () => {
    const { service, repo, logger } = makeService();
    repo.refund.mockRejectedValueOnce(new Error('db down'));
    await expect(service.refund('t1')).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ai_visagism.quota_refund_failed' }),
    );
  });

  it('resetAll devolve count do repo e loga', async () => {
    const { service, repo } = makeService();
    repo.resetAll.mockResolvedValueOnce(42);
    await expect(service.resetAll()).resolves.toBe(42);
  });

  it('monthlyLimit reflete env', () => {
    const { service } = makeService(100);
    expect(service.monthlyLimit).toBe(100);
  });
});
