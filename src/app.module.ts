import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerBehindProxyGuard } from './common/guards/throttler-behind-proxy.guard';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './infra/prisma/prisma.module';
import { AuditModule } from './common/audit/audit.module';
import { RedisModule } from './infra/redis/redis.module';
import { QueuesModule } from './infra/queues/queues.module';
import { buildLoggerOptions } from './infra/logger/logger.config';
import { HealthModule } from './modules/health/health.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { StorageModule } from './modules/storage/storage.module';
import { AuthModule } from './modules/auth/auth.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { BarbersModule } from './modules/barbers/barbers.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { CustomersModule } from './modules/customers/customers.module';
import { SchedulingModule } from './modules/scheduling/scheduling.module';
import { PublicModule } from './modules/public/public.module';
import { BillingModule } from './modules/billing/billing.module';
import { AiVisagismModule } from './modules/ai-visagism/ai-visagism.module';
import { SaasAdminModule } from './modules/saas-admin/saas-admin.module';
import { SubscriptionActiveGuard } from './common/guards/subscription-active.guard';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      useFactory: () => buildLoggerOptions(process.env),
    }),
    ThrottlerModule.forRoot([
      {
        ttl: Number(process.env.THROTTLE_TTL ?? 60) * 1000,
        // Global default subido de 10 -> 60. Dashboard SaaS autenticado faz
        // facilmente 20-30 req/min (status polling, multi-tab, refreshes). Endpoints
        // com side-effect (signup, checkout) sobrescrevem com @Throttle local.
        limit: Number(process.env.THROTTLE_LIMIT ?? 60),
      },
    ]),
    PrismaModule,
    AuditModule,
    RedisModule,
    QueuesModule,
    NotificationsModule,
    StorageModule,
    AuthModule,
    TenantsModule,
    BarbersModule,
    CatalogModule,
    CustomersModule,
    SchedulingModule,
    PublicModule,
    BillingModule,
    AiVisagismModule,
    SaasAdminModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerBehindProxyGuard },
    { provide: APP_GUARD, useClass: SubscriptionActiveGuard },
  ],
})
export class AppModule {}
