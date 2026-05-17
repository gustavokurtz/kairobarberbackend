import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { Appointment } from '@prisma/client';
import { CurrentTenant } from 'src/common/decorators/current-tenant.decorator';
import { Public } from 'src/common/decorators/public.decorator';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { tenantAls } from 'src/infra/prisma/prisma.service';
import { BarberRepository } from 'src/modules/barbers/repositories/barber.repository';
import { ServiceRepository } from 'src/modules/catalog/repositories/service.repository';
import { CustomersService } from 'src/modules/customers/customers.service';
import { EMAIL_PROVIDER, type EmailProvider } from 'src/modules/notifications/email.provider';
import {
  appointmentConfirmationTemplate,
  customerClaimTemplate,
} from 'src/modules/notifications/templates';
import { AppointmentsService } from 'src/modules/scheduling/appointments.service';
import { CancellationService } from 'src/modules/scheduling/cancellation.service';
import { formatLocal, priceFormatBRL } from 'src/modules/scheduling/time-utils';
import { TenantRepository } from 'src/modules/tenants/repositories/tenant.repository';
import { CreatePublicAppointmentDto } from './dto/create-public-appointment.dto';

@Controller()
@Public()
export class PublicAppointmentsController {
  private readonly logger = new Logger(PublicAppointmentsController.name);

  constructor(
    private readonly tenants: TenantRepository,
    private readonly services: ServiceRepository,
    private readonly barbers: BarberRepository,
    private readonly customers: CustomersService,
    private readonly appointments: AppointmentsService,
    private readonly cancellation: CancellationService,
    private readonly cfg: ConfigService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
  ) {}

  @Post('public/:slug/appointments')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param('slug') slug: string,
    @CurrentTenant() tenantId: string,
    @Body() dto: CreatePublicAppointmentDto,
  ) {
    const { customer, claimPlainToken } = await this.customers.findOrCreateByPhone(dto.customer);

    const { appointment: aptRaw, cancellationPlainToken } =
      await this.appointments.createPublicBooking(tenantId, {
        serviceId: dto.serviceId,
        barberId: dto.barberId,
        startsAt: dto.startsAt,
        customer: { id: customer.id },
      });
    const appointment = aptRaw as Appointment;

    const [tenant, service, barber] = await Promise.all([
      this.tenants.findById(tenantId),
      this.services.findById(dto.serviceId),
      this.barbers.findById(dto.barberId),
    ]);

    let emailDelivered = true;
    if (customer.email && tenant && service && barber) {
      const cancelUrl = `${this.cfg.get<string>('APP_PUBLIC_URL')}/agendamento/${appointment.id}?token=${cancellationPlainToken}`;
      const claimUrl = claimPlainToken
        ? `${this.cfg.get<string>('APP_PUBLIC_URL')}/cliente/claim?token=${claimPlainToken}`
        : undefined;

      const tpl = appointmentConfirmationTemplate({
        customerName: customer.name,
        tenantName: tenant.name,
        tenantSlug: tenant.slug,
        barberName: barber.displayName,
        serviceName: service.name,
        startsAtLocal: formatLocal(appointment.startsAt, tenant.timezone),
        priceFormatted: priceFormatBRL(appointment.priceCentsSnapshot),
        cancelUrl,
        claimUrl,
      });
      try {
        await this.email.send({ to: customer.email, subject: tpl.subject, text: tpl.text });
      } catch (err) {
        this.logger.error(
          `confirmation email failed appointmentId=${appointment.id}: ${(err as Error).message}`,
        );
        emailDelivered = false;
      }
      if (claimUrl) {
        const claimTpl = customerClaimTemplate({
          customerName: customer.name,
          tenantName: tenant.name,
          claimUrl,
        });
        try {
          await this.email.send({
            to: customer.email,
            subject: claimTpl.subject,
            text: claimTpl.text,
          });
        } catch (err) {
          this.logger.warn(
            `claim email failed customerId=${customer.id}: ${(err as Error).message}`,
          );
        }
      }
    }

    return {
      id: appointment.id,
      status: appointment.status,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      cancellationToken: cancellationPlainToken,
      claimToken: claimPlainToken,
      emailDelivered,
    };
  }

  @Get('public/appointments/:id')
  async lookup(@Param('id') id: string, @Query('token') token: string) {
    const apt = await this.cancellation.lookupByToken(token);
    if (apt.id !== id) {
      throw new DomainException({
        code: ErrorCodes.CANCELLATION_TOKEN_INVALID,
        message: 'Token inválido.',
        status: HttpStatus.BAD_REQUEST,
      });
    }
    return await new Promise<unknown>((resolve) => {
      tenantAls.run({ tenantId: apt.tenantId }, () => {
        resolve({
          id: apt.id,
          status: apt.status,
          startsAt: apt.startsAt,
          endsAt: apt.endsAt,
          serviceName: apt.service?.name,
          barberName: apt.barber?.displayName,
          tenantName: apt.tenant?.name,
        });
      });
    });
  }

  @Post('public/appointments/:id/cancel')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  async cancel(
    @Param('id') id: string,
    @Query('token') token: string,
    @Body() body: { reason?: string },
  ) {
    const apt = await this.cancellation.lookupByToken(token);
    if (apt.id !== id) {
      throw new DomainException({
        code: ErrorCodes.CANCELLATION_TOKEN_INVALID,
        message: 'Token inválido.',
        status: HttpStatus.BAD_REQUEST,
      });
    }
    const updated = await this.cancellation.cancelByToken(token, body.reason);
    return { id: updated.id, status: updated.status };
  }
}
