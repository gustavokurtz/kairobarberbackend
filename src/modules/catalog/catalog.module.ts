import { Module } from '@nestjs/common';
import { BarbersModule } from 'src/modules/barbers/barbers.module';
import { ServicesController } from './services.controller';
import { ServicesService } from './services.service';
import { ServiceRepository } from './repositories/service.repository';
import { PhotosController } from './photos.controller';
import { PhotosService } from './photos.service';
import { PhotoRepository } from './repositories/photo.repository';

@Module({
  imports: [BarbersModule],
  controllers: [ServicesController, PhotosController],
  providers: [ServicesService, ServiceRepository, PhotosService, PhotoRepository],
  exports: [ServicesService, ServiceRepository, PhotosService, PhotoRepository],
})
export class CatalogModule {}
