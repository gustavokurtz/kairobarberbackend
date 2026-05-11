import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

export function initSentry(dsn?: string, environment?: string) {
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: environment ?? 'production',
    integrations: [nodeProfilingIntegration()],
    tracesSampleRate: 0.1,
    profilesSampleRate: 0.1,
  });
}
