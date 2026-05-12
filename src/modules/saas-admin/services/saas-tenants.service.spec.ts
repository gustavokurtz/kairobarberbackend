import { SaasTenantsService } from './saas-tenants.service';
import { SaasTenantRepository } from '../repositories/saas-tenant.repository';

describe('SaasTenantsService', () => {
  let repo: jest.Mocked<Pick<SaasTenantRepository, 'list' | 'findOneDetailed'>>;
  let svc: SaasTenantsService;

  beforeEach(() => {
    repo = { list: jest.fn(), findOneDetailed: jest.fn() };
    svc = new SaasTenantsService(repo as unknown as SaasTenantRepository);
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
});
