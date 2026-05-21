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
