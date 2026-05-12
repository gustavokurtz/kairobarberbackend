import { Injectable } from '@nestjs/common';
import { AppointmentStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

const ACTIVE_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.pending,
  AppointmentStatus.confirmed,
  AppointmentStatus.completed,
];

@Injectable()
export class AppointmentRepository {
  constructor(private readonly prisma: PrismaService) {}

  listForRange(filters: { from: Date; to: Date; barberId?: string; status?: AppointmentStatus }) {
    const where: Prisma.AppointmentWhereInput = {
      startsAt: { gte: filters.from, lt: filters.to },
      ...(filters.barberId ? { barberId: filters.barberId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
    };
    return this.prisma.scoped.appointment.findMany({
      where,
      orderBy: { startsAt: 'asc' },
      include: { service: true, barber: true, customer: true },
    });
  }

  findById(id: string) {
    return this.prisma.scoped.appointment.findFirst({
      where: { id },
      include: { service: true, barber: true, customer: true, tenant: true },
    });
  }

  findByCancellationTokenHash(tokenHash: string) {
    return this.prisma.appointment.findUnique({
      where: { cancellationTokenHash: tokenHash },
      include: { service: true, barber: true, customer: true, tenant: true },
    });
  }

  findActiveForBarberInRange(barberId: string, from: Date, to: Date) {
    return this.prisma.scoped.appointment.findMany({
      where: {
        barberId,
        status: { in: ACTIVE_STATUSES },
        startsAt: { lt: to },
        endsAt: { gt: from },
      },
      select: { id: true, startsAt: true, endsAt: true, barberId: true },
    });
  }

  updateStatus(id: string, status: AppointmentStatus, extra?: Prisma.AppointmentUpdateInput) {
    return this.prisma.scoped.appointment.update({
      where: { id },
      data: { status, ...extra },
    });
  }

  update(id: string, data: Prisma.AppointmentUpdateInput) {
    return this.prisma.scoped.appointment.update({ where: { id }, data });
  }
}

export { ACTIVE_STATUSES };
