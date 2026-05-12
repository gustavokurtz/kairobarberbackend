import { Injectable } from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class SaasSubscriptionRepository {
  constructor(private readonly prisma: PrismaService) {}

  countByStatus(status: SubscriptionStatus) {
    return this.prisma.subscription.count({ where: { status } });
  }

  countActiveOrTrialing() {
    return this.prisma.subscription.count({
      where: { status: { in: ['trialing', 'active'] } },
    });
  }
}
