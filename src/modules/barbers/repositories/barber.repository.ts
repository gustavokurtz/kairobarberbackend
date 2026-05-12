import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class BarberRepository {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.scoped.barber.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  }

  findById(id: string) {
    return this.prisma.scoped.barber.findFirst({ where: { id, deletedAt: null } });
  }

  create(data: Prisma.BarberCreateInput | Prisma.BarberUncheckedCreateInput) {
    return this.prisma.scoped.barber.create({ data: data });
  }

  update(id: string, data: Prisma.BarberUpdateInput) {
    return this.prisma.scoped.barber.update({ where: { id }, data });
  }

  softDelete(id: string) {
    return this.prisma.scoped.barber.update({
      where: { id },
      data: { deletedAt: new Date(), active: false },
    });
  }
}
