import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';
import { BillingService } from './billing.service';
import { SubscriptionRepository } from './repositories/subscription.repository';
import { BillingProvider, RemoteSubscription } from './providers/billing.provider';

type Mocked<T> = { [K in keyof T]: jest.Mock };

function mkRepo(): Mocked<SubscriptionRepository> {
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

function mkProvider(): Mocked<BillingProvider> {
  return {
    createPreapproval: jest.fn(),
    fetchPreapproval: jest.fn(),
    cancelPreapproval: jest.fn(),
    listPayments: jest.fn(),
    healthCheck: jest.fn(),
  };
}

function mkConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const map: Record<string, unknown> = {
    BILLING_TRIAL_DAYS: 14,
    BILLING_PAST_DUE_GRACE_DAYS: 7,
    MP_PLAN_AMOUNT_CENTS: 4990,
    MP_BILLING_FREQUENCY: 'months',
    ...overrides,
  };
  return { get: (k: string) => map[k] } as ConfigService;
}

describe('BillingService — core', () => {
  let repo: Mocked<SubscriptionRepository>;
  let provider: Mocked<BillingProvider>;
  let svc: BillingService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-12T12:00:00Z'));
    repo = mkRepo();
    provider = mkProvider();
    svc = new BillingService(
      repo as unknown as SubscriptionRepository,
      provider,
      mkConfig(),
      new Logger('test'),
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('startTrial', () => {
    it('cria Subscription{trialing, trialEndsAt:now+14d}', async () => {
      repo.create.mockResolvedValue({});
      await svc.startTrial({ tenantId: 't1' });
      expect(repo.create).toHaveBeenCalledWith({
        tenantId: 't1',
        status: SubscriptionStatus.trialing,
        trialEndsAt: new Date('2026-05-26T12:00:00Z'),
        tx: undefined,
      });
    });

    it('aceita transação externa via tx', async () => {
      repo.create.mockResolvedValue({});
      const tx = {} as never;
      await svc.startTrial({ tenantId: 't1', tx });
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ tx }));
    });
  });

  describe('getSubscription', () => {
    it('404 quando tenant não tem subscription', async () => {
      repo.findByTenantId.mockResolvedValue(null);
      await expect(svc.getSubscription('t1')).rejects.toMatchObject({
        opts: { code: 'SUBSCRIPTION_NOT_FOUND' },
      });
    });

    it('retorna view sanitizado (sem mpPreapprovalId interno)', async () => {
      repo.findByTenantId.mockResolvedValue({
        id: 'sub1',
        tenantId: 't1',
        status: 'trialing',
        trialEndsAt: new Date('2026-05-26T12:00:00Z'),
        currentPeriodEnd: null,
        mpPreapprovalId: 'PRE-1',
        lastSyncedAt: null,
        nextSyncAt: null,
        aiQuotaUsedThisMonth: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const view = await svc.getSubscription('t1');
      expect(view).toEqual({
        status: 'trialing',
        trialEndsAt: new Date('2026-05-26T12:00:00Z'),
        currentPeriodEnd: null,
        hasCheckout: true,
        lastSyncedAt: null,
      });
    });
  });

  describe('applyRemoteState', () => {
    const baseSub = {
      id: 'sub1',
      tenantId: 't1',
      status: 'trialing' as SubscriptionStatus,
      trialEndsAt: new Date('2026-05-26T12:00:00Z'),
      currentPeriodEnd: null,
      mpPreapprovalId: 'PRE-1',
      lastSyncedAt: null,
      nextSyncAt: null,
      aiQuotaUsedThisMonth: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it('authorized → active e seta currentPeriodEnd + nextSyncAt = now+24h', async () => {
      const remote: RemoteSubscription = {
        preapprovalId: 'PRE-1',
        status: 'authorized',
        nextPaymentDate: new Date('2026-06-12T12:00:00Z'),
      };
      repo.update.mockResolvedValue({ ...baseSub, status: 'active' });
      await svc.applyRemoteState(baseSub, remote);
      expect(repo.update).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({
          status: 'active',
          currentPeriodEnd: new Date('2026-06-12T12:00:00Z'),
          lastSyncedAt: new Date('2026-05-12T12:00:00Z'),
          nextSyncAt: new Date('2026-05-13T12:00:00Z'),
        }),
      );
    });

    it('paused → past_due', async () => {
      repo.update.mockResolvedValue({});
      await svc.applyRemoteState({ ...baseSub, status: 'active' } as never, {
        preapprovalId: 'PRE-1',
        status: 'paused',
        nextPaymentDate: null,
      });
      expect(repo.update).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({
          status: 'past_due',
          nextSyncAt: new Date('2026-05-12T14:00:00Z'), // +2h
        }),
      );
    });

    it('cancelled remoto → cancelled local e nextSyncAt=null', async () => {
      repo.update.mockResolvedValue({});
      await svc.applyRemoteState(baseSub, {
        preapprovalId: 'PRE-1',
        status: 'cancelled',
        nextPaymentDate: null,
      });
      expect(repo.update).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({
          status: 'cancelled',
          nextSyncAt: null,
        }),
      );
    });

    it('pending remoto não muda status local', async () => {
      await svc.applyRemoteState(baseSub, {
        preapprovalId: 'PRE-1',
        status: 'pending',
        nextPaymentDate: null,
      });
      expect(repo.update).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({
          status: 'trialing',
        }),
      );
    });

    it('nunca regride de cancelled', async () => {
      await svc.applyRemoteState({ ...baseSub, status: 'cancelled' } as never, {
        preapprovalId: 'PRE-1',
        status: 'authorized',
        nextPaymentDate: new Date(),
      });
      expect(repo.update).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({
          status: 'cancelled',
        }),
      );
    });
  });

  describe('cancelSubscription', () => {
    it('chama provider.cancelPreapproval e marca cancelled local', async () => {
      repo.findByTenantId.mockResolvedValue({
        tenantId: 't1',
        status: 'active',
        mpPreapprovalId: 'PRE-1',
      });
      repo.update.mockResolvedValue({});
      await svc.cancelSubscription('t1');
      expect(provider.cancelPreapproval).toHaveBeenCalledWith('PRE-1');
      expect(repo.update).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({
          status: 'cancelled',
          nextSyncAt: null,
        }),
      );
    });

    it('idempotente quando já cancelada', async () => {
      repo.findByTenantId.mockResolvedValue({
        tenantId: 't1',
        status: 'cancelled',
        mpPreapprovalId: 'PRE-1',
      });
      repo.update.mockResolvedValue({});
      await svc.cancelSubscription('t1');
      expect(repo.update).toHaveBeenCalled();
    });

    it('sem mpPreapprovalId só marca local (não chama provider)', async () => {
      repo.findByTenantId.mockResolvedValue({
        tenantId: 't1',
        status: 'trialing',
        mpPreapprovalId: null,
      });
      repo.update.mockResolvedValue({});
      await svc.cancelSubscription('t1');
      expect(provider.cancelPreapproval).not.toHaveBeenCalled();
      expect(repo.update).toHaveBeenCalled();
    });
  });
});
