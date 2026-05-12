-- CreateEnum
CREATE TYPE "AiConsultationStatus" AS ENUM ('queued', 'processing', 'completed', 'generating', 'generated', 'failed', 'expired');

-- CreateTable
CREATE TABLE "AiConsultation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT,
    "barberId" TEXT,
    "inputPhotoR2Key" TEXT,
    "outputPhotoR2Key" TEXT,
    "analysisJson" JSONB,
    "status" "AiConsultationStatus" NOT NULL DEFAULT 'queued',
    "providerCostCents" INTEGER NOT NULL DEFAULT 0,
    "viewTokenHash" TEXT NOT NULL,
    "consentAcceptedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "expiredAt" TIMESTAMP(3),
    "errorReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiConsultation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiConsultation_viewTokenHash_key" ON "AiConsultation"("viewTokenHash");

-- CreateIndex
CREATE INDEX "AiConsultation_tenantId_createdAt_idx" ON "AiConsultation"("tenantId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AiConsultation_status_expiresAt_idx" ON "AiConsultation"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "AiConsultation_status_createdAt_idx" ON "AiConsultation"("status", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "AiConsultation" ADD CONSTRAINT "AiConsultation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiConsultation" ADD CONSTRAINT "AiConsultation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiConsultation" ADD CONSTRAINT "AiConsultation_barberId_fkey" FOREIGN KEY ("barberId") REFERENCES "Barber"("id") ON DELETE SET NULL ON UPDATE CASCADE;
