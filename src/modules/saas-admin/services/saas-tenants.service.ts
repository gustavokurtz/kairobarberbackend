import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from 'src/common/audit/audit.service';
import { AuditActions } from 'src/common/audit/audit-actions';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import {
  ListTenantsArgs,
  SaasTenantRepository,
} from '../repositories/saas-tenant.repository';

@Injectable()
export class SaasTenantsService {
  constructor(
    private readonly repo: SaasTenantRepository,
    private readonly audit: AuditService,
  ) {}

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

  async suspend(id: string, actorUserId: string) {
    const t = await this.repo.findById(id);
    if (!t) {
      throw new DomainException({
        code: ErrorCodes.SAAS_TENANT_NOT_FOUND,
        message: 'Tenant não encontrado.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    if (t.suspendedAt) {
      throw new DomainException({
        code: ErrorCodes.TENANT_ALREADY_SUSPENDED,
        message: 'Tenant já está suspenso.',
        status: HttpStatus.CONFLICT,
      });
    }
    const updated = await this.repo.setSuspended(id, new Date());
    await this.audit.record({
      action: AuditActions.TENANT_SUSPENDED,
      tenantId: id,
      actorUserId,
      targetType: 'tenant',
      targetId: id,
    });
    return { id: updated.id, suspendedAt: updated.suspendedAt };
  }

  async unsuspend(id: string, actorUserId: string) {
    const t = await this.repo.findById(id);
    if (!t) {
      throw new DomainException({
        code: ErrorCodes.SAAS_TENANT_NOT_FOUND,
        message: 'Tenant não encontrado.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    if (!t.suspendedAt) {
      throw new DomainException({
        code: ErrorCodes.TENANT_NOT_SUSPENDED,
        message: 'Tenant não está suspenso.',
        status: HttpStatus.CONFLICT,
      });
    }
    const updated = await this.repo.setSuspended(id, null);
    await this.audit.record({
      action: AuditActions.TENANT_UNSUSPENDED,
      tenantId: id,
      actorUserId,
      targetType: 'tenant',
      targetId: id,
    });
    return { id: updated.id, suspendedAt: updated.suspendedAt };
  }
}
