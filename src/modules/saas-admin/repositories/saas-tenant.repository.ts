import { Injectable } from '@nestjs/common';
import { Prisma, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface ListTenantsArgs {
  status: 'trialing' | 'active' | 'past_due' | 'cancelled' | 'all';
  suspended?: 'true' | 'false';
  search?: string;
  page: number;
  pageSize: number;
}

@Injectable()
export class SaasTenantRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(args: ListTenantsArgs) {
    const where: Prisma.TenantWhereInput = {
      deletedAt: null,
      suspendedAt:
        args.suspended === 'true' ? { not: null } : args.suspended === 'false' ? null : undefined,
      subscription:
        args.status === 'all' ? undefined : { status: args.status as SubscriptionStatus },
      OR: args.search
        ? [
            { slug: { contains: args.search, mode: 'insensitive' } },
            { name: { contains: args.search, mode: 'insensitive' } },
          ]
        : undefined,
    };
    const [rows, total] = await Promise.all([
      this.prisma.tenant.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (args.page - 1) * args.pageSize,
        take: args.pageSize,
        include: {
          subscription: {
            select: { status: true, trialEndsAt: true, currentPeriodEnd: true },
          },
          owner: { select: { email: true } },
        },
      }),
      this.prisma.tenant.count({ where }),
    ]);
    return { rows, total };
  }

  async findOneDetailed(id: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      include: {
        subscription: true,
        owner: { select: { email: true } },
      },
    });
    if (!tenant) return null;
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [
      barbersCount,
      servicesCount,
      customersCount,
      appointmentsTotalCount,
      appointmentsLast30dCount,
    ] = await Promise.all([
      this.prisma.barber.count({ where: { tenantId: id, deletedAt: null } }),
      this.prisma.service.count({ where: { tenantId: id, deletedAt: null } }),
      this.prisma.customer.count({ where: { tenantId: id, deletedAt: null } }),
      this.prisma.appointment.count({ where: { tenantId: id } }),
      this.prisma.appointment.count({ where: { tenantId: id, createdAt: { gte: since30d } } }),
    ]);
    return {
      tenant,
      counters: {
        barbersCount,
        servicesCount,
        customersCount,
        appointmentsTotalCount,
        appointmentsLast30dCount,
      },
    };
  }
}
