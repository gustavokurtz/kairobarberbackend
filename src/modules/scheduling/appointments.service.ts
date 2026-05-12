import { HttpStatus, Injectable } from '@nestjs/common';
import { AppointmentSource, AppointmentStatus, Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { BarbersService } from 'src/modules/barbers/barbers.service';
import { ServicesService } from 'src/modules/catalog/services.service';
import { AppointmentRepository } from './repositories/appointment.repository';

export type PublicBookingInput = {
  serviceId: string;
  barberId: string;
  startsAt: Date;
  customer: { id: string };
};

export type AdminBookingInput = PublicBookingInput;

const ACTIVE_STATUSES_SQL = `('${AppointmentStatus.pending}','${AppointmentStatus.confirmed}','${AppointmentStatus.completed}')`;

@Injectable()
export class AppointmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: AppointmentRepository,
    private readonly services: ServicesService,
    private readonly barbers: BarbersService,
    private readonly nowFn: () => Date = () => new Date(),
  ) {}

  async getById(id: string) {
    const a = await this.repo.findById(id);
    if (!a) {
      throw new DomainException({
        code: ErrorCodes.APPOINTMENT_NOT_FOUND,
        message: 'Agendamento não encontrado.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    return a;
  }

  list(filters: { from: Date; to: Date; barberId?: string; status?: AppointmentStatus }) {
    return this.repo.listForRange(filters);
  }

  async createPublicBooking(tenantId: string, input: PublicBookingInput) {
    return this.createInternal(
      tenantId,
      input,
      AppointmentSource.public_storefront,
      AppointmentStatus.pending,
    );
  }

  async createAdminBooking(tenantId: string, input: AdminBookingInput) {
    return this.createInternal(
      tenantId,
      input,
      AppointmentSource.admin,
      AppointmentStatus.confirmed,
    );
  }

  private async createInternal(
    tenantId: string,
    input: PublicBookingInput,
    source: AppointmentSource,
    initialStatus: AppointmentStatus,
  ) {
    if (input.startsAt < this.nowFn()) {
      throw new DomainException({
        code: ErrorCodes.APPOINTMENT_SLOT_INVALID,
        message: 'Horário no passado.',
        status: HttpStatus.BAD_REQUEST,
      });
    }

    const service = await this.services.getById(input.serviceId);
    if (!service.active || service.deletedAt) {
      throw new DomainException({
        code: ErrorCodes.SERVICE_NOT_FOUND,
        message: 'Serviço indisponível.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    const offerings = (service.serviceBarbers ?? []).map((sb) => sb.barberId);
    if (!offerings.includes(input.barberId)) {
      throw new DomainException({
        code: ErrorCodes.BARBER_DOES_NOT_PROVIDE_SERVICE,
        message: 'Este barbeiro não realiza o serviço escolhido.',
        status: HttpStatus.BAD_REQUEST,
      });
    }

    const barber = await this.barbers.getById(input.barberId);
    if (!barber.active || barber.deletedAt) {
      throw new DomainException({
        code: ErrorCodes.BARBER_NOT_FOUND,
        message: 'Barbeiro indisponível.',
        status: HttpStatus.NOT_FOUND,
      });
    }

    const startsAt = input.startsAt;
    const endsAt = new Date(startsAt.getTime() + service.durationMin * 60 * 1000);

    const cancellationPlainToken = randomBytes(32).toString('base64url');
    const cancellationTokenHash = createHash('sha256').update(cancellationPlainToken).digest('hex');

    type RawTx = {
      $queryRawUnsafe: <T>(...args: unknown[]) => Promise<T>;
      appointment: { create: (args: { data: Prisma.AppointmentUncheckedCreateInput }) => Promise<unknown> };
    };

    const appointment = await this.prisma.$transaction(async (tx) => {
      const rawTx = tx as unknown as RawTx;

      // SELECT FOR UPDATE em qualquer overlap ativo do barbeiro:
      const overlap = await rawTx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM "Appointment"
         WHERE "tenantId" = $1
           AND "barberId" = $2
           AND status::text IN ${ACTIVE_STATUSES_SQL}
           AND "startsAt" < $3
           AND "endsAt"   > $4
         FOR UPDATE`,
        tenantId,
        input.barberId,
        endsAt,
        startsAt,
      );
      if (overlap.length > 0) {
        throw new DomainException({
          code: ErrorCodes.APPOINTMENT_SLOT_TAKEN,
          message: 'Esse horário já foi reservado.',
          status: HttpStatus.CONFLICT,
          details: { startsAt: startsAt.toISOString() },
        });
      }
      return rawTx.appointment.create({
        data: {
          tenantId,
          barberId: input.barberId,
          serviceId: input.serviceId,
          customerId: input.customer.id,
          startsAt,
          endsAt,
          status: initialStatus,
          priceCentsSnapshot: service.priceCents,
          durationMinSnapshot: service.durationMin,
          source,
          cancellationTokenHash,
        },
      });
    });

    return { appointment, cancellationPlainToken };
  }
}
