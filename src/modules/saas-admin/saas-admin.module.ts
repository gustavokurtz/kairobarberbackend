import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { SaasAdminController } from './saas-admin.controller';
import { SaasTenantsService } from './services/saas-tenants.service';
import { SaasTenantRepository } from './repositories/saas-tenant.repository';

@Module({
  imports: [PrismaModule],
  controllers: [SaasAdminController],
  providers: [SaasTenantsService, SaasTenantRepository],
})
export class SaasAdminModule {}
