import { Controller, Get, HttpStatus, Param, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentTenant } from 'src/common/decorators/current-tenant.decorator';
import { Public } from 'src/common/decorators/public.decorator';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { BarberRepository } from 'src/modules/barbers/repositories/barber.repository';
import { TimeOffRepository } from 'src/modules/barbers/repositories/time-off.repository';
import { ServiceRepository } from 'src/modules/catalog/repositories/service.repository';
import { AppointmentRepository } from 'src/modules/scheduling/repositories/appointment.repository';
import { AvailabilityService } from 'src/modules/scheduling/availability.service';
import {
  BUSINESS_HOURS_EMPTY,
  validateBusinessHours,
  type BusinessHours,
} from 'src/modules/tenants/business-hours';
import { TenantRepository } from 'src/modules/tenants/repositories/tenant.repository';
import { AvailabilityQueryDto } from './dto/availability-query.dto';

@Controller('public/:slug/availability')
@Public()
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class PublicAvailabilityController {
  constructor(
    private readonly tenants: TenantRepository,
    private readonly barbers: BarberRepository,
    private readonly services: ServiceRepository,
    private readonly timeOffs: TimeOffRepository,
    private readonly appointments: AppointmentRepository,
    private readonly availability: AvailabilityService,
  ) {}

  @Get('by-barber/:barberId')
  async byBarber(
    @Param('slug') _slug: string,
    @Param('barberId') barberId: string,
    @Query() q: AvailabilityQueryDto,
    @CurrentTenant() tenantId: string,
  ) {
    if (!q.serviceId) {
      throw new DomainException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'serviceId é obrigatório nesta rota.',
        status: HttpStatus.BAD_REQUEST,
      });
    }
    const [tenant, barber, service, timeOffs, appts] = await Promise.all([
      this.tenants.findById(tenantId),
      this.barbers.findById(barberId),
      this.services.findById(q.serviceId),
      this.timeOffs.listForBarber(barberId),
      this.appointments.findActiveForBarberInRange(barberId, q.from, q.to),
    ]);
    if (!tenant || !barber || !service) {
      throw new DomainException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Recurso não encontrado.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    const businessHours = this.parseBh(tenant.businessHours);
    const slots = this.availability.computeSlots({
      tenantTimezone: tenant.timezone,
      businessHours,
      durationMin: service.durationMin,
      barberId,
      timeOffs: timeOffs.map((t) => ({ barberId, startsAt: t.startsAt, endsAt: t.endsAt })),
      appointments: appts.map((a) => ({ barberId, startsAt: a.startsAt, endsAt: a.endsAt })),
      from: q.from,
      to: q.to,
    });
    return slots.map((s) => ({ startsAt: s.startsAt, endsAt: s.endsAt }));
  }

  @Get('by-service/:serviceId')
  async byService(
    @Param('slug') _slug: string,
    @Param('serviceId') serviceId: string,
    @Query() q: AvailabilityQueryDto,
    @CurrentTenant() tenantId: string,
  ) {
    const [tenant, service] = await Promise.all([
      this.tenants.findById(tenantId),
      this.services.findById(serviceId),
    ]);
    if (!tenant || !service) {
      throw new DomainException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Recurso não encontrado.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    const barberIds = service.serviceBarbers
      .map((sb) => sb.barberId)
      .filter((id, idx, self) => self.indexOf(id) === idx);
    const businessHours = this.parseBh(tenant.businessHours);

    const timeOffsByBarber: Record<string, { barberId: string; startsAt: Date; endsAt: Date }[]> =
      {};
    const appointmentsByBarber: Record<
      string,
      { barberId: string; startsAt: Date; endsAt: Date }[]
    > = {};
    await Promise.all(
      barberIds.map(async (bid) => {
        const [tos, apts] = await Promise.all([
          this.timeOffs.listForBarber(bid),
          this.appointments.findActiveForBarberInRange(bid, q.from, q.to),
        ]);
        timeOffsByBarber[bid] = tos.map((t) => ({
          barberId: bid,
          startsAt: t.startsAt,
          endsAt: t.endsAt,
        }));
        appointmentsByBarber[bid] = apts.map((a) => ({
          barberId: bid,
          startsAt: a.startsAt,
          endsAt: a.endsAt,
        }));
      }),
    );

    const groups = this.availability.getAvailabilityByService({
      tenantTimezone: tenant.timezone,
      businessHours,
      durationMin: service.durationMin,
      barberIds,
      timeOffsByBarber,
      appointmentsByBarber,
      from: q.from,
      to: q.to,
    });
    return groups.map((g) => ({
      barberId: g.barberId,
      slots: g.slots.map((s) => ({ startsAt: s.startsAt, endsAt: s.endsAt })),
    }));
  }

  private parseBh(raw: unknown): BusinessHours {
    if (!raw) return BUSINESS_HOURS_EMPTY;
    validateBusinessHours(raw);
    return raw;
  }
}
