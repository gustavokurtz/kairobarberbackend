import { Module } from '@nestjs/common';
import { BarbersModule } from 'src/modules/barbers/barbers.module';
import { ServicesController } from './services.controller';
import { ServicesService } from './services.service';
import { ServiceRepository } from './repositories/service.repository';

@Module({
  imports: [BarbersModule],
  controllers: [ServicesController],
  providers: [ServicesService, ServiceRepository],
  exports: [ServicesService, ServiceRepository],
})
export class CatalogModule {}
