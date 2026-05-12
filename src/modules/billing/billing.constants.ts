export const ALLOW_INACTIVE_SUBSCRIPTION_KEY = 'kairo:allow-inactive-subscription';

export const SYNC_INTERVAL_BY_STATUS: Record<'trialing' | 'active' | 'past_due', number /* ms */> =
  {
    trialing: 24 * 60 * 60 * 1000,
    active: 24 * 60 * 60 * 1000,
    past_due: 2 * 60 * 60 * 1000,
  };

export const SYNC_RETRY_BACKOFF_MS = 15 * 60 * 1000;

export const SYNC_BATCH_SIZE = 50;

export const BILLING_SYNC_JOB_KEY = 'billing-sync-cron';
export const TRIAL_CHECK_JOB_KEY = 'trial-check-cron';
