import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import {
  ALLOWED_PHOTO_CONTENT_TYPES,
  PHOTO_MAX_BYTES,
  STORAGE_PROVIDER,
  extensionFromContentType,
} from 'src/modules/storage/storage.provider';
import type { StorageProvider } from 'src/modules/storage/storage.provider';
import { PhotoRepository } from './repositories/photo.repository';
import { CreatePhotoDto } from './dto/create-photo.dto';
import { UpdatePhotoDto } from './dto/update-photo.dto';

const UPLOAD_URL_TTL_SECONDS = 60;

@Injectable()
export class PhotosService {
  constructor(
    private readonly repo: PhotoRepository,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  list() {
    return this.repo.list();
  }

  async createUploadUrl(tenantId: string, contentType: string) {
    if (!ALLOWED_PHOTO_CONTENT_TYPES.has(contentType)) {
      throw new DomainException({
        code: ErrorCodes.STORAGE_CONTENT_TYPE_INVALID,
        message: `Content type não suportado: ${contentType}.`,
        status: HttpStatus.BAD_REQUEST,
        details: { allowed: Array.from(ALLOWED_PHOTO_CONTENT_TYPES) },
      });
    }
    const presigned = await this.storage.presignUpload({
      tenantId,
      contentType,
      extension: extensionFromContentType(contentType),
      maxBytes: PHOTO_MAX_BYTES,
      ttlSeconds: UPLOAD_URL_TTL_SECONDS,
    });
    return presigned;
  }

  confirm(dto: CreatePhotoDto) {
    return this.repo.create({
      r2Key: dto.r2Key,
      caption: dto.caption,
      serviceId: dto.serviceId,
      barberId: dto.barberId,
    });
  }

  async update(id: string, dto: UpdatePhotoDto) {
    const photo = await this.repo.findById(id);
    if (!photo) {
      throw new DomainException({
        code: ErrorCodes.PHOTO_NOT_FOUND,
        message: 'Foto não encontrada.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    // null explícito = remove vínculo; ausente = mantém.
    const data: {
      caption?: string | null;
      serviceId?: string | null;
      barberId?: string | null;
    } = {};
    if (dto.caption !== undefined) data.caption = dto.caption;
    if (dto.serviceId !== undefined) data.serviceId = dto.serviceId;
    if (dto.barberId !== undefined) data.barberId = dto.barberId;
    return this.repo.update(id, data);
  }

  async delete(id: string) {
    const photo = await this.repo.findById(id);
    if (!photo) {
      throw new DomainException({
        code: ErrorCodes.PHOTO_NOT_FOUND,
        message: 'Foto não encontrada.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    // Storage cleanup deferred to cron (LGPD job — Phase 6). DB soft-delete is the source of truth.
    await this.repo.softDelete(id);
  }
}
