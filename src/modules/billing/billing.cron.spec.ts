import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { AuditService } from 'src/common/audit/audit.service';
import { BillingService } from './billing.service';

function mkRepo() {
  return {
    findByTenantId: jest.fn(),
    findByPreapprovalId: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    findDueForSync: jest.fn(),
    findExpiredTrials: jest.fn(),
    findPastDueOverGrace: jest.fn(),
  };
}
function mkProvider() {
  return {
    createPreapproval: jest.fn(),
    fetchPreapproval: jest.fn(),
    cancelPreapproval: jest.fn(),
    listPayments: jest.fn(),
    healthCheck: jest.fn(),
  };
}
function mkConfig(): ConfigService {
  const map: Record<string, unknown> = {
    BILLING_TRIAL_DAYS: 14,
    BILLING_PAST_DUE_GRACE_DAYS: 7,
  };
  return { get: (k: string) => map[k] } as ConfigService;
}

describe('BillingService — crons', () => {
  let repo: ReturnType<typeof mkRepo>;
  let provider: ReturnType<typeof mkProvider>;
  let svc: BillingService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-12T12:00:00Z'));
    repo = mkRepo();
    provider = mkProvider();
    const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    svc = new BillingService(repo as never, provider, mkConfig(), new Logger('test'), audit);
  });
  afterEach(() => jest.useRealTimers());

  describe('runBillingSync', () => {
    it('processa cada subscription elegível e aplica remoteState', async () => {
      repo.findDueForSync.mockResolvedValue([
        { tenantId: 't1', status: 'trialing', mpPreapprovalId: 'PRE-1' },
        { tenantId: 't2', status: 'active', mpPreapprovalId: 'PRE-2' },
      ]);
      provider.fetchPreapproval
        .mockResolvedValueOnce({
          preapprovalId: 'PRE-1',
          status: 'authorized',
          nextPaymentDate: new Date('2026-06-12T12:00:00Z'),
        })
        .mockResolvedValueOnce({ preapprovalId: 'PRE-2', status: 'paused', nextPaymentDate: null });
      repo.update.mockResolvedValue({});

      const stats = await svc.runBillingSync();

      expect(stats).toEqual({ processed: 2, failed: 0 });
      expect(provider.fetchPreapproval).toHaveBeenNthCalledWith(1, 'PRE-1');
      expect(provider.fetchPreapproval).toHaveBeenNthCalledWith(2, 'PRE-2');
      expect(repo.update).toHaveBeenNthCalledWith(
        1,
        't1',
        expect.objectContaining({ status: 'active' }),
      );
      expect(repo.update).toHaveBeenNthCalledWith(
        2,
        't2',
        expect.objectContaining({ status: 'past_due' }),
      );
    });

    it('falha individual recua nextSyncAt em 15 min, segue para o próximo', async () => {
      repo.findDueForSync.mockResolvedValue([
        { tenantId: 't1', status: 'active', mpPreapprovalId: 'PRE-1' },
        { tenantId: 't2', status: 'active', mpPreapprovalId: 'PRE-2' },
      ]);
      provider.fetchPreapproval.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({
        preapprovalId: 'PRE-2',
        status: 'authorized',
        nextPaymentDate: new Date('2026-06-12T12:00:00Z'),
      });
      repo.update.mockResolvedValue({});

      const stats = await svc.runBillingSync();

      expect(stats).toEqual({ processed: 1, failed: 1 });
      expect(repo.update).toHaveBeenNthCalledWith(
        1,
        't1',
        expect.objectContaining({
          nextSyncAt: new Date('2026-05-12T12:15:00Z'),
        }),
      );
      expect(repo.update).toHaveBeenNthCalledWith(
        2,
        't2',
        expect.objectContaining({ status: 'active' }),
      );
    });
  });

  describe('runTrialCheck', () => {
    it('trial expirado → past_due', async () => {
      repo.findExpiredTrials.mockResolvedValue([
        {
          tenantId: 't1',
          status: 'trialing',
          mpPreapprovalId: null,
          trialEndsAt: new Date('2026-05-11T00:00:00Z'),
          updatedAt: new Date('2026-04-28T00:00:00Z'),
        },
      ]);
      repo.findPastDueOverGrace.mockResolvedValue([]);
      repo.update.mockResolvedValue({});

      const stats = await svc.runTrialCheck();

      expect(stats).toEqual({ trialExpired: 1, graceExpired: 0 });
      expect(repo.update).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({
          status: 'past_due',
        }),
      );
    });

    it('past_due > graça (default 7d) → cancela no gateway + cancelled local + mpPreapprovalId null', async () => {
      repo.findExpiredTrials.mockResolvedValue([]);
      repo.findPastDueOverGrace.mockImplementation((cutoff: Date) => {
        expect(cutoff).toEqual(new Date('2026-05-05T12:00:00Z'));
        return Promise.resolve([{ tenantId: 't2', status: 'past_due', mpPreapprovalId: 'PRE-2' }]);
      });
      provider.cancelPreapproval.mockResolvedValue(undefined);
      repo.update.mockResolvedValue({});

      const stats = await svc.runTrialCheck();

      expect(stats).toEqual({ trialExpired: 0, graceExpired: 1 });
      // Evita cobrança duplicada: cancela no gateway antes de marcar local cancelled.
      expect(provider.cancelPreapproval).toHaveBeenCalledWith('PRE-2');
      expect(repo.update).toHaveBeenCalledWith(
        't2',
        expect.objectContaining({
          status: 'cancelled',
          mpPreapprovalId: null,
          nextSyncAt: null,
        }),
      );
    });

    it('falha do gateway no cancel de grace não bloqueia transição local pra cancelled', async () => {
      repo.findExpiredTrials.mockResolvedValue([]);
      repo.findPastDueOverGrace.mockResolvedValue([
        { tenantId: 't3', status: 'past_due', mpPreapprovalId: 'PRE-3' },
      ]);
      provider.cancelPreapproval.mockRejectedValue(new Error('upstream 503'));
      repo.update.mockResolvedValue({});

      const stats = await svc.runTrialCheck();

      expect(stats).toEqual({ trialExpired: 0, graceExpired: 1 });
      expect(repo.update).toHaveBeenCalledWith(
        't3',
        expect.objectContaining({ status: 'cancelled', mpPreapprovalId: null }),
      );
    });
  });
});
