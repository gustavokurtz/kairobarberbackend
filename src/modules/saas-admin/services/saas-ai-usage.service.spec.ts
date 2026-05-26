import { SaasAiUsageService } from './saas-ai-usage.service';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AiConsultationRepository } from 'src/modules/ai-visagism/repositories/ai-consultation.repository';
import { QuotaService } from 'src/modules/ai-visagism/quota/quota.service';

function makeService() {
  const findMany = jest.fn();
  const count = jest.fn();
  const prisma = {
    subscription: { findMany, count },
  } as unknown as PrismaService;
  const aiRepo = {
    listRecentByTenant: jest.fn(),
  } as unknown as AiConsultationRepository;
  const quota = {
    resolveLimit: (status: string) =>
      status === 'trialing' ? 10 : status === 'active' ? 30 : 0,
  } as unknown as QuotaService;
  const service = new SaasAiUsageService(prisma, aiRepo, quota);
  return { service, findMany, count };
}

describe('SaasAiUsageService.snapshot', () => {
  it('inclui aiQuotaLimit=10 pra tenant trialing', async () => {
    const { service, findMany, count } = makeService();
    findMany.mockResolvedValue([
      {
        aiQuotaUsedThisMonth: 4,
        status: 'trialing',
        tenant: { id: 't1', slug: 'demo', name: 'Demo' },
      },
    ]);
    count.mockResolvedValue(1);

    const result = await service.snapshot({ page: 1, pageSize: 10 });

    expect(result.data[0]).toMatchObject({
      tenantId: 't1',
      tenantSlug: 'demo',
      tenantName: 'Demo',
      aiQuotaUsedThisMonth: 4,
      aiQuotaLimit: 10,
    });
  });

  it('inclui aiQuotaLimit=30 pra tenant active', async () => {
    const { service, findMany, count } = makeService();
    findMany.mockResolvedValue([
      {
        aiQuotaUsedThisMonth: 15,
        status: 'active',
        tenant: { id: 't2', slug: 'pago', name: 'Pago' },
      },
    ]);
    count.mockResolvedValue(1);

    const result = await service.snapshot({ page: 1, pageSize: 10 });

    expect(result.data[0]).toMatchObject({ aiQuotaLimit: 30 });
  });
});
