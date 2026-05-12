import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentTenant } from 'src/common/decorators/current-tenant.decorator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { TenantGuard } from 'src/common/guards/tenant.guard';
import type { AuthenticatedUser } from 'src/common/types/request-context';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CustomersService } from 'src/modules/customers/customers.service';
import { AppointmentsService } from './appointments.service';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { ListAppointmentsQueryDto } from './dto/list-appointments-query.dto';
import { UpdateAppointmentDto } from './dto/update-appointment.dto';

@Controller('admin/appointments')
@UseGuards(TenantGuard, RolesGuard)
export class AppointmentsController {
  constructor(
    private readonly appointments: AppointmentsService,
    private readonly customers: CustomersService,
    private readonly prisma: PrismaService,
  ) {}

  private async ownsOrThrow(user: AuthenticatedUser | undefined, appointmentBarberId: string) {
    if (!user) throw new ForbiddenException();
    if (user.role === UserRole.tenant_owner) return;
    const barber = await this.prisma.scoped.barber.findFirst({ where: { userId: user.id } });
    if (!barber || barber.id !== appointmentBarberId) {
      throw new ForbiddenException('Barbeiros só agem sobre os próprios agendamentos.');
    }
  }

  @Get()
  async list(
    @Query() q: ListAppointmentsQueryDto,
    @CurrentUser() user: AuthenticatedUser | undefined,
  ) {
    let barberFilter = q.barberId;
    if (user?.role === UserRole.barber_member) {
      const me = await this.prisma.scoped.barber.findFirst({ where: { userId: user.id } });
      if (!me) throw new ForbiddenException();
      barberFilter = me.id;
    }
    return this.appointments.list({
      from: q.from,
      to: q.to,
      barberId: barberFilter,
      status: q.status,
    });
  }

  @Post()
  @Roles(UserRole.tenant_owner)
  @HttpCode(HttpStatus.CREATED)
  async create(@CurrentTenant() tenantId: string, @Body() dto: CreateAppointmentDto) {
    let customerId = dto.customerId;
    if (!customerId) {
      if (!dto.customer) {
        throw new DomainException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Forneça customerId ou customer.',
          status: HttpStatus.BAD_REQUEST,
        });
      }
      const { customer } = await this.customers.findOrCreateByPhone(dto.customer);
      customerId = customer.id;
    }
    const { appointment } = await this.appointments.createAdminBooking(tenantId, {
      serviceId: dto.serviceId,
      barberId: dto.barberId,
      startsAt: dto.startsAt,
      customer: { id: customerId },
    });
    return appointment;
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateAppointmentDto,
    @CurrentUser() user: AuthenticatedUser | undefined,
  ) {
    const apt = await this.appointments.getById(id);
    await this.ownsOrThrow(user, apt.barberId);
    return this.appointments.reschedule(id, dto.startsAt);
  }

  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  async confirm(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser | undefined) {
    const apt = await this.appointments.getById(id);
    await this.ownsOrThrow(user, apt.barberId);
    return this.appointments.confirm(id);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  async complete(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser | undefined) {
    const apt = await this.appointments.getById(id);
    await this.ownsOrThrow(user, apt.barberId);
    return this.appointments.complete(id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @Param('id') id: string,
    @Body() body: { reason?: string },
    @CurrentUser() user: AuthenticatedUser | undefined,
  ) {
    const apt = await this.appointments.getById(id);
    await this.ownsOrThrow(user, apt.barberId);
    return this.appointments.cancelByAdmin(id, body.reason);
  }

  @Post(':id/no-show')
  @HttpCode(HttpStatus.OK)
  async noShow(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser | undefined) {
    const apt = await this.appointments.getById(id);
    await this.ownsOrThrow(user, apt.barberId);
    return this.appointments.markNoShow(id);
  }
}
