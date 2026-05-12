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
import { ListAiUsageQueryDto } from './dto/list-ai-usage-query.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { ListAuditLogQueryDto } from './dto/list-audit-log-query.dto';
import { SaasTenantsService } from './services/saas-tenants.service';
import { SaasMetricsService } from './services/saas-metrics.service';
import { SaasAiUsageService } from './services/saas-ai-usage.service';
import { SaasUsersService } from './services/saas-users.service';
import { SaasAuditService } from './services/saas-audit.service';

@Controller('saas')
@UseGuards(RolesGuard)
@Roles(UserRole.saas_owner)
export class SaasAdminController {
  constructor(
    private readonly tenants: SaasTenantsService,
    private readonly metrics: SaasMetricsService,
    private readonly aiUsage: SaasAiUsageService,
    private readonly users: SaasUsersService,
    private readonly auditLogService: SaasAuditService,
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

  @Get('ai-usage')
  listAiUsage(@Query() q: ListAiUsageQueryDto) {
    return this.aiUsage.snapshot({ page: q.page, pageSize: q.pageSize, detailed: q.detailed });
  }

  @Get('users')
  listUsers(@Query() q: ListUsersQueryDto) {
    return this.users.list({
      page: q.page,
      pageSize: q.pageSize,
      role: q.role,
      search: q.search,
    });
  }

  @Get('audit-log')
  listAuditLog(@Query() q: ListAuditLogQueryDto) {
    return this.auditLogService.list({
      page: q.page,
      pageSize: q.pageSize,
      tenantId: q.tenantId,
      actorUserId: q.actorUserId,
      action: q.action,
      from: q.from,
      to: q.to,
    });
  }
}
