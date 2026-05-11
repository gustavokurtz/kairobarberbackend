import { HttpStatus, Injectable } from '@nestjs/common';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { TenantRepository } from './repositories/tenant.repository';

@Injectable()
export class TenantsService {
  constructor(
    private readonly repo: TenantRepository,
    private readonly prisma: PrismaService,
  ) {}

  async getCurrent(tenantId: string) {
    const t = await this.repo.findById(tenantId);
    if (!t || t.deletedAt) {
      throw new DomainException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Tenant não encontrado.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    return t;
  }

  /**
   * Demonstra leitura de subscriptions filtrada por tenant via Prisma extension.
   * Em produção, callers NUNCA devem ver subscriptions de outros tenants.
   * Usado pelo teste E2E de tenant isolation (Task 26).
   */
  listMySubscription() {
    return this.prisma.scoped.subscription.findMany({});
  }
}
