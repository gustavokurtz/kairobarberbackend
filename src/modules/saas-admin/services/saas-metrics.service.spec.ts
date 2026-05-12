import { ConfigService } from '@nestjs/config';
import { SaasMetricsService } from './saas-metrics.service';
import { SaasSubscriptionRepository } from '../repositories/saas-subscription.repository';
import { PrismaService } from 'src/infra/prisma/prisma.service';

describe('SaasMetricsService', () => {
  it('calcula MRR, ARR, churn e conversão a partir de contagens', async () => {
    const subs = {
      countByStatus: jest.fn().mockImplementation((s: string) => (s === 'active' ? 10 : 0)),
      countActiveOrTrialing: jest.fn().mockResolvedValue(12),
    } as unknown as SaasSubscriptionRepository;

    const prisma = {
      auditLog: {
        count: jest
          .fn()
          // ordem: cancelledIn30d, activatedIn30d, trialsStartedIn60d
          .mockResolvedValueOnce(2)
          .mockResolvedValueOnce(3)
          .mockResolvedValueOnce(8),
      },
    } as unknown as PrismaService;

    const config = { get: jest.fn().mockReturnValue(4990) } as unknown as ConfigService;
    const svc = new SaasMetricsService(subs, prisma, config);

    const res = await svc.dashboard(new Date('2026-05-12T00:00:00Z'));
    expect(res.mrrCents).toBe(10 * 4990);
    expect(res.arrCents).toBe(10 * 4990 * 12);
    expect(res.tenantsActive).toBe(12);
    expect(res.churn30d).toBeCloseTo(2 / (10 + 2), 4);
    expect(res.trialConversion30d).toBeCloseTo(3 / 8, 4);
  });

  it('retorna 0 em vez de NaN quando denominadores são 0', async () => {
    const subs = {
      countByStatus: jest.fn().mockResolvedValue(0),
      countActiveOrTrialing: jest.fn().mockResolvedValue(0),
    } as unknown as SaasSubscriptionRepository;
    const prisma = {
      auditLog: { count: jest.fn().mockResolvedValue(0) },
    } as unknown as PrismaService;
    const config = { get: jest.fn().mockReturnValue(4990) } as unknown as ConfigService;
    const svc = new SaasMetricsService(subs, prisma, config);
    const res = await svc.dashboard();
    expect(res.churn30d).toBe(0);
    expect(res.trialConversion30d).toBe(0);
  });
});
