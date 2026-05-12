import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class SaasAiUsageService {
  constructor(private readonly prisma: PrismaService) {}

  async snapshot(args: { page: number; pageSize: number }) {
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
    return {
      windowMonth,
      page: args.page,
      pageSize: args.pageSize,
      total,
      data: rows.map((s) => ({
        tenantId: s.tenant.id,
        tenantSlug: s.tenant.slug,
        tenantName: s.tenant.name,
        aiQuotaUsedThisMonth: s.aiQuotaUsedThisMonth,
      })),
    };
  }
}
