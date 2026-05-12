import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesGuard } from 'src/common/guards/roles.guard';
import type { AuthenticatedUser } from 'src/common/types/request-context';
import { ListTenantsQueryDto } from './dto/list-tenants-query.dto';
import { SaasTenantsService } from './services/saas-tenants.service';
import { SaasMetricsService } from './services/saas-metrics.service';

@Controller('saas')
@UseGuards(RolesGuard)
@Roles(UserRole.saas_owner)
export class SaasAdminController {
  constructor(
    private readonly tenants: SaasTenantsService,
    private readonly metrics: SaasMetricsService,
  ) {}

  @Get('ping')
  ping() {
    return { ok: true };
  }

  @Get('dashboard')
  dashboard() {
    return this.metrics.dashboard();
  }

  @Get('tenants')
  listTenants(@Query() q: ListTenantsQueryDto) {
    return this.tenants.list({
      page: q.page,
      pageSize: q.pageSize,
      status: q.status,
      suspended: q.suspended,
      search: q.search,
    });
  }

  @Get('tenants/:id')
  detailTenant(@Param('id') id: string) {
    return this.tenants.detail(id);
  }

  @Post('tenants/:id/suspend')
  @HttpCode(HttpStatus.OK)
  suspendTenant(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.tenants.suspend(id, user.id);
  }

  @Post('tenants/:id/unsuspend')
  @HttpCode(HttpStatus.OK)
  unsuspendTenant(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.tenants.unsuspend(id, user.id);
  }
}
