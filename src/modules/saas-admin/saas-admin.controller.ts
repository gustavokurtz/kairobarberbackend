import { Controller, Get, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesGuard } from 'src/common/guards/roles.guard';

@Controller('saas')
@UseGuards(RolesGuard)
@Roles(UserRole.saas_owner)
export class SaasAdminController {
  @Get('ping')
  ping() {
    return { ok: true };
  }
}
