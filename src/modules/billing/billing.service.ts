import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, Subscription, SubscriptionStatus } from '@prisma/client';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { SYNC_INTERVAL_BY_STATUS } from './billing.constants';
import {
  BILLING_PROVIDER,
  type BillingProvider,
  type RemoteSubscription,
} from './providers/billing.provider';
import { SubscriptionRepository } from './repositories/subscription.repository';

export interface SubscriptionView {
  status: SubscriptionStatus;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  hasCheckout: boolean;
  lastSyncedAt: Date | null;
}

@Injectable()
export class BillingService {
  constructor(
    private readonly repo: SubscriptionRepository,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    private readonly config: ConfigService,
    private readonly logger: Logger,
  ) {}

  now(): Date {
    const override = this.config.get<number>('BILLING_NOW_OVERRIDE_MS');
    return override ? new Date(Number(override)) : new Date();
  }

  async startTrial(input: {
    tenantId: string;
    tx?: Prisma.TransactionClient;
  }): Promise<Subscription> {
    const trialDays = this.config.get<number>('BILLING_TRIAL_DAYS') ?? 14;
    const trialEndsAt = new Date(this.now().getTime() + trialDays * 24 * 60 * 60 * 1000);
    return this.repo.create({
      tenantId: input.tenantId,
      status: SubscriptionStatus.trialing,
      trialEndsAt,
      tx: input.tx,
    });
  }

  async getSubscription(tenantId: string): Promise<SubscriptionView> {
    const sub = await this.repo.findByTenantId(tenantId);
    if (!sub) {
      throw new DomainException({
        code: ErrorCodes.SUBSCRIPTION_NOT_FOUND,
        message: 'Assinatura não encontrada para o tenant.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    return {
      status: sub.status,
      trialEndsAt: sub.trialEndsAt,
      currentPeriodEnd: sub.currentPeriodEnd,
      hasCheckout: Boolean(sub.mpPreapprovalId),
      lastSyncedAt: sub.lastSyncedAt,
    };
  }

  async applyRemoteState(local: Subscription, remote: RemoteSubscription): Promise<void> {
    if (local.status === SubscriptionStatus.cancelled) {
      // Defesa: nunca regredir de cancelled.
      await this.repo.update(local.tenantId, {
        status: SubscriptionStatus.cancelled,
        nextSyncAt: null,
        lastSyncedAt: this.now(),
      });
      return;
    }

    const mappedStatus = mapRemoteStatus(remote.status, local.status);
    const nextSyncAt = computeNextSyncAt(mappedStatus, this.now());

    await this.repo.update(local.tenantId, {
      status: mappedStatus,
      currentPeriodEnd: remote.nextPaymentDate ?? local.currentPeriodEnd,
      lastSyncedAt: this.now(),
      nextSyncAt,
    });

    if (mappedStatus !== local.status) {
      this.logger.log({
        event: `subscription.${mappedStatus}`,
        tenantId: local.tenantId,
        fromStatus: local.status,
        toStatus: mappedStatus,
        mpPreapprovalId: local.mpPreapprovalId,
      });
    }
  }

  async cancelSubscription(tenantId: string): Promise<void> {
    const sub = await this.repo.findByTenantId(tenantId);
    if (!sub) {
      throw new DomainException({
        code: ErrorCodes.SUBSCRIPTION_NOT_FOUND,
        message: 'Assinatura não encontrada.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    if (sub.mpPreapprovalId) {
      await this.provider.cancelPreapproval(sub.mpPreapprovalId);
    }
    await this.repo.update(tenantId, {
      status: SubscriptionStatus.cancelled,
      nextSyncAt: null,
      lastSyncedAt: this.now(),
    });
    this.logger.log({
      event: 'subscription.cancelled',
      tenantId,
      fromStatus: sub.status,
      toStatus: 'cancelled',
      mpPreapprovalId: sub.mpPreapprovalId,
    });
  }
}

function mapRemoteStatus(
  remote: RemoteSubscription['status'],
  local: SubscriptionStatus,
): SubscriptionStatus {
  switch (remote) {
    case 'authorized':
      return SubscriptionStatus.active;
    case 'paused':
      return SubscriptionStatus.past_due;
    case 'cancelled':
      return SubscriptionStatus.cancelled;
    case 'pending':
    default:
      return local;
  }
}

function computeNextSyncAt(status: SubscriptionStatus, now: Date): Date | null {
  if (status === SubscriptionStatus.cancelled) return null;
  const interval = SYNC_INTERVAL_BY_STATUS[status];
  return new Date(now.getTime() + interval);
}
