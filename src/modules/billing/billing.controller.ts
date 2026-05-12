import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AllowInactiveSubscription } from 'src/common/decorators/allow-inactive-subscription.decorator';
import { CurrentTenant } from 'src/common/decorators/current-tenant.decorator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { Roles } from 'src/common/decorators/roles.decorator';
import type { AuthenticatedUser } from 'src/common/types/request-context';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { BillingService } from './billing.service';
import { CancelSubscriptionDto } from './dto/cancel-subscription.dto';
import { CreateCheckoutDto } from './dto/create-checkout.dto';
import { ListInvoicesQueryDto } from './dto/list-invoices-query.dto';

@Controller('admin/billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('subscription')
  @AllowInactiveSubscription()
  async getSubscription(@CurrentTenant() tenantId: string) {
    return this.billing.getSubscription(tenantId);
  }

  @Post('checkout')
  @AllowInactiveSubscription()
  @Roles(UserRole.tenant_owner)
  @HttpCode(HttpStatus.OK)
  async checkout(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Body() _dto: CreateCheckoutDto,
  ) {
    if (!user) {
      throw new ForbiddenException('Usuário não autenticado.');
    }
    const [tenant, userRecord] = await Promise.all([
      this.prisma.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { slug: true },
      }),
      this.prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        select: { email: true },
      }),
    ]);
    return this.billing.createCheckout({
      tenantId,
      tenantSlug: tenant.slug,
      ownerEmail: userRecord.email,
    });
  }

  @Post('sync')
  @AllowInactiveSubscription()
  @HttpCode(HttpStatus.OK)
  async sync(@CurrentTenant() tenantId: string) {
    await this.billing.syncSubscription(tenantId);
    return this.billing.getSubscription(tenantId);
  }

  @Post('cancel')
  @Roles(UserRole.tenant_owner)
  @HttpCode(HttpStatus.OK)
  async cancel(@CurrentTenant() tenantId: string, @Body() _dto: CancelSubscriptionDto) {
    await this.billing.cancelSubscription(tenantId);
    return { ok: true };
  }

  @Get('invoices')
  async invoices(@CurrentTenant() tenantId: string, @Query() q: ListInvoicesQueryDto) {
    return this.billing.listInvoices(tenantId, q);
  }
}
