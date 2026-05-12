import { ConsoleBillingProvider } from './console.billing-provider';

describe('ConsoleBillingProvider', () => {
  let provider: ConsoleBillingProvider;

  beforeEach(() => {
    provider = new ConsoleBillingProvider({ returnUrl: 'https://k.test/return' });
  });

  it('createPreapproval gera id determinístico baseado em tenantId + counter e devolve initPoint', async () => {
    const a = await provider.createPreapproval({
      tenantId: 't1',
      tenantSlug: 's1',
      payerEmail: 'a@x.com',
      reason: 'r',
      amountCents: 4990,
      frequency: 'months',
    });
    const b = await provider.createPreapproval({
      tenantId: 't1',
      tenantSlug: 's1',
      payerEmail: 'a@x.com',
      reason: 'r',
      amountCents: 4990,
      frequency: 'months',
    });
    expect(a.preapprovalId).not.toBe(b.preapprovalId);
    expect(a.initPoint).toContain(a.preapprovalId);
  });

  it('fetchPreapproval devolve status corrente do store em memória; default pending', async () => {
    const { preapprovalId } = await provider.createPreapproval({
      tenantId: 't1',
      tenantSlug: 's1',
      payerEmail: 'a@x.com',
      reason: 'r',
      amountCents: 4990,
      frequency: 'months',
    });
    expect((await provider.fetchPreapproval(preapprovalId)).status).toBe('pending');
  });

  it('__test_advance força transição visível pra fetchPreapproval', async () => {
    const { preapprovalId } = await provider.createPreapproval({
      tenantId: 't1',
      tenantSlug: 's1',
      payerEmail: 'a@x.com',
      reason: 'r',
      amountCents: 4990,
      frequency: 'months',
    });
    provider.__test_advance(preapprovalId, 'authorized', new Date('2026-06-01T00:00:00Z'));
    const after = await provider.fetchPreapproval(preapprovalId);
    expect(after.status).toBe('authorized');
    expect(after.nextPaymentDate).toEqual(new Date('2026-06-01T00:00:00Z'));
  });

  it('cancelPreapproval marca cancelled mesmo se preapproval desconhecido', async () => {
    await expect(provider.cancelPreapproval('PRE-NA')).resolves.toBeUndefined();
    const { preapprovalId } = await provider.createPreapproval({
      tenantId: 't1',
      tenantSlug: 's1',
      payerEmail: 'a@x.com',
      reason: 'r',
      amountCents: 4990,
      frequency: 'months',
    });
    await provider.cancelPreapproval(preapprovalId);
    expect((await provider.fetchPreapproval(preapprovalId)).status).toBe('cancelled');
  });

  it('listPayments respeita page/pageSize sobre o array adicionado via __test_addPayment', async () => {
    const { preapprovalId } = await provider.createPreapproval({
      tenantId: 't1',
      tenantSlug: 's1',
      payerEmail: 'a@x.com',
      reason: 'r',
      amountCents: 4990,
      frequency: 'months',
    });
    for (let i = 0; i < 5; i++) {
      provider.__test_addPayment(preapprovalId, {
        id: `P-${i}`,
        amountCents: 4990,
        status: 'approved',
        paidAt: new Date(`2026-0${i + 1}-01T00:00:00Z`),
        dueAt: new Date(`2026-0${i + 1}-01T00:00:00Z`),
      });
    }
    const page1 = await provider.listPayments(preapprovalId, { page: 1, pageSize: 2 });
    const page2 = await provider.listPayments(preapprovalId, { page: 2, pageSize: 2 });
    expect(page1.map((p) => p.id)).toEqual(['P-0', 'P-1']);
    expect(page2.map((p) => p.id)).toEqual(['P-2', 'P-3']);
  });
});
