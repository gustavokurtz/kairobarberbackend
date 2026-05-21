import { SubscriptionStatus } from '@prisma/client';

export type BillingStatusOrigin = 'trial' | 'payment' | null;

export interface BillingStatusViewDto {
  status: SubscriptionStatus;
  origin: BillingStatusOrigin;
  deadlineAt: Date | null;
  msUntilDeadline: number | null;
  hasCheckout: boolean;
}
