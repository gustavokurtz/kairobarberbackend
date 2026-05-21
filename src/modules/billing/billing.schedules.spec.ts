import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { BillingSchedules } from './billing.schedules';
import { BILLING_SYNC_JOB_KEY, TRIAL_CHECK_JOB_KEY } from './billing.constants';
import { JOB_BILLING_SYNC, JOB_TRIAL_CHECK } from 'src/infra/queues/queue-names';

function mkQueue() {
  return {
    upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
  } as unknown as Queue & { upsertJobScheduler: jest.Mock };
}

function mkConfig(map: Record<string, unknown> = {}): ConfigService {
  const merged: Record<string, unknown> = {
    NODE_ENV: 'development',
    BILLING_SYNC_CRON: '0 * * * *',
    BILLING_TRIAL_CHECK_CRON: '15 6 * * *',
    ...map,
  };
  return {
    get: (k: string) => merged[k],
    getOrThrow: (k: string) => {
      if (!(k in merged)) throw new Error(`Configuration key "${k}" does not exist`);
      return merged[k];
    },
  } as unknown as ConfigService;
}

describe('BillingSchedules', () => {
  describe('onApplicationBootstrap — happy path', () => {
    it('registra os 2 schedulers (sync + trial-check) com os crons da config', async () => {
      const queue = mkQueue();
      const schedules = new BillingSchedules(queue, mkConfig());

      await schedules.onApplicationBootstrap();

      expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(2);
      expect(queue.upsertJobScheduler).toHaveBeenNthCalledWith(
        1,
        BILLING_SYNC_JOB_KEY,
        { pattern: '0 * * * *', tz: 'UTC' },
        { name: JOB_BILLING_SYNC, data: {} },
      );
      expect(queue.upsertJobScheduler).toHaveBeenNthCalledWith(
        2,
        TRIAL_CHECK_JOB_KEY,
        { pattern: '15 6 * * *', tz: 'UTC' },
        { name: JOB_TRIAL_CHECK, data: {} },
      );
    });

    it('skip silencioso quando NODE_ENV=test (não registra nada)', async () => {
      const queue = mkQueue();
      const schedules = new BillingSchedules(queue, mkConfig({ NODE_ENV: 'test' }));

      await schedules.onApplicationBootstrap();

      expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    });
  });
});
