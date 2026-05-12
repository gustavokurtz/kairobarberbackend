import { HttpStatus, Injectable } from '@nestjs/common';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import {
  ListTenantsArgs,
  SaasTenantRepository,
} from '../repositories/saas-tenant.repository';

@Injectable()
export class SaasTenantsService {
  constructor(private readonly repo: SaasTenantRepository) {}

  async list(args: ListTenantsArgs) {
    const { rows, total } = await this.repo.list(args);
    return {
      page: args.page,
      pageSize: args.pageSize,
      total,
      data: rows.map((t) => ({
        id: t.id,
        slug: t.slug,
        name: t.name,
        ownerEmail: t.owner.email,
        suspendedAt: t.suspendedAt,
        createdAt: t.createdAt,
        subscription: t.subscription
          ? {
              status: t.subscription.status,
              trialEndsAt: t.subscription.trialEndsAt,
              currentPeriodEnd: t.subscription.currentPeriodEnd,
            }
          : null,
      })),
    };
  }

  async detail(id: string) {
    const res = await this.repo.findOneDetailed(id);
    if (!res) {
      throw new DomainException({
        code: ErrorCodes.SAAS_TENANT_NOT_FOUND,
        message: 'Tenant não encontrado.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    const t = res.tenant;
    return {
      id: t.id,
      slug: t.slug,
      name: t.name,
      bio: t.bio,
      ownerEmail: t.owner.email,
      suspendedAt: t.suspendedAt,
      createdAt: t.createdAt,
      subscription: t.subscription
        ? {
            status: t.subscription.status,
            trialEndsAt: t.subscription.trialEndsAt,
            currentPeriodEnd: t.subscription.currentPeriodEnd,
            mpPreapprovalId: t.subscription.mpPreapprovalId,
            aiQuotaUsedThisMonth: t.subscription.aiQuotaUsedThisMonth,
          }
        : null,
      counters: res.counters,
    };
  }
}
