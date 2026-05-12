import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class CustomerRepository {
  constructor(private readonly prisma: PrismaService) {}

  list(search?: string) {
    const where: Prisma.CustomerWhereInput = {
      deletedAt: null,
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search } },
              { email: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    return this.prisma.scoped.customer.findMany({ where, orderBy: { createdAt: 'desc' } });
  }

  findById(id: string) {
    return this.prisma.scoped.customer.findFirst({ where: { id, deletedAt: null } });
  }

  findByPhone(phone: string) {
    return this.prisma.scoped.customer.findFirst({ where: { phone, deletedAt: null } });
  }

  findByClaimTokenHash(claimTokenHash: string) {
    return this.prisma.customer.findUnique({ where: { claimTokenHash } });
  }

  create(data: Prisma.CustomerUncheckedCreateInput) {
    return this.prisma.scoped.customer.create({ data });
  }

  update(id: string, data: Prisma.CustomerUpdateInput) {
    return this.prisma.scoped.customer.update({ where: { id }, data });
  }

  listAppointmentsForCustomer(customerId: string) {
    return this.prisma.scoped.appointment.findMany({
      where: { customerId },
      orderBy: { startsAt: 'desc' },
      include: { service: true, barber: true },
    });
  }
}
