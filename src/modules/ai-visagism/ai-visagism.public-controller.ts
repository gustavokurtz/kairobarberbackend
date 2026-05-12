import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
  HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { CurrentTenant } from 'src/common/decorators/current-tenant.decorator';
import { Public } from 'src/common/decorators/public.decorator';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { AiVisagismService } from './ai-visagism.service';
import { CreateConsultationDto } from './dto/create-consultation.dto';
import { ViewConsultationQueryDto } from './dto/view-consultation-query.dto';
import { GenerateImageDto } from './dto/generate-image.dto';

/** Tipagem inline de upload (evita depender de @types/multer). */
interface UploadedPhoto {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname: string;
}

@Controller()
@Public()
export class PublicAiVisagismController {
  constructor(private readonly service: AiVisagismService) {}

  // POST /public/:slug/ai/visagism/consultations  (multipart, field "photo")
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('public/:slug/ai/visagism/consultations')
  @UseInterceptors(FileInterceptor('photo'))
  async create(
    @Param('slug') _slug: string,
    @CurrentTenant() tenantId: string,
    @UploadedFile() photo: UploadedPhoto | undefined,
    @Body() body: CreateConsultationDto,
  ) {
    if (!photo) {
      throw new DomainException({
        code: ErrorCodes.AI_PHOTO_INVALID,
        message: 'Foto ausente. Envie o campo "photo" via multipart/form-data.',
        status: HttpStatus.BAD_REQUEST,
      });
    }
    const consentAt = new Date(body.consentAcceptedAt);
    if (Number.isNaN(consentAt.getTime())) {
      throw new BadRequestException('consentAcceptedAt inválido');
    }

    const result = await this.service.create({
      tenantId,
      customerId: body.customerId ?? null,
      barberId: body.barberId ?? null,
      photoBuffer: photo.buffer,
      photoMimeType: photo.mimetype,
      consentAcceptedAt: consentAt,
      requestNow: new Date(),
    });

    return {
      id: result.id,
      viewToken: result.viewToken,
      expiresAt: result.expiresAt.toISOString(),
      status: result.status,
      quota: { used: result.quotaUsed, limit: result.quotaLimit },
    };
  }

  // GET /public/ai/visagism/consultations/:id?token=
  @Get('public/ai/visagism/consultations/:id')
  async get(@Param('id') id: string, @Query() q: ViewConsultationQueryDto) {
    const c = await this.service.getByIdAndToken(id, q.token);
    return {
      id: c.id,
      status: c.status,
      expiresAt: c.expiresAt.toISOString(),
      expiredAt: c.expiredAt?.toISOString() ?? null,
      analysis: c.analysisJson,
      hasGeneratedImage: c.outputPhotoR2Key !== null,
      errorReason: c.errorReason,
      providerCostCents: c.providerCostCents,
    };
  }

  // POST /public/ai/visagism/consultations/:id/generate-image?token=
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('public/ai/visagism/consultations/:id/generate-image')
  async generate(
    @Param('id') id: string,
    @Query() q: ViewConsultationQueryDto,
    @Body() body: GenerateImageDto,
  ) {
    return this.service.requestImageGeneration({
      consultationId: id,
      plainToken: q.token,
      suggestionId: body.suggestionId,
    });
  }

  // GET /public/ai/visagism/consultations/:id/image?token=
  @Get('public/ai/visagism/consultations/:id/image')
  async getImageUrl(
    @Param('id') id: string,
    @Query() q: ViewConsultationQueryDto,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    return this.service.getGeneratedImageUrl(id, q.token);
  }
}
