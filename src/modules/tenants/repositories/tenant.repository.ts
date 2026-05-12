import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class TenantRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string) {
    return this.prisma.tenant.findUnique({
      where: { id },
      include: { subscription: true },
    });
  }

  findBySlug(slug: string) {
    return this.prisma.tenant.findFirst({ where: { slug, deletedAt: null } });
  }

  update(id: string, data: Prisma.TenantUpdateInput) {
    return this.prisma.tenant.update({ where: { id }, data });
  }
}
