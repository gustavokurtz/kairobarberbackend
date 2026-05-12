import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createHash, randomBytes } from 'crypto';
import { AiConsultation, AiConsultationStatus } from '@prisma/client';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { AuditService } from 'src/common/audit/audit.service';
import { AuditActions } from 'src/common/audit/audit-actions';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import {
  JOB_AI_ANALYSIS,
  JOB_AI_GENERATION,
  QUEUE_AI_VISAGISM,
} from 'src/infra/queues/queue-names';
import {
  ALLOWED_AI_PHOTO_CONTENT_TYPES,
  STORAGE_PROVIDER,
  extensionFromContentType,
} from 'src/modules/storage/storage.provider';
import type { StorageProvider } from 'src/modules/storage/storage.provider';
import { AiConsultationRepository } from './repositories/ai-consultation.repository';
import { QuotaService } from './quota/quota.service';
import { VisagismAnalysis } from './ai-visagism.types';

export interface CreateConsultationCmd {
  tenantId: string;
  customerId?: string | null;
  barberId?: string | null;
  photoBuffer: Buffer;
  photoMimeType: string;
  consentAcceptedAt: Date;
  requestNow: Date;
}

export interface CreateConsultationResult {
  id: string;
  viewToken: string;
  expiresAt: Date;
  status: AiConsultationStatus;
  quotaUsed: number;
  quotaLimit: number;
}

@Injectable()
export class AiVisagismService {
  private readonly retentionDays: number;
  private readonly maxBytes: number;
  private readonly minDimension: number;
  private readonly consentMaxAgeSeconds: number;

  constructor(
    private readonly repo: AiConsultationRepository,
    private readonly quota: QuotaService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @InjectQueue(QUEUE_AI_VISAGISM) private readonly queue: Queue,
    cfg: ConfigService,
    private readonly logger: Logger,
  ) {
    this.retentionDays = cfg.getOrThrow<number>('AI_VISAGISM_RETENTION_DAYS');
    this.maxBytes = cfg.getOrThrow<number>('AI_VISAGISM_PHOTO_MAX_BYTES');
    this.minDimension = cfg.getOrThrow<number>('AI_VISAGISM_PHOTO_MIN_DIMENSION');
    this.consentMaxAgeSeconds = cfg.getOrThrow<number>('AI_VISAGISM_CONSENT_MAX_AGE_SECONDS');
  }

  async create(cmd: CreateConsultationCmd): Promise<CreateConsultationResult> {
    // 1. Subscription active (trialing|active)
    await this.assertSubscriptionAllowed(cmd.tenantId);

    // 2. Consent age
    const ageSec = (cmd.requestNow.getTime() - cmd.consentAcceptedAt.getTime()) / 1000;
    if (ageSec < 0 || ageSec > this.consentMaxAgeSeconds) {
      throw new DomainException({
        code: ErrorCodes.AI_CONSENT_STALE,
        message: 'Consentimento expirado ou inválido. Por favor, aceite novamente.',
        status: HttpStatus.BAD_REQUEST,
      });
    }

    // 3. Photo validation
    await this.assertPhotoValid(cmd.photoBuffer, cmd.photoMimeType);

    // 4. Resolve optional FKs
    const customerId = await this.resolveOptionalCustomer(cmd.tenantId, cmd.customerId);
    const barberId = await this.resolveOptionalBarber(cmd.tenantId, cmd.barberId);

    // 5. Atomic quota charge
    const { used, limit } = await this.quota.chargeOrThrow(cmd.tenantId);

    let inputPhotoR2Key: string | null = null;
    try {
      // 6. Upload to R2
      const ext = extensionFromContentType(cmd.photoMimeType);
      const uploaded = await this.storage.uploadBuffer({
        tenantId: cmd.tenantId,
        buffer: cmd.photoBuffer,
        contentType: cmd.photoMimeType,
        extension: ext,
        prefix: 'ai-visagism/input',
      });
      inputPhotoR2Key = uploaded.r2Key;

      // 7. Generate token + create row
      const { plain, hash } = generateViewToken();
      const expiresAt = new Date(
        cmd.requestNow.getTime() + this.retentionDays * 24 * 60 * 60 * 1000,
      );
      const consultation = await this.repo.create({
        tenantId: cmd.tenantId,
        customerId,
        barberId,
        inputPhotoR2Key: uploaded.r2Key,
        viewTokenHash: hash,
        consentAcceptedAt: cmd.consentAcceptedAt,
        expiresAt,
      });

      // 8. Enqueue analysis
      await this.queue.add(
        JOB_AI_ANALYSIS,
        { consultationId: consultation.id, tenantId: cmd.tenantId },
        { attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 100 },
      );

      // 9. Audit
      await this.audit.record({
        action: AuditActions.AI_CONSULTATION_CREATED,
        tenantId: cmd.tenantId,
        targetType: 'ai_consultation',
        targetId: consultation.id,
        diff: { quotaUsed: used, quotaLimit: limit },
      });

      return {
        id: consultation.id,
        viewToken: plain,
        expiresAt,
        status: consultation.status,
        quotaUsed: used,
        quotaLimit: limit,
      };
    } catch (err) {
      // Compensation: refund quota, delete uploaded photo
      await this.quota.refund(cmd.tenantId);
      if (inputPhotoR2Key) {
        await this.storage.delete(inputPhotoR2Key);
      }
      this.logger.warn({
        event: 'ai_visagism.create_rolled_back',
        tenantId: cmd.tenantId,
        error: (err as Error).message,
      });
      throw err;
    }
  }

