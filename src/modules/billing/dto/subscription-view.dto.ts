import { SubscriptionStatus } from '@prisma/client';

export class SubscriptionViewDto {
  status!: SubscriptionStatus;
  trialEndsAt!: string | null;
  currentPeriodEnd!: string | null;
  hasCheckout!: boolean;
  lastSyncedAt!: string | null;
}
