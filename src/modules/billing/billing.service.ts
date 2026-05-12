import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, Subscription, SubscriptionStatus } from '@prisma/client';
import { AuditActions } from 'src/common/audit/audit-actions';
import { AuditService } from 'src/common/audit/audit.service';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import {
  SYNC_BATCH_SIZE,
  SYNC_INTERVAL_BY_STATUS,
  SYNC_RETRY_BACKOFF_MS,
} from './billing.constants';
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
    private readonly audit: AuditService,
  ) {}

  now(): Date {
    const override = process.env.BILLING_NOW_OVERRIDE_MS;
    return override ? new Date(Number(override)) : new Date();
  }

  async startTrial(input: {
    tenantId: string;
    tx?: Prisma.TransactionClient;
  }): Promise<Subscription> {
    const trialDays = this.config.get<number>('BILLING_TRIAL_DAYS') ?? 14;
    const trialEndsAt = new Date(this.now().getTime() + trialDays * 24 * 60 * 60 * 1000);
    const sub = await this.repo.create({
      tenantId: input.tenantId,
      status: SubscriptionStatus.trialing,
      trialEndsAt,
      tx: input.tx,
    });
    await this.audit.record(
      {
        action: AuditActions.SUBSCRIPTION_TRIAL_STARTED,
        tenantId: input.tenantId,
        targetType: 'subscription',
        targetId: sub.id,
        diff: { trialEndsAt: trialEndsAt.toISOString() },
      },
      input.tx,
    );
    return sub;
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
      const action =
        mappedStatus === SubscriptionStatus.active
          ? AuditActions.SUBSCRIPTION_ACTIVATED
          : mappedStatus === SubscriptionStatus.past_due
            ? AuditActions.SUBSCRIPTION_PAST_DUE
            : mappedStatus === SubscriptionStatus.cancelled
              ? AuditActions.SUBSCRIPTION_CANCELLED
              : null;
      if (action) {
        await this.audit.record({
          action,
          tenantId: local.tenantId,
          targetType: 'subscription',
          targetId: local.id,
          diff: { fromStatus: local.status, toStatus: mappedStatus },
        });
      }
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
    await this.audit.record({
      action: AuditActions.SUBSCRIPTION_CANCELLED,
      tenantId,
      targetType: 'subscription',
      targetId: sub.id,
      diff: { fromStatus: sub.status, toStatus: 'cancelled', reason: 'owner_cancelled' },
    });
  }

  async createCheckout(input: {
    tenantId: string;
    tenantSlug: string;
    ownerEmail: string;
  }): Promise<{ initPoint: string }> {
    const sub = await this.repo.findByTenantId(input.tenantId);
    if (!sub) {
      throw new DomainException({
        code: ErrorCodes.SUBSCRIPTION_NOT_FOUND,
        message: 'Assinatura não encontrada.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    if (sub.status === SubscriptionStatus.active) {
      throw new DomainException({
        code: ErrorCodes.SUBSCRIPTION_ALREADY_ACTIVE,
        message: 'Assinatura já está ativa.',
        status: HttpStatus.CONFLICT,
      });
    }

    const amountCents = this.config.get<number>('MP_PLAN_AMOUNT_CENTS') ?? 4990;
    const created = await this.provider.createPreapproval({
      tenantId: input.tenantId,
      tenantSlug: input.tenantSlug,
      payerEmail: input.ownerEmail,
      reason: `Assinatura KairoBarber - ${input.tenantSlug}`,
      amountCents,
      frequency: 'months',
    });

    const nextSyncAt = new Date(this.now().getTime() + 60 * 60 * 1000); // sondagem pós-checkout em 1h
    await this.repo.update(input.tenantId, {
      mpPreapprovalId: created.preapprovalId,
      status: SubscriptionStatus.trialing,
      nextSyncAt,
    });

    this.logger.log({
      event: 'subscription.checkout_created',
      tenantId: input.tenantId,
      mpPreapprovalId: created.preapprovalId,
    });

    await this.audit.record({
      action: AuditActions.SUBSCRIPTION_CHECKOUT_CREATED,
      tenantId: input.tenantId,
      targetType: 'subscription',
      targetId: sub.id,
      diff: { mpPreapprovalId: created.preapprovalId },
    });

    return { initPoint: created.initPoint };
  }

  async syncSubscription(tenantId: string): Promise<void> {
    const sub = await this.repo.findByTenantId(tenantId);
    if (!sub || !sub.mpPreapprovalId) return;
    const remote = await this.provider.fetchPreapproval(sub.mpPreapprovalId);
    await this.applyRemoteState(sub, remote);
  }

  async listInvoices(
    tenantId: string,
    q: { page: number; pageSize: number },
  ): Promise<
    Array<{
      id: string;
      amountCents: number;
      status: 'approved' | 'rejected' | 'pending' | 'refunded';
      paidAt: Date | null;
      dueAt: Date | null;
    }>
  > {
    const sub = await this.repo.findByTenantId(tenantId);
    if (!sub?.mpPreapprovalId) return [];
    return this.provider.listPayments(sub.mpPreapprovalId, q);
  }

  async runBillingSync(): Promise<{ processed: number; failed: number }> {
    const now = this.now();
    const subs = await this.repo.findDueForSync(now, SYNC_BATCH_SIZE);
    let processed = 0;
    let failed = 0;
    for (const sub of subs) {
      try {
        const remote = await this.provider.fetchPreapproval(sub.mpPreapprovalId!);
        await this.applyRemoteState(sub, remote);
        processed += 1;
      } catch (err) {
        failed += 1;
        this.logger.warn({
          event: 'subscription.sync_failed',
          tenantId: sub.tenantId,
          mpPreapprovalId: sub.mpPreapprovalId,
          error: (err as Error).message,
        });
        await this.repo.update(sub.tenantId, {
          nextSyncAt: new Date(now.getTime() + SYNC_RETRY_BACKOFF_MS),
        });
      }
    }
    this.logger.log({ event: 'billing.sync_cycle', processed, failed });
    return { processed, failed };
  }

  async runTrialCheck(): Promise<{ trialExpired: number; graceExpired: number }> {
    const now = this.now();
    const trialEnded = await this.repo.findExpiredTrials(now);
    for (const sub of trialEnded) {
      await this.repo.update(sub.tenantId, {
        status: SubscriptionStatus.past_due,
        nextSyncAt: sub.mpPreapprovalId ? new Date(now.getTime() + 2 * 60 * 60 * 1000) : null,
        updatedAt: now,
      });
      this.logger.log({
        event: 'subscription.trial_expired',
        tenantId: sub.tenantId,
        fromStatus: 'trialing',
        toStatus: 'past_due',
      });
      await this.audit.record({
        action: AuditActions.SUBSCRIPTION_TRIAL_EXPIRED,
        tenantId: sub.tenantId,
        targetType: 'subscription',
        targetId: sub.id,
        diff: { fromStatus: 'trialing', toStatus: 'past_due' },
      });
      await this.audit.record({
        action: AuditActions.SUBSCRIPTION_PAST_DUE,
        tenantId: sub.tenantId,
        targetType: 'subscription',
        targetId: sub.id,
        diff: { fromStatus: 'trialing', toStatus: 'past_due', reason: 'trial_expired' },
      });
    }

    const graceDays = this.config.get<number>('BILLING_PAST_DUE_GRACE_DAYS') ?? 7;
    const cutoff = new Date(now.getTime() - graceDays * 24 * 60 * 60 * 1000);
    const overGrace = await this.repo.findPastDueOverGrace(cutoff);
    for (const sub of overGrace) {
      await this.repo.update(sub.tenantId, {
        status: SubscriptionStatus.cancelled,
        nextSyncAt: null,
      });
      this.logger.log({
        event: 'subscription.grace_period_expired',
        tenantId: sub.tenantId,
        fromStatus: 'past_due',
        toStatus: 'cancelled',
        mpPreapprovalId: sub.mpPreapprovalId,
      });
      await this.audit.record({
        action: AuditActions.SUBSCRIPTION_CANCELLED,
        tenantId: sub.tenantId,
        targetType: 'subscription',
        targetId: sub.id,
        diff: { fromStatus: 'past_due', toStatus: 'cancelled', reason: 'grace_period_expired' },
      });
    }

    return { trialExpired: trialEnded.length, graceExpired: overGrace.length };
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