  async getByIdAndToken(id: string, plainToken: string): Promise<AiConsultation> {
    const hash = hashViewToken(plainToken);
    const found = await this.repo.findByIdAndTokenHash(id, hash);
    if (!found) {
      throw new DomainException({
        code: ErrorCodes.AI_CONSULTATION_NOT_FOUND,
        message: 'Consulta não encontrada.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    return found;
  }

  async requestImageGeneration(input: {
    consultationId: string;
    plainToken: string;
    suggestionId: string;
  }): Promise<{ status: AiConsultationStatus }> {
    const consultation = await this.getByIdAndToken(input.consultationId, input.plainToken);
    if (consultation.expiredAt) {
      throw new DomainException({
        code: ErrorCodes.AI_CONSULTATION_EXPIRED,
        message: 'Esta consulta expirou.',
        status: HttpStatus.GONE,
      });
    }
    // Generation already in flight / done — checar antes do status, pois status
    // `generating`/`generated` não passam pelo guard de `completed` mas representam
    // exatamente "já foi pedido".
    if (
      consultation.outputPhotoR2Key ||
      consultation.status === AiConsultationStatus.generating ||
      consultation.status === AiConsultationStatus.generated
    ) {
      throw new DomainException({
        code: ErrorCodes.AI_GENERATION_ALREADY_REQUESTED,
        message: 'A geração de imagem já foi feita para esta consulta.',
        status: HttpStatus.CONFLICT,
      });
    }
    if (consultation.status !== AiConsultationStatus.completed) {
      throw new DomainException({
        code: ErrorCodes.AI_CONSULTATION_NOT_READY,
        message: 'A análise ainda não está pronta.',
        status: HttpStatus.CONFLICT,
        details: { status: consultation.status },
      });
    }
    const analysis = consultation.analysisJson as VisagismAnalysis | null;
    if (!analysis) {
      throw new DomainException({
        code: ErrorCodes.AI_CONSULTATION_NOT_READY,
        message: 'Análise ausente.',
        status: HttpStatus.CONFLICT,
      });
    }
    const suggestion = analysis.suggestions.find((s) => s.id === input.suggestionId);
    if (!suggestion) {
      throw new DomainException({
        code: ErrorCodes.AI_SUGGESTION_NOT_FOUND,
        message: 'Sugestão não encontrada nesta consulta.',
        status: HttpStatus.NOT_FOUND,
      });
    }

    await this.repo.setGenerating(consultation.id);
    await this.queue.add(
      JOB_AI_GENERATION,
      {
        consultationId: consultation.id,
        tenantId: consultation.tenantId,
        suggestionId: suggestion.id,
      },
      { attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 100 },
    );
    return { status: AiConsultationStatus.generating };
  }

  async getGeneratedImageUrl(
    id: string,
    plainToken: string,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    const consultation = await this.getByIdAndToken(id, plainToken);
    if (consultation.expiredAt) {
      throw new DomainException({
        code: ErrorCodes.AI_CONSULTATION_EXPIRED,
        message: 'Esta consulta expirou.',
        status: HttpStatus.GONE,
      });
    }
    if (!consultation.outputPhotoR2Key) {
      throw new DomainException({
        code: ErrorCodes.AI_CONSULTATION_NOT_READY,
        message: 'Imagem ainda não gerada.',
        status: HttpStatus.CONFLICT,
        details: { status: consultation.status },
      });
    }
    const ttl = 300;
    const url = await this.storage.presignGet(consultation.outputPhotoR2Key, ttl);
    return { url, expiresInSeconds: ttl };
  }

  private async assertSubscriptionAllowed(tenantId: string): Promise<void> {
    const sub = await this.prisma.subscription.findUnique({ where: { tenantId } });
    if (!sub || sub.status === 'cancelled' || sub.status === 'past_due') {
      throw new DomainException({
        code: ErrorCodes.SUBSCRIPTION_INACTIVE,
        message: 'A barbearia não está com assinatura ativa.',
        status: HttpStatus.PAYMENT_REQUIRED,
      });
    }
  }

  private async assertPhotoValid(buffer: Buffer, declaredMime: string): Promise<void> {
    if (buffer.byteLength > this.maxBytes) {
      throw new DomainException({
        code: ErrorCodes.AI_PHOTO_TOO_LARGE,
        message: `Foto maior que ${this.maxBytes} bytes.`,
        status: HttpStatus.PAYLOAD_TOO_LARGE,
      });
    }
    if (!ALLOWED_AI_PHOTO_CONTENT_TYPES.has(declaredMime)) {
      throw new DomainException({
        code: ErrorCodes.AI_PHOTO_INVALID,
        message: 'Formato declarado inválido.',
        status: HttpStatus.BAD_REQUEST,
      });
    }

    // file-type is ESM-only — dynamic import.
    const fileType = await import('file-type');
    const detected = await fileType.fileTypeFromBuffer(buffer);
    if (!detected || !ALLOWED_AI_PHOTO_CONTENT_TYPES.has(detected.mime)) {
      throw new DomainException({
        code: ErrorCodes.AI_PHOTO_INVALID,
        message: 'Conteúdo do arquivo não confere com um JPEG/PNG/WebP válido.',
        status: HttpStatus.BAD_REQUEST,
      });
    }
    if (detected.mime !== declaredMime) {
      throw new DomainException({
        code: ErrorCodes.AI_PHOTO_INVALID,
        message: 'MIME declarado difere do conteúdo real.',
        status: HttpStatus.BAD_REQUEST,
      });
    }

    // image-size — version-sensitive import (v1 default export vs v2 named export)
    const sizeMod = await import('image-size');
    let dims: { width?: number; height?: number };
    if (typeof (sizeMod as { imageSize?: unknown }).imageSize === 'function') {
      dims = (
        sizeMod as unknown as { imageSize: (b: Buffer) => { width?: number; height?: number } }
      ).imageSize(buffer);
    } else if (typeof (sizeMod as { default?: unknown }).default === 'function') {
      dims = (
        sizeMod as unknown as { default: (b: Buffer) => { width?: number; height?: number } }
      ).default(buffer);
    } else {
      throw new Error('image-size: API incompatível com versão instalada');
    }
    const w = dims.width ?? 0;
    const h = dims.height ?? 0;
    if (w < this.minDimension || h < this.minDimension) {
      throw new DomainException({
        code: ErrorCodes.AI_PHOTO_TOO_SMALL,
        message: `Dimensão mínima ${this.minDimension}x${this.minDimension}.`,
        status: HttpStatus.BAD_REQUEST,
        details: { width: w, height: h, minDimension: this.minDimension },
      });
    }
  }

  private async resolveOptionalCustomer(
    tenantId: string,
    customerId?: string | null,
  ): Promise<string | null> {
    if (!customerId) return null;
    const c = await this.prisma.customer.findFirst({
      where: { id: customerId, tenantId, deletedAt: null },
      select: { id: true },
    });
    return c?.id ?? null;
  }

  private async resolveOptionalBarber(
    tenantId: string,
    barberId?: string | null,
  ): Promise<string | null> {
    if (!barberId) return null;
    const b = await this.prisma.barber.findFirst({
      where: { id: barberId, tenantId, deletedAt: null },
      select: { id: true },
    });
    return b?.id ?? null;
  }
}

export function generateViewToken(): { plain: string; hash: string } {
  const plain = randomBytes(32).toString('base64url');
  const hash = hashViewToken(plain);
  return { plain, hash };
}

export function hashViewToken(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}
