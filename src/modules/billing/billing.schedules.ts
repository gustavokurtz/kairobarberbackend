import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { JOB_BILLING_SYNC, JOB_TRIAL_CHECK, QUEUE_BILLING } from 'src/infra/queues/queue-names';
import { BILLING_SYNC_JOB_KEY, TRIAL_CHECK_JOB_KEY } from './billing.constants';

@Injectable()
export class BillingSchedules implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(BillingSchedules.name);

  constructor(
    @InjectQueue(QUEUE_BILLING) private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.get<string>('NODE_ENV') === 'test') {
      this.logger.log({ event: 'billing.schedules_skipped', reason: 'NODE_ENV=test' });
      return;
    }
    const syncCron = this.config.getOrThrow<string>('BILLING_SYNC_CRON');
    const trialCron = this.config.getOrThrow<string>('BILLING_TRIAL_CHECK_CRON');

    try {
      await this.queue.upsertJobScheduler(
        BILLING_SYNC_JOB_KEY,
        { pattern: syncCron, tz: 'UTC' },
        { name: JOB_BILLING_SYNC, data: {} },
      );
      await this.queue.upsertJobScheduler(
        TRIAL_CHECK_JOB_KEY,
        { pattern: trialCron, tz: 'UTC' },
        { name: JOB_TRIAL_CHECK, data: {} },
      );
    } catch (err) {
      // INV-15 + D-05: crash visível >> trial infinito silencioso. Sem webhook do
      // gateway, este cron é o único sinal de OVERDUE — se não registrar, ninguém
      // detecta past_due. Sentry captura exceptions não tratadas em lifecycle hooks
      // via integração NestJS (sem captureException manual). Railway re-tenta deploy.
      this.logger.error({
        event: 'billing.schedules_registration_failed',
        error: (err as Error).message,
        stack: (err as Error).stack,
      });
      throw new Error(`Failed to register billing schedulers: ${(err as Error).message}`);
    }

    this.logger.log({
      event: 'billing.schedules_registered',
      syncCron,
      trialCron,
    });
  }

  async onApplicationShutdown(): Promise<void> {
    // Não removemos os schedulers — eles vivem no Redis e devem persistir entre deploys.
  }
}
