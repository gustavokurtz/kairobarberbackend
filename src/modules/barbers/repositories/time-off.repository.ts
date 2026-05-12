import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class TimeOffRepository {
  constructor(private readonly prisma: PrismaService) {}

  listForBarber(barberId: string) {
    return this.prisma.scoped.timeOff.findMany({
      where: { barberId },
      orderBy: { startsAt: 'asc' },
    });
  }

  create(data: { barberId: string; startsAt: Date; endsAt: Date; reason?: string }) {
    return this.prisma.scoped.timeOff.create({ data: data as Prisma.TimeOffUncheckedCreateInput });
  }

  findById(id: string) {
    return this.prisma.scoped.timeOff.findFirst({ where: { id } });
  }

  delete(id: string) {
    return this.prisma.scoped.timeOff.delete({ where: { id } });
  }
}
