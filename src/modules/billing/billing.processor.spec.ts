import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { BillingProcessor } from './billing.processor';
import { BillingService } from './billing.service';
import { JOB_BILLING_SYNC, JOB_TRIAL_CHECK } from 'src/infra/queues/queue-names';

function mkJob(name: string): Job {
  return { name, data: {} } as unknown as Job;
}

describe('BillingProcessor', () => {
  let svc: { runBillingSync: jest.Mock; runTrialCheck: jest.Mock };
  let processor: BillingProcessor;

  beforeEach(() => {
    svc = {
      runBillingSync: jest.fn().mockResolvedValue({ processed: 3, failed: 0 }),
      runTrialCheck: jest.fn().mockResolvedValue({ trialExpired: 1, graceExpired: 0 }),
    };
    processor = new BillingProcessor(svc as unknown as BillingService, new Logger('test'));
  });

  it('dispara runBillingSync no job billing-sync', async () => {
    const res = await processor.process(mkJob(JOB_BILLING_SYNC));
    expect(svc.runBillingSync).toHaveBeenCalled();
    expect(res).toEqual({ processed: 3, failed: 0 });
  });

  it('dispara runTrialCheck no job trial-check', async () => {
    const res = await processor.process(mkJob(JOB_TRIAL_CHECK));
    expect(svc.runTrialCheck).toHaveBeenCalled();
    expect(res).toEqual({ trialExpired: 1, graceExpired: 0 });
  });

  it('job name desconhecido lança', async () => {
    await expect(processor.process(mkJob('outro'))).rejects.toThrow(/unknown job/i);
  });
});
