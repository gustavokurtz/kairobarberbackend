import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { QuotaRepository } from './quota.repository';

@Injectable()
export class QuotaService {
  private readonly limit: number;

  constructor(
    private readonly repo: QuotaRepository,
    cfg: ConfigService,
    private readonly logger: Logger,
  ) {
    this.limit = cfg.getOrThrow<number>('AI_VISAGISM_MONTHLY_QUOTA');
  }

  /** @throws DomainException(AI_QUOTA_EXCEEDED) se cota esgotada. */
  async chargeOrThrow(tenantId: string): Promise<{ used: number; limit: number }> {
    const used = await this.repo.tryIncrement(tenantId, this.limit);
    if (used === null) {
      throw new DomainException({
        code: ErrorCodes.AI_QUOTA_EXCEEDED,
        message: `Cota mensal de consultas de IA esgotada (${this.limit}).`,
        status: HttpStatus.TOO_MANY_REQUESTS,
        details: { limit: this.limit },
      });
    }
    return { used, limit: this.limit };
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

  get monthlyLimit(): number {
    return this.limit;
  }
}
