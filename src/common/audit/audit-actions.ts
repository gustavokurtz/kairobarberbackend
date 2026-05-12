export const AuditActions = {
  SUBSCRIPTION_TRIAL_STARTED: 'subscription.trial_started',
  SUBSCRIPTION_CHECKOUT_CREATED: 'subscription.checkout_created',
  SUBSCRIPTION_ACTIVATED: 'subscription.activated',
  SUBSCRIPTION_PAST_DUE: 'subscription.past_due',
  SUBSCRIPTION_CANCELLED: 'subscription.cancelled',
  SUBSCRIPTION_TRIAL_EXPIRED: 'subscription.trial_expired',
  TENANT_SUSPENDED: 'tenant.suspended',
  TENANT_UNSUSPENDED: 'tenant.unsuspended',
  AI_CONSULTATION_CREATED: 'ai.consultation_created',
  AI_ANALYSIS_COMPLETED: 'ai.analysis_completed',
  AI_GENERATION_COMPLETED: 'ai.generation_completed',
  AI_CONSULTATION_FAILED: 'ai.consultation_failed',
  AI_CONSULTATION_EXPIRED: 'ai.consultation_expired',
} as const;

export type AuditAction = (typeof AuditActions)[keyof typeof AuditActions];
