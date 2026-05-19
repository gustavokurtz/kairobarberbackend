import { Body, Controller, Get, HttpCode, HttpStatus, Patch, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { TenantGuard } from 'src/common/guards/tenant.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { Roles } from 'src/common/decorators/roles.decorator';
import { CurrentTenant } from 'src/common/decorators/current-tenant.decorator';
import { TenantsService } from './tenants.service';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { UpdateBusinessHoursDto } from './dto/update-business-hours.dto';

@Controller('admin/tenant')
@UseGuards(TenantGuard, RolesGuard)
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Get()
  async getCurrent(@CurrentTenant() tenantId: string) {
    const t = await this.tenants.getCurrent(tenantId);
    return {
      id: t.id,
      slug: t.slug,
      name: t.name,
      bio: t.bio,
      address: t.address,
      phone: t.phone,
      documentNumber: t.documentNumber,
      avatarUrl: t.avatarUrl,
      timezone: t.timezone,
      businessHours: t.businessHours ?? null,
      subscription: t.subscription
        ? {
            status: t.subscription.status,
            trialEndsAt: t.subscription.trialEndsAt,
            currentPeriodEnd: t.subscription.currentPeriodEnd,
          }
        : null,
    };
  }

  @Patch()
  @Roles(UserRole.tenant_owner)
  @HttpCode(HttpStatus.OK)
  async update(@CurrentTenant() tenantId: string, @Body() dto: UpdateTenantDto) {
    const t = await this.tenants.update(tenantId, dto);
    return {
      id: t.id,
      slug: t.slug,
      name: t.name,
      bio: t.bio,
      address: t.address,
      phone: t.phone,
      documentNumber: t.documentNumber,
      avatarUrl: t.avatarUrl,
      timezone: t.timezone,
      businessHours: t.businessHours ?? null,
    };
  }

  @Patch('business-hours')
  @Roles(UserRole.tenant_owner)
  @HttpCode(HttpStatus.OK)
  async updateBusinessHours(
    @CurrentTenant() tenantId: string,
    @Body() dto: UpdateBusinessHoursDto,
  ) {
    const t = await this.tenants.updateBusinessHours(tenantId, dto.businessHours);
    return { businessHours: t.businessHours };
  }

  @Get('subscription-debug')
  async listMy(@CurrentTenant() _tenantId: string) {
    return this.tenants.listMySubscription();
  }
}
