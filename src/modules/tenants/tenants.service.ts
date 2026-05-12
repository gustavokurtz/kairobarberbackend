import { HttpStatus, Injectable } from '@nestjs/common';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { TenantRepository } from './repositories/tenant.repository';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { validateBusinessHours } from './business-hours';

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

  async update(tenantId: string, dto: UpdateTenantDto) {
    await this.getCurrent(tenantId); // 404 se não existe
    return this.repo.update(tenantId, dto);
  }

  async updateBusinessHours(tenantId: string, businessHours: unknown) {
    await this.getCurrent(tenantId);
    validateBusinessHours(businessHours);
    return this.repo.update(tenantId, {
      businessHours: businessHours,
    });
  }

  listMySubscription() {
    return this.prisma.scoped.subscription.findMany({});
  }
}
