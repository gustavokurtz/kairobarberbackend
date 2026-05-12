import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { SaasAdminController } from './saas-admin.controller';

@Module({
  imports: [PrismaModule],
  controllers: [SaasAdminController],
})
export class SaasAdminModule {}
