import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { QUEUE_BILLING } from './queue-names';

@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: (cfg: ConfigService) => ({
        connection: { url: cfg.get<string>('REDIS_URL') },
      }),
      inject: [ConfigService],
    }),
    BullModule.registerQueue({ name: QUEUE_BILLING }),
  ],
  exports: [BullModule],
})
export class QueuesModule {}
