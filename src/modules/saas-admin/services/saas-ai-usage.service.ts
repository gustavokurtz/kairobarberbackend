import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AiConsultationRepository } from 'src/modules/ai-visagism/repositories/ai-consultation.repository';

@Injectable()
export class SaasAiUsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRepo: AiConsultationRepository,
  ) {}

  async snapshot(args: { page: number; pageSize: number; detailed?: boolean }) {
    const now = new Date();
    const windowMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

    const [rows, total] = await Promise.all([
      this.prisma.subscription.findMany({
        where: { aiQuotaUsedThisMonth: { gt: 0 } },
        orderBy: { aiQuotaUsedThisMonth: 'desc' },
        skip: (args.page - 1) * args.pageSize,
        take: args.pageSize,
        include: { tenant: { select: { id: true, slug: true, name: true } } },
      }),
      this.prisma.subscription.count({ where: { aiQuotaUsedThisMonth: { gt: 0 } } }),
    ]);

    const items: Array<Record<string, unknown>> = rows.map((s) => ({
      tenantId: s.tenant.id,
      tenantSlug: s.tenant.slug,
      tenantName: s.tenant.name,
      aiQuotaUsedThisMonth: s.aiQuotaUsedThisMonth,
    }));

    if (args.detailed) {
      for (const item of items) {
        const recent = await this.aiRepo.listRecentByTenant(item.tenantId as string, 50);
        item.recentConsultations = recent.map((r) => ({
          id: r.id,
          status: r.status,
          providerCostCents: r.providerCostCents,
          createdAt: r.createdAt.toISOString(),
          expiredAt: r.expiredAt?.toISOString() ?? null,
        }));
      }
    }

    return {
      windowMonth,
      page: args.page,
      pageSize: args.pageSize,
      total,
      data: items,
    };
  }
}
