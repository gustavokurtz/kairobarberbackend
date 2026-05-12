import { Global, Logger, Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { AuditRepository } from './audit.repository';
import { AuditService } from './audit.service';

@Global()
@Module({
  imports: [PrismaModule],
  providers: [AuditService, AuditRepository, Logger],
  exports: [AuditService, AuditRepository],
})
export class AuditModule {}
