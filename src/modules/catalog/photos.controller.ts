import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { TenantGuard } from 'src/common/guards/tenant.guard';
import { CurrentTenant } from 'src/common/decorators/current-tenant.decorator';
import { PhotosService } from './photos.service';
import { CreatePhotoUploadUrlDto } from './dto/create-photo-upload-url.dto';
import { CreatePhotoDto } from './dto/create-photo.dto';

@Controller('admin/photos')
@UseGuards(TenantGuard)
export class PhotosController {
  constructor(private readonly photos: PhotosService) {}

  @Get()
  list() {
    return this.photos.list();
  }

  @Post('upload-url')
  @HttpCode(HttpStatus.OK)
  createUploadUrl(@CurrentTenant() tenantId: string, @Body() dto: CreatePhotoUploadUrlDto) {
    return this.photos.createUploadUrl(tenantId, dto.contentType);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  confirm(@Body() dto: CreatePhotoDto) {
    return this.photos.confirm(dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Param('id') id: string) {
    await this.photos.delete(id);
  }
}
