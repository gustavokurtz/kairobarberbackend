import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { TenantGuard } from 'src/common/guards/tenant.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { Roles } from 'src/common/decorators/roles.decorator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import type { AuthenticatedUser } from 'src/common/types/request-context';
import { BarbersService } from './barbers.service';
import { CreateBarberDto } from './dto/create-barber.dto';
import { UpdateBarberDto } from './dto/update-barber.dto';

@Controller('admin/barbers')
@UseGuards(TenantGuard, RolesGuard)
export class BarbersController {
  constructor(private readonly barbers: BarbersService) {}

  @Get()
  list() {
    return this.barbers.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.barbers.getById(id);
  }

  @Post()
  @Roles(UserRole.tenant_owner)
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateBarberDto) {
    return this.barbers.create(dto);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateBarberDto,
    @CurrentUser() user: AuthenticatedUser | undefined,
  ) {
    if (!user) {
      throw new ForbiddenException('Usuário não autenticado.');
    }
    if (user.role === UserRole.barber_member) {
      const target = await this.barbers.getById(id);
      if (target.userId !== user.id) {
        throw new ForbiddenException('Barbeiros só editam o próprio perfil.');
      }
    }
    return this.barbers.update(id, dto);
  }

  @Delete(':id')
  @Roles(UserRole.tenant_owner)
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Param('id') id: string) {
    await this.barbers.softDelete(id);
  }
}
