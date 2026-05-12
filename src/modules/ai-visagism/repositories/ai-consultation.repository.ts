import { Injectable } from '@nestjs/common';
import { AiConsultation, AiConsultationStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface CreateConsultationInput {
  tenantId: string;
  customerId?: string | null;
  barberId?: string | null;
  inputPhotoR2Key: string;
  viewTokenHash: string;
  consentAcceptedAt: Date;
  expiresAt: Date;
}

@Injectable()
export class AiConsultationRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateConsultationInput): Promise<AiConsultation> {
    return this.prisma.aiConsultation.create({
      data: {
        tenantId: input.tenantId,
        customerId: input.customerId ?? null,
        barberId: input.barberId ?? null,
        inputPhotoR2Key: input.inputPhotoR2Key,
        viewTokenHash: input.viewTokenHash,
        consentAcceptedAt: input.consentAcceptedAt,
        expiresAt: input.expiresAt,
        status: AiConsultationStatus.queued,
      },
    });
  }

  findById(id: string): Promise<AiConsultation | null> {
    return this.prisma.aiConsultation.findUnique({ where: { id } });
  }

  findByIdAndTokenHash(id: string, tokenHash: string): Promise<AiConsultation | null> {
    return this.prisma.aiConsultation.findFirst({
      where: { id, viewTokenHash: tokenHash },
    });
  }

  setProcessing(id: string): Promise<AiConsultation> {
    return this.prisma.aiConsultation.update({
      where: { id },
      data: { status: AiConsultationStatus.processing },
    });
  }

  setCompleted(input: {
    id: string;
    analysisJson: Prisma.InputJsonValue;
    costCentsToAdd: number;
  }): Promise<AiConsultation> {
    return this.prisma.aiConsultation.update({
      where: { id: input.id },
      data: {
        status: AiConsultationStatus.completed,
        analysisJson: input.analysisJson,
        providerCostCents: { increment: input.costCentsToAdd },
      },
    });
  }

  setGenerating(id: string): Promise<AiConsultation> {
    return this.prisma.aiConsultation.update({
      where: { id },
      data: { status: AiConsultationStatus.generating },
    });
  }

  setGenerated(input: {
    id: string;
    outputPhotoR2Key: string;
    costCentsToAdd: number;
  }): Promise<AiConsultation> {
    return this.prisma.aiConsultation.update({
      where: { id: input.id },
      data: {
        status: AiConsultationStatus.generated,
        outputPhotoR2Key: input.outputPhotoR2Key,
        providerCostCents: { increment: input.costCentsToAdd },
      },
    });
  }

  setFailed(input: { id: string; errorReason: string }): Promise<AiConsultation> {
    return this.prisma.aiConsultation.update({
      where: { id: input.id },
      data: { status: AiConsultationStatus.failed, errorReason: input.errorReason },
    });
  }

  /** Marca como expirado e zera dados sensíveis. Idempotente. */
  async markExpiredIfDue(id: string): Promise<{
    updated: boolean;
    previousInputKey: string | null;
    previousOutputKey: string | null;
  }> {
    const current = await this.prisma.aiConsultation.findUnique({ where: { id } });
    if (!current || current.expiredAt !== null) {
      return { updated: false, previousInputKey: null, previousOutputKey: null };
    }
    await this.prisma.aiConsultation.update({
      where: { id },
      data: {
        expiredAt: new Date(),
        inputPhotoR2Key: null,
        outputPhotoR2Key: null,
        analysisJson: Prisma.DbNull,
        status: AiConsultationStatus.expired,
      },
    });
    return {
      updated: true,
      previousInputKey: current.inputPhotoR2Key,
      previousOutputKey: current.outputPhotoR2Key,
    };
  }

  /** Pega consultations expiradas que ainda não foram limpas (LIMIT batchSize). */
  findDueForCleanup(now: Date, batchSize: number): Promise<AiConsultation[]> {
    return this.prisma.aiConsultation.findMany({
      where: { expiredAt: null, expiresAt: { lt: now } },
      orderBy: { expiresAt: 'asc' },
      take: batchSize,
    });
  }

  /** Snapshot para `/saas/ai-usage?detailed=true`. */
  listRecentByTenant(tenantId: string, take: number): Promise<AiConsultation[]> {
    return this.prisma.aiConsultation.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }
}
