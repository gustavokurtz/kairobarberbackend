import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AuditActions } from 'src/common/audit/audit-actions';
import { SaasSubscriptionRepository } from '../repositories/saas-subscription.repository';

@Injectable()
export class SaasMetricsService {
  constructor(
    private readonly subs: SaasSubscriptionRepository,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async dashboard(now: Date = new Date()) {
    const mrrCents = this.config.get<number>('BILLING_MRR_CENTS') ?? 4990;
    const since30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const since60d = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    const [active, tenantsAlive, cancelledIn30d, activatedIn30d, trialsStartedIn60d] =
      await Promise.all([
        this.subs.countByStatus('active'),
        this.subs.countActiveOrTrialing(),
        this.prisma.auditLog.count({
          where: {
            action: AuditActions.SUBSCRIPTION_CANCELLED,
            createdAt: { gte: since30d, lte: now },
          },
        }),
        this.prisma.auditLog.count({
          where: {
            action: AuditActions.SUBSCRIPTION_ACTIVATED,
            createdAt: { gte: since30d, lte: now },
          },
        }),
        this.prisma.auditLog.count({
          where: {
            action: AuditActions.SUBSCRIPTION_TRIAL_STARTED,
            createdAt: { gte: since60d, lte: now },
          },
        }),
      ]);

    const totalMrrCents = active * mrrCents;
    const totalArrCents = totalMrrCents * 12;
    const churnDenominator = active + cancelledIn30d;
    const churn30d = churnDenominator > 0 ? cancelledIn30d / churnDenominator : 0;
    const conversion = trialsStartedIn60d > 0 ? activatedIn30d / trialsStartedIn60d : 0;

    return {
      asOf: now.toISOString(),
      mrrCents: totalMrrCents,
      arrCents: totalArrCents,
      tenantsActive: tenantsAlive,
      cancelledLast30d: cancelledIn30d,
      activatedLast30d: activatedIn30d,
      trialsStartedLast60d: trialsStartedIn60d,
      churn30d: Number(churn30d.toFixed(4)),
      trialConversion30d: Number(conversion.toFixed(4)),
    };
  }
}
