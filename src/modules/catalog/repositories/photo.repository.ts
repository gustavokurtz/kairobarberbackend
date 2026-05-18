import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class PhotoRepository {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.scoped.photo.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  findById(id: string) {
    return this.prisma.scoped.photo.findFirst({ where: { id, deletedAt: null } });
  }

  create(data: Omit<Prisma.PhotoUncheckedCreateInput, 'tenantId' | 'id' | 'createdAt'>) {
    return this.prisma.scoped.photo.create({ data: data as Prisma.PhotoCreateInput });
  }

  update(id: string, data: Prisma.PhotoUpdateInput) {
    return this.prisma.scoped.photo.update({ where: { id }, data });
  }

  softDelete(id: string) {
    return this.prisma.scoped.photo.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}
