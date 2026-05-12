export const AuditActions = {
  SUBSCRIPTION_TRIAL_STARTED: 'subscription.trial_started',
  SUBSCRIPTION_CHECKOUT_CREATED: 'subscription.checkout_created',
  SUBSCRIPTION_ACTIVATED: 'subscription.activated',
  SUBSCRIPTION_PAST_DUE: 'subscription.past_due',
  SUBSCRIPTION_CANCELLED: 'subscription.cancelled',
  SUBSCRIPTION_TRIAL_EXPIRED: 'subscription.trial_expired',
  TENANT_SUSPENDED: 'tenant.suspended',
  TENANT_UNSUSPENDED: 'tenant.unsuspended',
} as const;

export type AuditAction = (typeof AuditActions)[keyof typeof AuditActions];
