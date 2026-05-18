import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { QUEUE_BILLING } from 'src/infra/queues/queue-names';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { RedisModule } from 'src/infra/redis/redis.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { BillingProcessor } from './billing.processor';
import { BillingSchedules } from './billing.schedules';
import { SubscriptionRepository } from './repositories/subscription.repository';
import { BILLING_PROVIDER, BillingProvider } from './providers/billing.provider';
import { MercadopagoBillingProvider } from './providers/mercadopago.billing-provider';
import { ConsoleBillingProvider } from './providers/console.billing-provider';

@Module({
  imports: [PrismaModule, RedisModule, BullModule.registerQueue({ name: QUEUE_BILLING })],
  controllers: [BillingController],
  providers: [
    BillingService,
    SubscriptionRepository,
    BillingProcessor,
    BillingSchedules,
    Logger,
    {
      provide: BILLING_PROVIDER,
      useFactory: (cfg: ConfigService): BillingProvider => {
        const provider = cfg.get<string>('BILLING_PROVIDER');
        if (provider === 'console') {
          return new ConsoleBillingProvider({
            returnUrl:
              cfg.get<string>('MP_RETURN_URL') ?? 'http://localhost:3001/admin/billing/return',
          });
        }
        if (provider === 'mercadopago') {
          const accessToken = cfg.get<string>('MP_ACCESS_TOKEN');
          const apiBaseUrl = cfg.get<string>('MP_API_BASE_URL');
          const returnUrl = cfg.get<string>('MP_RETURN_URL');
          if (!accessToken || !apiBaseUrl) {
            throw new Error(
              'MP_ACCESS_TOKEN and MP_API_BASE_URL are required when BILLING_PROVIDER=mercadopago',
            );
          }
          // returnUrl é opcional: MP só aceita HTTPS público em back_url, então em dev/MVP
          // omitimos. Usuário paga e volta manualmente pro /admin/billing.
          return new MercadopagoBillingProvider({
            accessToken,
            apiBaseUrl,
            returnUrl: returnUrl || undefined,
          });
        }
        throw new Error(`Unsupported BILLING_PROVIDER: ${provider}`);
      },
      inject: [ConfigService],
    },
  ],
  exports: [BillingService, SubscriptionRepository],
})
export class BillingModule {}
