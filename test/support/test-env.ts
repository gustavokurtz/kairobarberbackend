export function setTestEnv() {
  process.env.NODE_ENV = 'test';
  process.env.PORT = '0';
  process.env.APP_URL = 'http://localhost';
  process.env.APP_PUBLIC_URL = 'http://localhost:3000';
  process.env.JWT_ACCESS_SECRET = 'a'.repeat(40);
  process.env.JWT_REFRESH_SECRET = 'b'.repeat(40);
  process.env.JWT_ACCESS_TTL = '15m';
  process.env.JWT_REFRESH_TTL = '7d';
  process.env.EMAIL_PROVIDER = 'console';
  process.env.EMAIL_FROM = 'noreply@kairobarber.test';
  process.env.LOG_LEVEL = 'fatal';
  process.env.BILLING_PROVIDER = process.env.BILLING_PROVIDER ?? 'console';
  process.env.BILLING_TRIAL_DAYS = process.env.BILLING_TRIAL_DAYS ?? '14';
  process.env.BILLING_PAST_DUE_GRACE_DAYS = process.env.BILLING_PAST_DUE_GRACE_DAYS ?? '7';
  // Default REDIS_URL for legacy E2E tests that don't spin up testcontainers Redis.
  // Billing E2E tests use startTestRedis() and override this with a per-suite container.
  process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
}
