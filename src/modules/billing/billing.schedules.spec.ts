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

  describe('onApplicationBootstrap — falha de Redis/BullMQ', () => {
    it('re-throws com mensagem específica se upsertJobScheduler rejeitar', async () => {
      const queue = mkQueue();
      (queue.upsertJobScheduler as jest.Mock).mockRejectedValueOnce(
        new Error('ECONNREFUSED 127.0.0.1:6379'),
      );
      const schedules = new BillingSchedules(queue, mkConfig());

      await expect(schedules.onApplicationBootstrap()).rejects.toThrow(
        /Failed to register billing schedulers.*ECONNREFUSED/,
      );
    });

    it('loga billing.schedules_registration_failed antes do re-throw (com error e stack)', async () => {
      const queue = mkQueue();
      const upstreamError = new Error('Redis offline');
      (queue.upsertJobScheduler as jest.Mock).mockRejectedValueOnce(upstreamError);
      const schedules = new BillingSchedules(queue, mkConfig());

      const errorSpy = jest
        .spyOn((schedules as unknown as { logger: { error: jest.Mock } }).logger, 'error')
        .mockImplementation(() => undefined as never);

      await expect(schedules.onApplicationBootstrap()).rejects.toThrow();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const payload = errorSpy.mock.calls[0][0] as {
        event: string;
        error: string;
        stack: string;
      };
      expect(payload.event).toBe('billing.schedules_registration_failed');
      expect(payload.error).toBe('Redis offline');
      expect(payload.stack).toMatch(/.+/);
    });
  });
});
