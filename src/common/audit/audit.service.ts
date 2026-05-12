import { Injectable, Logger } from '@nestjs/common';
import { AuditRepository } from './audit.repository';
import { AuditRecordInput } from './audit.types';

@Injectable()
export class AuditService {
  constructor(
    private readonly repo: AuditRepository,
    private readonly logger: Logger,
  ) {}

  async record(input: AuditRecordInput): Promise<void> {
    try {
      await this.repo.insert(input);
    } catch (err) {
      this.logger.warn({
        event: 'audit.record_failed',
        action: input.action,
        tenantId: input.tenantId,
        error: (err as Error).message,
      });
      // engole — audit nunca quebra fluxo de negócio
    }
  }
}
