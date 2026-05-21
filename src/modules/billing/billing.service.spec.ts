import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';
import { AuditService } from 'src/common/audit/audit.service';
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
    BILLING_PAST_DUE_GRACE_DAYS: 1,
    MP_PLAN_AMOUNT_CENTS: 4990,
    MP_BILLING_FREQUENCY: 'months',
    ...overrides,
  };
  return { get: (k: string) => map[k] } as ConfigService;
}

describe('BillingService — core', () => {
  let repo: Mocked<SubscriptionRepository>;
  let provider: Mocked<BillingProvider>;
  let audit: { record: jest.Mock };
  let svc: BillingService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-12T12:00:00Z'));
    repo = mkRepo();
    provider = mkProvider();
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    svc = new BillingService(
      repo as unknown as SubscriptionRepository,
      provider,
      mkConfig(),
      new Logger('test'),
      audit as unknown as AuditService,
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

    it('grava audit log em startTrial', async () => {
      repo.create.mockResolvedValueOnce({ id: 's1' });
      await svc.startTrial({ tenantId: 't1' });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'subscription.trial_started',
          tenantId: 't1',
          targetId: 's1',
        }),
        undefined,
      );
    });

    it('encaminha tx para audit.record quando startTrial roda dentro de transação', async () => {
      repo.create.mockResolvedValueOnce({ id: 's1' });
      const tx = { $kind: 'tx' } as never;
      await svc.startTrial({ tenantId: 't1', tx });
      expect(audit.record).toHaveBeenCalledWith(expect.any(Object), tx);
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

    beforeEach(() => {
      // Concurrency guard re-fetch: por padrão, current DB state bate com o `local`
      // que cada teste passa. Casos de race fazem override próprio.
      repo.findByTenantId.mockImplementation(async () => baseSub);
    });

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
      repo.findByTenantId.mockResolvedValue({ ...baseSub, status: 'active' });
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

    // O guard "nunca regride de cancelled" foi removido em 2026-05-19. Razão:
    // travava reativação — após cancelled + createCheckout + pagamento, sync detectava
    // 'authorized' mas o guard mantinha cancelled, pagamento ficava preso eternamente.
    // A defesa real contra reviver cancelled sem motivo é o controle de mpPreapprovalId
    // (zerado quando vira cancelled via runTrialCheck), que faz syncSubscription virar
    // no-op. Só chega aqui se houve checkout explícito que setou novo mpPreapprovalId.
    it('cancelled local + remoto authorized → permite reativação (novo checkout pago)', async () => {
      repo.findByTenantId.mockResolvedValue({
        ...baseSub,
        status: 'cancelled',
        mpPreapprovalId: 'PRE-1',
      });
      await svc.applyRemoteState({ ...baseSub, status: 'cancelled' } as never, {
        preapprovalId: 'PRE-1',
        status: 'authorized',
        nextPaymentDate: new Date('2026-06-12T12:00:00Z'),
      });
      expect(repo.update).toHaveBeenCalledWith('t1', expect.objectContaining({ status: 'active' }));
    });

    it('skip silencioso se mpPreapprovalId mudou entre read e apply (race com createCheckout)', async () => {
      // Simula: cron leu sub com mpPreapprovalId='PRE-OLD', durante o fetchPreapproval
      // outro fluxo (createCheckout do user) atualizou pra 'PRE-NEW'. Aplicar o estado
      // remoto agora sobrescreveria o NEW. Guard detecta divergência e pula.
      repo.findByTenantId.mockResolvedValue({ ...baseSub, mpPreapprovalId: 'PRE-NEW' });
      await svc.applyRemoteState(
        { ...baseSub, mpPreapprovalId: 'PRE-OLD' },
        {
          preapprovalId: 'PRE-OLD',
          status: 'cancelled',
          nextPaymentDate: null,
        },
      );
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('skip se subscription foi deletada entre read e apply', async () => {
      repo.findByTenantId.mockResolvedValue(null);
      await svc.applyRemoteState(baseSub, {
        preapprovalId: 'PRE-1',
        status: 'authorized',
        nextPaymentDate: null,
      });
      expect(repo.update).not.toHaveBeenCalled();
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

  describe('getBillingStatus', () => {
    // svc usa mkConfig() default (grace=1). FIXED_NOW = 2026-05-12T12Z (do beforeEach do describe pai).
    const FIXED_NOW = new Date('2026-05-12T12:00:00Z');

    it('trialing → origin=trial, deadlineAt=trialEndsAt', async () => {
      const trialEndsAt = new Date('2026-05-15T12:00:00Z'); // +3 dias
      repo.findByTenantId.mockResolvedValue({
        id: 's1',
        tenantId: 't1',
        status: 'trialing',
        trialEndsAt,
        currentPeriodEnd: null,
        mpPreapprovalId: null,
        lastSyncedAt: null,
        nextSyncAt: null,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      });

      const out = await svc.getBillingStatus('t1');
      expect(out).toEqual({
        status: 'trialing',
        origin: 'trial',
        deadlineAt: trialEndsAt,
        msUntilDeadline: 3 * 24 * 60 * 60 * 1000,
        hasCheckout: false,
      });
    });

    it('past_due + currentPeriodEnd null → origin=trial', async () => {
      const updatedAt = new Date('2026-05-11T12:00:00Z'); // ontem
      repo.findByTenantId.mockResolvedValue({
        id: 's1',
        tenantId: 't1',
        status: 'past_due',
        trialEndsAt: new Date('2026-05-11T12:00:00Z'),
        currentPeriodEnd: null,
        mpPreapprovalId: null,
        lastSyncedAt: null,
        nextSyncAt: null,
        createdAt: FIXED_NOW,
        updatedAt,
      });

      const out = await svc.getBillingStatus('t1');
      expect(out.origin).toBe('trial');
      // deadline = updatedAt + 1d (grace default) = 2026-05-12T12Z = FIXED_NOW → ms=0
      expect(out.deadlineAt).toEqual(new Date('2026-05-12T12:00:00Z'));
      expect(out.msUntilDeadline).toBe(0);
    });

    it('past_due + currentPeriodEnd não-null → origin=payment', async () => {
      const periodEnd = new Date('2026-05-02T12:00:00Z');
      const updatedAt = new Date('2026-05-12T06:00:00Z'); // 6h antes do FIXED_NOW
      repo.findByTenantId.mockResolvedValue({
        id: 's1',
        tenantId: 't1',
        status: 'past_due',
        trialEndsAt: null,
        currentPeriodEnd: periodEnd,
        mpPreapprovalId: 'mp_abc',
        lastSyncedAt: null,
        nextSyncAt: null,
        createdAt: FIXED_NOW,
        updatedAt,
      });

      const out = await svc.getBillingStatus('t1');
      expect(out.origin).toBe('payment');
      expect(out.deadlineAt).toEqual(new Date(updatedAt.getTime() + 24 * 60 * 60 * 1000));
      expect(out.hasCheckout).toBe(true);
      // 18h até deadline (24h - 6h)
      expect(out.msUntilDeadline).toBe(18 * 60 * 60 * 1000);
    });

    it('active → origin=null, deadlineAt=null, msUntilDeadline=null', async () => {
      repo.findByTenantId.mockResolvedValue({
        id: 's1',
        tenantId: 't1',
        status: 'active',
        trialEndsAt: null,
        currentPeriodEnd: new Date('2026-06-10T12:00:00Z'),
        mpPreapprovalId: 'mp_abc',
        lastSyncedAt: FIXED_NOW,
        nextSyncAt: null,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      });

      const out = await svc.getBillingStatus('t1');
      expect(out).toMatchObject({
        status: 'active',
        origin: null,
        deadlineAt: null,
        msUntilDeadline: null,
        hasCheckout: true,
      });
    });

    it('cancelled → origin=null, deadlineAt=null', async () => {
      repo.findByTenantId.mockResolvedValue({
        id: 's1',
        tenantId: 't1',
        status: 'cancelled',
        trialEndsAt: null,
        currentPeriodEnd: null,
        mpPreapprovalId: null,
        lastSyncedAt: FIXED_NOW,
        nextSyncAt: null,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      });

      const out = await svc.getBillingStatus('t1');
      expect(out.origin).toBeNull();
      expect(out.deadlineAt).toBeNull();
      expect(out.msUntilDeadline).toBeNull();
    });

    it('lança SUBSCRIPTION_NOT_FOUND se não existir', async () => {
      repo.findByTenantId.mockResolvedValue(null);
      await expect(svc.getBillingStatus('t1')).rejects.toMatchObject({
        opts: { code: 'SUBSCRIPTION_NOT_FOUND' },
      });
    });
  });
});
