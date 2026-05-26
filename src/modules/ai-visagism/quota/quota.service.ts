import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { QuotaRepository } from './quota.repository';

@Injectable()
export class QuotaService {
  private readonly trialQuota: number;
  private readonly activeQuota: number;

  constructor(
    private readonly repo: QuotaRepository,
    cfg: ConfigService,
    private readonly logger: Logger,
  ) {
    this.trialQuota = cfg.getOrThrow<number>('AI_VISAGISM_TRIAL_QUOTA');
    this.activeQuota = cfg.getOrThrow<number>('AI_VISAGISM_ACTIVE_QUOTA');
  }

  /**
   * Débito atômico: incrementa aiQuotaUsedThisMonth se used < limite-do-status.
   * Limite é resolvido no SQL via CASE.
   *
   * @throws DomainException(AI_QUOTA_EXCEEDED, 429) se estourou.
   */
  async chargeOrThrow(
    tenantId: string,
  ): Promise<{ used: number; limit: number; status: string }> {
    const charged = await this.repo.tryIncrement(tenantId, this.trialQuota, this.activeQuota);
    if (charged) {
      const limit = this.resolveLimit(charged.status);
      return { used: charged.used, limit, status: charged.status };
    }

    // Caminho de erro: SELECT auxiliar pra montar a mensagem com o limit correto.
    const status = await this.repo.getStatus(tenantId);
    const limit = status ? this.resolveLimit(status) : 0;
    throw new DomainException({
      code: ErrorCodes.AI_QUOTA_EXCEEDED,
      message: `Cota mensal de consultas de IA esgotada (${limit}).`,
      status: HttpStatus.TOO_MANY_REQUESTS,
      details: { limit },
    });
  }

  async refund(tenantId: string): Promise<void> {
    try {
      await this.repo.refund(tenantId);
    } catch (err) {
      this.logger.warn({
        event: 'ai_visagism.quota_refund_failed',
        tenantId,
        error: (err as Error).message,
      });
    }
  }

  async resetAll(): Promise<number> {
    const count = await this.repo.resetAll();
    this.logger.log({ event: 'ai_visagism.quota_reset', count });
    return count;
  }

  /** Helper público pros services SaaS (ai-usage, tenant detail) resolverem o limite a partir do status. */
  resolveLimit(status: string): number {
    if (status === 'trialing') return this.trialQuota;
    if (status === 'active') return this.activeQuota;
    return 0;
  }

  get trialLimit(): number {
    return this.trialQuota;
  }

  get activeLimit(): number {
    return this.activeQuota;
  }
}
