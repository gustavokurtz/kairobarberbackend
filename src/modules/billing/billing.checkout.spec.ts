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
function mkConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const map: Record<string, unknown> = {
    BILLING_PROVIDER: 'mercadopago',
    BILLING_TRIAL_DAYS: 14,
    MP_PLAN_AMOUNT_CENTS: 4990,
    MP_BILLING_FREQUENCY: 'months',
    ...overrides,
  };
  return {
    get: (k: string) => map[k],
    getOrThrow: (k: string) => {
      if (!(k in map)) throw new Error(`Configuration key "${k}" does not exist`);
      return map[k];
    },
  } as unknown as ConfigService;
}

// F4/A4: prisma.$transaction(callback) é mockado pra rodar o callback com um "tx" que
// delega lookups/updates pra `repo` (mockado). Preserva semântica de testes que usam
// mockResolvedValue/mockImplementation em repo.findByTenantId.
function mkPrisma(repoRef: ReturnType<typeof mkRepo>) {
  return {
    $transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        subscription: {
          findUnique: (args: { where: { tenantId: string } }): Promise<unknown> =>
            repoRef.findByTenantId(args.where.tenantId) as Promise<unknown>,
          update: (args: {
            where: { tenantId: string };
            data: Record<string, unknown>;
          }): Promise<unknown> =>
            repoRef.update(args.where.tenantId, args.data) as Promise<unknown>,
        },
      };
      return callback(tx);
    }),
  };
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
    svc = new BillingService(
      repo as never,
      provider,
      mkConfig(),
      new Logger('test'),
      audit,
      mkPrisma(repo) as never,
    );
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
        svc.createCheckout({
          tenantId: 't1',
          tenantSlug: 's',
          ownerEmail: 'a@x.com',
          ownerName: 'Owner X',
        }),
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
        ownerName: 'Gustavo Demo',
      });
      expect(out).toEqual({ initPoint: 'https://mp/x' });
      expect(provider.createPreapproval).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 't1',
          tenantSlug: 'demo',
          payerEmail: 'a@x.com',
          payerName: 'Gustavo Demo',
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

    it('past_due ou cancelled → cancela preapproval anterior e cria novo', async () => {
      repo.findByTenantId.mockResolvedValue({
        tenantId: 't1',
        status: 'past_due',
        mpPreapprovalId: 'PRE-OLD',
      });
      provider.cancelPreapproval.mockResolvedValue(undefined);
      provider.createPreapproval.mockResolvedValue({
        preapprovalId: 'PRE-NEW2',
        initPoint: 'https://mp/y',
      });
      repo.update.mockResolvedValue({});
      const out = await svc.createCheckout({
        tenantId: 't1',
        tenantSlug: 'd',
        ownerEmail: 'a@x.com',
        ownerName: 'Owner D',
      });
      expect(out).toEqual({ initPoint: 'https://mp/y' });
      // segurança: cancela o anterior ANTES de criar novo, pra não deixar subscription órfã ativa
      expect(provider.cancelPreapproval).toHaveBeenCalledWith('PRE-OLD');
      expect(provider.cancelPreapproval.mock.invocationCallOrder[0]).toBeLessThan(
        provider.createPreapproval.mock.invocationCallOrder[0],
      );
      // createCheckout NÃO deve sobrescrever o status com 'trialing' — antes dava efeito
      // colateral em past_due/cancelled (mostrava trialEndsAt antigo na UI). Mantemos o status
      // atual; sync detecta pagamento e promove pra active.
      expect(repo.update).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({
          mpPreapprovalId: 'PRE-NEW2',
        }),
      );
      expect(repo.update).toHaveBeenCalledWith(
        't1',
        expect.not.objectContaining({ status: 'trialing' }),
      );
    });

    it('falha ao cancelar preapproval anterior não bloqueia novo checkout', async () => {
      repo.findByTenantId.mockResolvedValue({
        tenantId: 't1',
        status: 'past_due',
        mpPreapprovalId: 'PRE-OLD',
      });
      provider.cancelPreapproval.mockRejectedValue(new Error('upstream 500'));
      provider.createPreapproval.mockResolvedValue({
        preapprovalId: 'PRE-NEW3',
        initPoint: 'https://mp/z',
      });
      repo.update.mockResolvedValue({});
      const out = await svc.createCheckout({
        tenantId: 't1',
        tenantSlug: 'd',
        ownerEmail: 'a@x.com',
        ownerName: 'Owner D',
      });
      expect(out).toEqual({ initPoint: 'https://mp/z' });
      expect(provider.createPreapproval).toHaveBeenCalled();
    });

    it('trialing sem preapproval → NÃO chama cancelPreapproval', async () => {
      repo.findByTenantId.mockResolvedValue({
        tenantId: 't1',
        status: 'trialing',
        mpPreapprovalId: null,
      });
      provider.createPreapproval.mockResolvedValue({
        preapprovalId: 'PRE-FRESH',
        initPoint: 'https://mp/q',
      });
      repo.update.mockResolvedValue({});
      await svc.createCheckout({
        tenantId: 't1',
        tenantSlug: 'd',
        ownerEmail: 'a@x.com',
        ownerName: 'Owner D',
      });
      expect(provider.cancelPreapproval).not.toHaveBeenCalled();
    });

    it('com BILLING_PROVIDER=asaas e sem ownerCpfCnpj → TENANT_DOCUMENT_REQUIRED 422', async () => {
      svc = new BillingService(
        repo as never,
        provider,
        mkConfig({ BILLING_PROVIDER: 'asaas', ASAAS_PLAN_AMOUNT_CENTS: 500 }),
        new Logger('test'),
        { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService,
        mkPrisma(repo) as never,
      );
      repo.findByTenantId.mockResolvedValue({
        tenantId: 't1',
        status: 'trialing',
        mpPreapprovalId: null,
      });
      await expect(
        svc.createCheckout({
          tenantId: 't1',
          tenantSlug: 's',
          ownerEmail: 'a@x.com',
          ownerName: 'X',
        }),
      ).rejects.toMatchObject({ opts: { code: 'TENANT_DOCUMENT_REQUIRED' } });
      expect(provider.createPreapproval).not.toHaveBeenCalled();
    });

    it('com BILLING_PROVIDER=asaas e ownerCpfCnpj válido → segue pro provider', async () => {
      svc = new BillingService(
        repo as never,
        provider,
        mkConfig({ BILLING_PROVIDER: 'asaas', ASAAS_PLAN_AMOUNT_CENTS: 500 }),
        new Logger('test'),
        { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService,
        mkPrisma(repo) as never,
      );
      repo.findByTenantId.mockResolvedValue({
        tenantId: 't1',
        status: 'trialing',
        mpPreapprovalId: null,
      });
      provider.createPreapproval.mockResolvedValue({
        preapprovalId: 'sub_NEW',
        initPoint: 'https://sandbox.asaas/x',
      });
      repo.update.mockResolvedValue({});
      const out = await svc.createCheckout({
        tenantId: 't1',
        tenantSlug: 's',
        ownerEmail: 'a@x.com',
        ownerName: 'X',
        ownerCpfCnpj: '12865937607',
      });
      expect(out).toEqual({ initPoint: 'https://sandbox.asaas/x' });
      expect(provider.createPreapproval).toHaveBeenCalledWith(
        expect.objectContaining({
          payerCpfCnpj: '12865937607',
          amountCents: 500, // veio do ASAAS_PLAN_AMOUNT_CENTS, não do MP
        }),
      );
    });

    it('SUBSCRIPTION_NOT_FOUND se tenant não tem subscription', async () => {
      repo.findByTenantId.mockResolvedValue(null);
      await expect(
        svc.createCheckout({
          tenantId: 't1',
          tenantSlug: 's',
          ownerEmail: 'a@x.com',
          ownerName: 'Owner X',
        }),
      ).rejects.toMatchObject({ opts: { code: 'SUBSCRIPTION_NOT_FOUND' } });
    });

    it('CHECKOUT_RACE_DETECTED (409) se mpPreapprovalId mudar entre leitura inicial e TX1 pre-HTTP (F4/A4)', async () => {
      // Simula: leitura inicial vê mp=A; quando a TX1 re-lê, DB já tem mp=B
      // (outro checkout completou meanwhile). Perdedora aborta ANTES de gastar HTTP.
      let callCount = 0;
      repo.findByTenantId.mockImplementation(() => {
        callCount += 1;
        if (callCount === 1) {
          // 1ª: leitura inicial — vê mp=A, status=past_due
          return Promise.resolve({
            tenantId: 't1',
            status: 'past_due',
            mpPreapprovalId: 'PRE-A',
            updatedAt: new Date('2026-05-21T10:00:00Z'),
          });
        }
        // 2ª+: re-leitura na TX1 — DB já tem mp=B (outro checkout escreveu)
        return Promise.resolve({
          tenantId: 't1',
          status: 'past_due',
          mpPreapprovalId: 'PRE-B',
          updatedAt: new Date('2026-05-21T10:00:05Z'),
        });
      });

      await expect(
        svc.createCheckout({
          tenantId: 't1',
          tenantSlug: 's',
          ownerEmail: 'a@x.com',
          ownerName: 'Owner X',
        }),
      ).rejects.toMatchObject({
        opts: { code: 'CHECKOUT_RACE_DETECTED', status: 409 },
      });

      // Race detectada pre-HTTP — createPreapproval NÃO foi chamado
      expect(provider.createPreapproval).not.toHaveBeenCalled();
    });

    it('CHECKOUT_RACE_DETECTED (409) + cleanup se mp mudar entre TX1 e TX2 (F4/A4)', async () => {
      // Simula race POST-HTTP: TX1 valida ok (init+TX1 veem mp=A), HTTP roda criando
      // PRE-NEW, DB muda meanwhile pra mp=Z, TX2 detecta e aborta. Cleanup deve
      // cancelar PRE-NEW (perdedor não pode deixar órfão no Asaas).
      let callCount = 0;
      repo.findByTenantId.mockImplementation(() => {
        callCount += 1;
        if (callCount <= 2) {
          // 1ª (init) + 2ª (TX1): ainda mp=A
          return Promise.resolve({
            tenantId: 't1',
            status: 'past_due',
            mpPreapprovalId: 'PRE-A',
            updatedAt: new Date('2026-05-21T10:00:00Z'),
          });
        }
        // 3ª (TX2): DB mudou pra mp=Z meanwhile
        return Promise.resolve({
          tenantId: 't1',
          status: 'past_due',
          mpPreapprovalId: 'PRE-Z',
          updatedAt: new Date('2026-05-21T10:00:10Z'),
        });
      });
      provider.cancelPreapproval.mockResolvedValue(undefined);
      provider.createPreapproval.mockResolvedValue({
        preapprovalId: 'PRE-NEW',
        initPoint: 'https://asaas.test/i/PRE-NEW',
      });

      await expect(
        svc.createCheckout({
          tenantId: 't1',
          tenantSlug: 's',
          ownerEmail: 'a@x.com',
          ownerName: 'Owner X',
        }),
      ).rejects.toMatchObject({
        opts: { code: 'CHECKOUT_RACE_DETECTED', status: 409 },
      });

      // Cleanup: cancelPreapproval chamado com PRE-NEW (preapproval órfão)
      expect(provider.cancelPreapproval).toHaveBeenCalledWith('PRE-NEW');
      // createPreapproval só rodou 1x (não retry após race)
      expect(provider.createPreapproval).toHaveBeenCalledTimes(1);
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
