import { AuditService } from 'src/common/audit/audit.service';
import { SaasTenantsService } from './saas-tenants.service';
import { SaasTenantRepository } from '../repositories/saas-tenant.repository';

describe('SaasTenantsService', () => {
  let repo: jest.Mocked<
    Pick<SaasTenantRepository, 'list' | 'findOneDetailed' | 'findById' | 'setSuspended'>
  >;
  let audit: jest.Mocked<Pick<AuditService, 'record'>>;
  let svc: SaasTenantsService;
  let quota: { resolveLimit: jest.Mock };

  beforeEach(() => {
    repo = {
      list: jest.fn(),
      findOneDetailed: jest.fn(),
      findById: jest.fn(),
      setSuspended: jest.fn(),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    quota = {
      resolveLimit: jest.fn((status: string) =>
        status === 'trialing' ? 10 : status === 'active' ? 30 : 0,
      ),
    };
    svc = new SaasTenantsService(
      repo as unknown as SaasTenantRepository,
      audit as unknown as AuditService,
      quota as never,
    );
  });

  it('list mapeia rows e retorna paginação', async () => {
    repo.list.mockResolvedValueOnce({
      total: 1,
      rows: [
        {
          id: 't1',
          slug: 'a',
          name: 'A',
          suspendedAt: null,
          createdAt: new Date('2026-01-01'),
          owner: { email: 'owner@a.com' },
          subscription: {
            status: 'active',
            trialEndsAt: null,
            currentPeriodEnd: new Date('2026-06-01'),
          },
        } as never,
      ],
    });
    const res = await svc.list({ page: 1, pageSize: 20, status: 'all' });
    expect(res.total).toBe(1);
    expect(res.data[0]).toMatchObject({ id: 't1', ownerEmail: 'owner@a.com' });
  });

  it('detail lança 404 quando tenant não existe', async () => {
    repo.findOneDetailed.mockResolvedValueOnce(null);
    await expect(svc.detail('nope')).rejects.toMatchObject({
      opts: { code: 'SAAS_TENANT_NOT_FOUND' },
    });
  });

  it('suspend lança 404 quando tenant não existe', async () => {
    repo.findById.mockResolvedValueOnce(null);
    await expect(svc.suspend('nope', 'admin1')).rejects.toMatchObject({
      opts: { code: 'SAAS_TENANT_NOT_FOUND' },
    });
  });

  it('suspend lança 409 quando tenant já está suspenso', async () => {
    repo.findById.mockResolvedValueOnce({ id: 't1', suspendedAt: new Date(), slug: 's' });
    await expect(svc.suspend('t1', 'admin1')).rejects.toMatchObject({
      opts: { code: 'TENANT_ALREADY_SUSPENDED' },
    });
  });

  it('suspend chama repo.setSuspended e audit.record', async () => {
    repo.findById.mockResolvedValueOnce({ id: 't1', suspendedAt: null, slug: 's' });
    repo.setSuspended.mockResolvedValueOnce({
      id: 't1',
      suspendedAt: new Date('2026-05-12'),
    });
    const res = await svc.suspend('t1', 'admin1');
    expect(repo.setSuspended).toHaveBeenCalledWith('t1', expect.any(Date));
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'tenant.suspended',
        tenantId: 't1',
        actorUserId: 'admin1',
      }),
    );
    expect(res.suspendedAt).toBeTruthy();
  });

  it('unsuspend lança 409 quando tenant não está suspenso', async () => {
    repo.findById.mockResolvedValueOnce({ id: 't1', suspendedAt: null, slug: 's' });
    await expect(svc.unsuspend('t1', 'admin1')).rejects.toMatchObject({
      opts: { code: 'TENANT_NOT_SUSPENDED' },
    });
  });

  it('unsuspend chama repo.setSuspended(null) e audit.record', async () => {
    repo.findById.mockResolvedValueOnce({ id: 't1', suspendedAt: new Date(), slug: 's' });
    repo.setSuspended.mockResolvedValueOnce({ id: 't1', suspendedAt: null });
    await svc.unsuspend('t1', 'admin1');
    expect(repo.setSuspended).toHaveBeenCalledWith('t1', null);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'tenant.unsuspended', tenantId: 't1' }),
    );
  });

  it('detail inclui aiQuotaLimit=10 em subscription trialing', async () => {
    repo.findOneDetailed.mockResolvedValueOnce({
      tenant: {
        id: 't1',
        slug: 'demo',
        name: 'Demo',
        bio: null,
        owner: { email: 'a@b.c' },
        suspendedAt: null,
        createdAt: new Date(),
        subscription: {
          status: 'trialing',
          trialEndsAt: new Date(),
          currentPeriodEnd: null,
          mpPreapprovalId: null,
          aiQuotaUsedThisMonth: 2,
        },
      },
      counters: {},
    } as never);
    const result = await svc.detail('t1');
    expect(result.subscription).toMatchObject({
      status: 'trialing',
      aiQuotaUsedThisMonth: 2,
      aiQuotaLimit: 10,
    });
  });

  it('detail inclui aiQuotaLimit=30 em subscription active', async () => {
    repo.findOneDetailed.mockResolvedValueOnce({
      tenant: {
        id: 't2',
        slug: 'pago',
        name: 'Pago',
        bio: null,
        owner: { email: 'a@b.c' },
        suspendedAt: null,
        createdAt: new Date(),
        subscription: {
          status: 'active',
          trialEndsAt: null,
          currentPeriodEnd: new Date(),
          mpPreapprovalId: 'pp_x',
          aiQuotaUsedThisMonth: 18,
        },
      },
      counters: {},
    } as never);
    const result = await svc.detail('t2');
    expect(result.subscription).toMatchObject({ aiQuotaLimit: 30 });
  });
});
