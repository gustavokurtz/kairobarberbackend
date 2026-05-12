import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { INestApplication } from '@nestjs/common';
import IORedis from 'ioredis';
import { ConsoleBillingProvider } from 'src/modules/billing/providers/console.billing-provider';
import { BILLING_PROVIDER } from 'src/modules/billing/providers/billing.provider';
import { BillingService } from 'src/modules/billing/billing.service';

export interface StartedRedis {
  container: StartedTestContainer;
  url: string;
}

export async function startTestRedis(): Promise<StartedRedis> {
  const container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
  const port = container.getMappedPort(6379);
  const url = `redis://${container.getHost()}:${port}`;
  process.env.REDIS_URL = url;
  return { container, url };
}

export async function flushTestRedis(url: string): Promise<void> {
  const r = new IORedis(url, { maxRetriesPerRequest: null, enableReadyCheck: false });
  await r.flushall();
  await r.quit();
}

export async function runBillingJobsNow(app: INestApplication): Promise<void> {
  // Em vez de esperar o cron, chamamos os métodos do service diretamente.
  // Isso é determinístico e independe do BullMQ rodando.
  const billing = app.get(BillingService);
  await billing.runBillingSync();
  await billing.runTrialCheck();
}

export function getConsoleBillingProvider(app: INestApplication): ConsoleBillingProvider {
  const provider = app.get<unknown>(BILLING_PROVIDER);
  if (!(provider instanceof ConsoleBillingProvider)) {
    throw new Error('Test setup expected ConsoleBillingProvider but got another implementation');
  }
  return provider;
}

export function setBillingClock(date: Date): void {
  process.env.BILLING_NOW_OVERRIDE_MS = String(date.getTime());
}

export function resetBillingClock(): void {
  delete process.env.BILLING_NOW_OVERRIDE_MS;
}
