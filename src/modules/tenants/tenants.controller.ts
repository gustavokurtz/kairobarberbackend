import { Controller, Get, UseGuards } from '@nestjs/common';
import { TenantGuard } from 'src/common/guards/tenant.guard';
import { CurrentTenant } from 'src/common/decorators/current-tenant.decorator';
import { TenantsService } from './tenants.service';

@Controller('admin/tenant')
@UseGuards(TenantGuard)
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Get()
  async getCurrent(@CurrentTenant() tenantId: string) {
    const t = await this.tenants.getCurrent(tenantId);
    return {
      id: t.id,
      slug: t.slug,
      name: t.name,
      timezone: t.timezone,
      subscription: t.subscription
        ? {
            status: t.subscription.status,
            trialEndsAt: t.subscription.trialEndsAt,
            currentPeriodEnd: t.subscription.currentPeriodEnd,
          }
        : null,
    };
  }

  @Get('subscription-debug')
  async listMy(@CurrentTenant() _tenantId: string) {
    // _tenantId é ignorado: o middleware Prisma já filtra. Param existe pra forçar TenantGuard.
    return this.tenants.listMySubscription();
  }
}
