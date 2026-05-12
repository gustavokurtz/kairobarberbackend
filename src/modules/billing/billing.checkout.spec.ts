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
    MP_PLAN_AMOUNT_CENTS: 4990,
    MP_BILLING_FREQUENCY: 'months',
  };
  return { get: (k: string) => map[k] } as ConfigService;
}

describe('BillingService — checkout/sync', () => {
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

  describe('createCheckout', () => {
    it('SUBSCRIPTION_ALREADY_ACTIVE se status=active', async () => {
      repo.findByTenantId.mockResolvedValue({
        tenantId: 't1',
        status: 'active',
        mpPreapprovalId: 'PRE-1',
      });
      await expect(
        svc.createCheckout({ tenantId: 't1', tenantSlug: 's', ownerEmail: 'a@x.com' }),
      ).rejects.toMatchObject({ opts: { code: 'SUBSCRIPTION_ALREADY_ACTIVE' } });
    });

    it('trialing sem preapproval → cria preapproval e salva id', async () => {
      repo.findByTenantId.mockResolvedValue({
        tenantId: 't1',
        status: 'trialing',
        mpPreapprovalId: null,
      });
      provider.createPreapproval.mockResolvedValue({
        preapprovalId: 'PRE-NEW',
        initPoint: 'https://mp/x',
      });
      repo.update.mockResolvedValue({});
      const out = await svc.createCheckout({
        tenantId: 't1',
        tenantSlug: 'demo',
        ownerEmail: 'a@x.com',
      });
      expect(out).toEqual({ initPoint: 'https://mp/x' });
      expect(provider.createPreapproval).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 't1',
          tenantSlug: 'demo',
          payerEmail: 'a@x.com',
          amountCents: 4990,
          frequency: 'months',
          reason: 'Assinatura KairoBarber - demo',
        }),
      );
      expect(repo.update).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({
          mpPreapprovalId: 'PRE-NEW',
          nextSyncAt: new Date('2026-05-12T13:00:00Z'), // +1h sondagem agressiva pós-checkout
        }),
      );
    });

    it('past_due ou cancelled → cria preapproval novo (substitui)', async () => {
      repo.findByTenantId.mockResolvedValue({
        tenantId: 't1',
        status: 'past_due',
        mpPreapprovalId: 'PRE-OLD',
      });
      provider.createPreapproval.mockResolvedValue({
        preapprovalId: 'PRE-NEW2',
        initPoint: 'https://mp/y',
      });
      repo.update.mockResolvedValue({});
      const out = await svc.createCheckout({
        tenantId: 't1',
        tenantSlug: 'd',
        ownerEmail: 'a@x.com',
      });
      expect(out).toEqual({ initPoint: 'https://mp/y' });
      expect(repo.update).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({
          mpPreapprovalId: 'PRE-NEW2',
          status: 'trialing', // retorna pro fluxo trial enquanto MP confirma
        }),
      );
    });

    it('SUBSCRIPTION_NOT_FOUND se tenant não tem subscription', async () => {
      repo.findByTenantId.mockResolvedValue(null);
      await expect(
        svc.createCheckout({ tenantId: 't1', tenantSlug: 's', ownerEmail: 'a@x.com' }),
      ).rejects.toMatchObject({ opts: { code: 'SUBSCRIPTION_NOT_FOUND' } });
    });
  });

  describe('syncSubscription (on-demand)', () => {
    it('busca remoto e aplica via applyRemoteState', async () => {
      repo.findByTenantId.mockResolvedValue({
        tenantId: 't1',
        status: 'trialing',
        mpPreapprovalId: 'PRE-1',
        currentPeriodEnd: null,
        trialEndsAt: null,
      });
      provider.fetchPreapproval.mockResolvedValue({
        preapprovalId: 'PRE-1',
        status: 'authorized',
        nextPaymentDate: new Date('2026-06-12T12:00:00Z'),
      });
      repo.update.mockResolvedValue({});
      await svc.syncSubscription('t1');
      expect(provider.fetchPreapproval).toHaveBeenCalledWith('PRE-1');
      expect(repo.update).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({
          status: 'active',
          currentPeriodEnd: new Date('2026-06-12T12:00:00Z'),
        }),
      );
    });

    it('sem mpPreapprovalId → no-op', async () => {
      repo.findByTenantId.mockResolvedValue({
        tenantId: 't1',
        status: 'trialing',
        mpPreapprovalId: null,
      });
      await svc.syncSubscription('t1');
      expect(provider.fetchPreapproval).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
    });
  });

  describe('listInvoices', () => {
    it('proxia provider.listPayments e mapeia para DTO', async () => {
      repo.findByTenantId.mockResolvedValue({
        tenantId: 't1',
        mpPreapprovalId: 'PRE-1',
      });
      provider.listPayments.mockResolvedValue([
        {
          id: 'P-1',
          amountCents: 4990,
          status: 'approved',
          paidAt: new Date('2026-04-12T10:00:00Z'),
          dueAt: new Date('2026-04-12T09:00:00Z'),
        },
      ]);
      const out = await svc.listInvoices('t1', { page: 1, pageSize: 20 });
      expect(out).toEqual([
        {
          id: 'P-1',
          amountCents: 4990,
          status: 'approved',
          paidAt: new Date('2026-04-12T10:00:00Z'),
          dueAt: new Date('2026-04-12T09:00:00Z'),
        },
      ]);
    });

    it('sem preapproval → lista vazia (sem chamar provider)', async () => {
      repo.findByTenantId.mockResolvedValue({ tenantId: 't1', mpPreapprovalId: null });
      const out = await svc.listInvoices('t1', { page: 1, pageSize: 20 });
      expect(out).toEqual([]);
      expect(provider.listPayments).not.toHaveBeenCalled();
    });
  });
});
