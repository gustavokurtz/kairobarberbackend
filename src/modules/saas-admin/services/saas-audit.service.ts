import { Injectable } from '@nestjs/common';
import { AuditRepository } from 'src/common/audit/audit.repository';
import { AuditQuery } from 'src/common/audit/audit.types';

@Injectable()
export class SaasAuditService {
  constructor(private readonly repo: AuditRepository) {}

  list(q: AuditQuery) {
    return this.repo.listPaginated(q);
  }
}
