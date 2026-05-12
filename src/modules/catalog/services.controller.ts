import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { TenantGuard } from 'src/common/guards/tenant.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { Roles } from 'src/common/decorators/roles.decorator';
import { CurrentTenant } from 'src/common/decorators/current-tenant.decorator';
import { ServicesService } from './services.service';
import { CreateServiceDto } from './dto/create-service.dto';
import { UpdateServiceDto } from './dto/update-service.dto';
import { SetServiceBarbersDto } from './dto/set-service-barbers.dto';

@Controller('admin/services')
@UseGuards(TenantGuard, RolesGuard)
export class ServicesController {
  constructor(private readonly services: ServicesService) {}

  @Get()
  list() {
    return this.services.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.services.getById(id);
  }

  @Post()
  @Roles(UserRole.tenant_owner)
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateServiceDto) {
    return this.services.create(dto);
  }

  @Patch(':id')
  @Roles(UserRole.tenant_owner)
  update(@Param('id') id: string, @Body() dto: UpdateServiceDto) {
    return this.services.update(id, dto);
  }

  @Delete(':id')
  @Roles(UserRole.tenant_owner)
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Param('id') id: string) {
    await this.services.softDelete(id);
  }

  @Put(':id/barbers')
  @Roles(UserRole.tenant_owner)
  @HttpCode(HttpStatus.OK)
  setBarbers(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @Body() dto: SetServiceBarbersDto,
  ) {
    return this.services.setBarbers(id, tenantId, dto.barberIds);
  }
}
