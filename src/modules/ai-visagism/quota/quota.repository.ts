import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class QuotaRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Incremento atômico: só incrementa se `aiQuotaUsedThisMonth < limit`.
   * Retorna o novo valor, ou null se a cota estava esgotada.
   */
  async tryIncrement(tenantId: string, limit: number): Promise<number | null> {
    const rows = await this.prisma.$queryRaw<{ ai_quota_used_this_month: number }[]>`
      UPDATE "Subscription"
      SET "aiQuotaUsedThisMonth" = "aiQuotaUsedThisMonth" + 1,
          "updatedAt" = NOW()
      WHERE "tenantId" = ${tenantId}
        AND "aiQuotaUsedThisMonth" < ${limit}
      RETURNING "aiQuotaUsedThisMonth" AS ai_quota_used_this_month
    `;
    return rows[0]?.ai_quota_used_this_month ?? null;
  }

  /**
   * Reembolso (em caso de falha do job). Nunca abaixo de zero.
   */
  async refund(tenantId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "Subscription"
      SET "aiQuotaUsedThisMonth" = GREATEST("aiQuotaUsedThisMonth" - 1, 0),
          "updatedAt" = NOW()
      WHERE "tenantId" = ${tenantId}
    `;
  }

  /**
   * Reset mensal — chamado pelo cron `monthly-quota-reset`.
   * Retorna número de subscriptions resetadas.
   */
  async resetAll(): Promise<number> {
    const r = await this.prisma.subscription.updateMany({
      where: { aiQuotaUsedThisMonth: { gt: 0 } },
      data: { aiQuotaUsedThisMonth: 0 },
    });
    return r.count;
  }
}
