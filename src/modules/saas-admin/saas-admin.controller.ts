import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { ListTenantsQueryDto } from './dto/list-tenants-query.dto';
import { SaasTenantsService } from './services/saas-tenants.service';

@Controller('saas')
@UseGuards(RolesGuard)
@Roles(UserRole.saas_owner)
export class SaasAdminController {
  constructor(private readonly tenants: SaasTenantsService) {}

  @Get('ping')
  ping() {
    return { ok: true };
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
}
