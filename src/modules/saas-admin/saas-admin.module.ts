import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { SaasAdminController } from './saas-admin.controller';
import { SaasTenantsService } from './services/saas-tenants.service';
import { SaasTenantRepository } from './repositories/saas-tenant.repository';
import { SaasMetricsService } from './services/saas-metrics.service';
import { SaasSubscriptionRepository } from './repositories/saas-subscription.repository';

@Module({
  imports: [PrismaModule],
  controllers: [SaasAdminController],
  providers: [
    SaasTenantsService,
    SaasTenantRepository,
    SaasMetricsService,
    SaasSubscriptionRepository,
  ],
})
export class SaasAdminModule {}
