import { Module } from '@nestjs/common';
import { ServicesController } from './services.controller';
import { ServicesService } from './services.service';
import { ServiceRepository } from './repositories/service.repository';

@Module({
  controllers: [ServicesController],
  providers: [ServicesService, ServiceRepository],
  exports: [ServicesService, ServiceRepository],
})
export class CatalogModule {}
