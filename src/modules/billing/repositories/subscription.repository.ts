import { Injectable } from '@nestjs/common';
import { Prisma, Subscription, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class SubscriptionRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByTenantId(tenantId: string): Promise<Subscription | null> {
    return this.prisma.subscription.findUnique({ where: { tenantId } });
  }

  findByPreapprovalId(preapprovalId: string): Promise<Subscription | null> {
    return this.prisma.subscription.findUnique({ where: { mpPreapprovalId: preapprovalId } });
  }

  create(data: {
    tenantId: string;
    status: SubscriptionStatus;
    trialEndsAt?: Date | null;
    tx?: Prisma.TransactionClient;
  }): Promise<Subscription> {
    const client = data.tx ?? this.prisma;
    return client.subscription.create({
      data: {
        tenantId: data.tenantId,
        status: data.status,
        trialEndsAt: data.trialEndsAt ?? null,
      },
    });
  }

  update(
    tenantId: string,
    patch: Partial<{
      status: SubscriptionStatus;
      trialEndsAt: Date | null;
      currentPeriodEnd: Date | null;
      mpPreapprovalId: string | null;
      lastSyncedAt: Date | null;
      nextSyncAt: Date | null;
      updatedAt: Date;
    }>,
  ): Promise<Subscription> {
    return this.prisma.subscription.update({ where: { tenantId }, data: patch });
  }

  findDueForSync(now: Date, limit: number): Promise<Subscription[]> {
    return this.prisma.subscription.findMany({
      where: {
        mpPreapprovalId: { not: null },
        OR: [{ nextSyncAt: null }, { nextSyncAt: { lte: now } }],
        status: { in: ['trialing', 'active', 'past_due'] },
      },
      orderBy: { nextSyncAt: { sort: 'asc', nulls: 'first' } },
      take: limit,
    });
  }

  findExpiredTrials(now: Date): Promise<Subscription[]> {
    return this.prisma.subscription.findMany({
      where: { status: 'trialing', trialEndsAt: { lt: now } },
    });
  }

  findPastDueOverGrace(cutoff: Date): Promise<Subscription[]> {
    return this.prisma.subscription.findMany({
      where: { status: 'past_due', updatedAt: { lt: cutoff } },
    });
  }
}
