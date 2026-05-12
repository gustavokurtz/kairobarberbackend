import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { StorageModule } from 'src/modules/storage/storage.module';
import { QUEUE_AI_VISAGISM } from 'src/infra/queues/queue-names';
import { AiVisagismService } from './ai-visagism.service';
import { AiVisagismProcessor } from './ai-visagism.processor';
import { AiVisagismSchedules } from './ai-visagism.schedules';
import { AiConsultationRepository } from './repositories/ai-consultation.repository';
import { QuotaService } from './quota/quota.service';
import { QuotaRepository } from './quota/quota.repository';
import { PublicAiVisagismController } from './ai-visagism.public-controller';
import { VISAGISM_PROVIDER } from './ai-visagism.constants';
import { ConsoleVisagismProvider } from './providers/console-visagism.provider';
import { AiSdkVisagismProvider } from './providers/ai-sdk-visagism.provider';

@Module({
  imports: [PrismaModule, StorageModule, BullModule.registerQueue({ name: QUEUE_AI_VISAGISM })],
  controllers: [PublicAiVisagismController],
  providers: [
    AiVisagismService,
    AiVisagismProcessor,
    AiVisagismSchedules,
    AiConsultationRepository,
    QuotaService,
    QuotaRepository,
    Logger,
    {
      provide: VISAGISM_PROVIDER,
      useFactory: (cfg: ConfigService): unknown => {
        const which = cfg.get<string>('AI_VISAGISM_PROVIDER');
        if (which === 'aisdk') return new AiSdkVisagismProvider(cfg);
        return new ConsoleVisagismProvider();
      },
      inject: [ConfigService],
    },
  ],
  exports: [AiVisagismService, AiConsultationRepository],
})
export class AiVisagismModule {}
