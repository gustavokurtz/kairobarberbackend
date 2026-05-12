import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import {
  JOB_AI_CLEANUP,
  JOB_AI_QUOTA_RESET,
  QUEUE_AI_VISAGISM,
} from 'src/infra/queues/queue-names';
import {
  AI_VISAGISM_CLEANUP_SCHEDULER_KEY,
  AI_VISAGISM_QUOTA_RESET_SCHEDULER_KEY,
} from './ai-visagism.constants';

@Injectable()
export class AiVisagismSchedules implements OnApplicationBootstrap {
  private readonly logger = new Logger(AiVisagismSchedules.name);

  constructor(
    @InjectQueue(QUEUE_AI_VISAGISM) private readonly queue: Queue,
    private readonly cfg: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.cfg.get<string>('NODE_ENV') === 'test') {
      this.logger.log({ event: 'ai_visagism.schedules_skipped', reason: 'NODE_ENV=test' });
      return;
    }
    const cleanupCron = this.cfg.get<string>('AI_VISAGISM_CLEANUP_CRON') ?? '0 3 * * *';
    const quotaResetCron = this.cfg.get<string>('AI_VISAGISM_QUOTA_RESET_CRON') ?? '5 0 1 * *';

    await this.queue.upsertJobScheduler(
      AI_VISAGISM_CLEANUP_SCHEDULER_KEY,
      { pattern: cleanupCron, tz: 'UTC' },
      { name: JOB_AI_CLEANUP, data: {} },
    );
    await this.queue.upsertJobScheduler(
      AI_VISAGISM_QUOTA_RESET_SCHEDULER_KEY,
      { pattern: quotaResetCron, tz: 'UTC' },
      { name: JOB_AI_QUOTA_RESET, data: {} },
    );

    this.logger.log({
      event: 'ai_visagism.schedules_registered',
      cleanupCron,
      quotaResetCron,
    });
  }
}
