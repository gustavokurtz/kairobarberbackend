import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class ServiceRepository {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.scoped.service.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'asc' },
      include: { serviceBarbers: true },
    });
  }

  findById(id: string) {
    return this.prisma.scoped.service.findFirst({
      where: { id, deletedAt: null },
      include: { serviceBarbers: true },
    });
  }

  create(data: Prisma.ServiceCreateInput | Prisma.ServiceUncheckedCreateInput) {
    return this.prisma.scoped.service.create({ data: data });
  }

  update(id: string, data: Prisma.ServiceUpdateInput) {
    return this.prisma.scoped.service.update({ where: { id }, data });
  }

  softDelete(id: string) {
    return this.prisma.scoped.service.update({
      where: { id },
      data: { deletedAt: new Date(), active: false },
    });
  }

  async replaceBarbers(serviceId: string, barberIds: string[], tenantId: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.serviceBarber.deleteMany({ where: { serviceId, tenantId } });
      if (barberIds.length) {
        await tx.serviceBarber.createMany({
          data: barberIds.map((barberId) => ({ tenantId, serviceId, barberId })),
        });
      }
      return tx.serviceBarber.findMany({ where: { serviceId, tenantId } });
    });
  }
}
