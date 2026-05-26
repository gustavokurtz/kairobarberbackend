import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class QuotaRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Incremento atômico com limite resolvido por status:
   *   - trialing → trialLimit
   *   - active   → activeLimit
   *   - past_due/cancelled → 0 (nunca incrementa; CASE retorna 0)
   *
   * Retorna { used, status } se incrementou; null se estourou (ou status não cobre).
   * Atomic via Postgres em 1 round-trip — sem race condition.
   */
  async tryIncrement(
    tenantId: string,
    trialLimit: number,
    activeLimit: number,
  ): Promise<{ used: number; status: string } | null> {
    const rows = await this.prisma.$queryRaw<
      { ai_quota_used_this_month: number; status: string }[]
    >`
      UPDATE "Subscription"
      SET "aiQuotaUsedThisMonth" = "aiQuotaUsedThisMonth" + 1,
          "updatedAt" = NOW()
      WHERE "tenantId" = ${tenantId}
        AND "aiQuotaUsedThisMonth" < (
          CASE "status"
            WHEN 'trialing' THEN ${trialLimit}::int
            WHEN 'active'   THEN ${activeLimit}::int
            ELSE 0
          END
        )
      RETURNING "aiQuotaUsedThisMonth" AS ai_quota_used_this_month,
                "status" AS status
    `;
    const row = rows[0];
    if (!row) return null;
    return { used: row.ai_quota_used_this_month, status: row.status };
  }

  /**
   * SELECT auxiliar usado apenas no caminho de erro 429,
   * pra montar a mensagem com o limite correto. Não usado no caminho feliz.
   */
  async getStatus(tenantId: string): Promise<string | null> {
    const row = await this.prisma.subscription.findUnique({
      where: { tenantId },
      select: { status: true },
    });
    return row?.status ?? null;
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
