import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUE_BILLING, JOB_BILLING_SYNC, JOB_TRIAL_CHECK } from 'src/infra/queues/queue-names';
import { BillingService } from './billing.service';

@Processor(QUEUE_BILLING)
export class BillingProcessor extends WorkerHost {
  constructor(
    private readonly billing: BillingService,
    private readonly logger: Logger,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    this.logger.log({ event: 'billing.job_started', name: job.name });
    if (job.name === JOB_BILLING_SYNC) {
      return this.billing.runBillingSync();
    }
    if (job.name === JOB_TRIAL_CHECK) {
      return this.billing.runTrialCheck();
    }
    throw new Error(`unknown job: ${job.name}`);
  }
}
