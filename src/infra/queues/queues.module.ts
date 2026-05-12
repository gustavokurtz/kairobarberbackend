import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { QUEUE_AI_VISAGISM, QUEUE_BILLING } from './queue-names';

@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: (cfg: ConfigService) => ({
        connection: { url: cfg.get<string>('REDIS_URL') },
      }),
      inject: [ConfigService],
    }),
    BullModule.registerQueue({ name: QUEUE_BILLING }, { name: QUEUE_AI_VISAGISM }),
  ],
  exports: [BullModule],
})
export class QueuesModule {}
