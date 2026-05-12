-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "address" TEXT,
ADD COLUMN     "avatarUrl" TEXT,
ADD COLUMN     "bio" TEXT,
ADD COLUMN     "businessHours" JSONB,
ADD COLUMN     "phone" TEXT;

-- CreateTable
CREATE TABLE "Barber" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "displayName" TEXT NOT NULL,
    "bio" TEXT,
    "avatarUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Barber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeOff" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "barberId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimeOff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Service" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "durationMin" INTEGER NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceBarber" (
    "tenantId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "barberId" TEXT NOT NULL,

    CONSTRAINT "ServiceBarber_pkey" PRIMARY KEY ("serviceId","barberId")
);

-- CreateTable
CREATE TABLE "Photo" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "r2Key" TEXT NOT NULL,
    "caption" TEXT,
    "serviceId" TEXT,
    "barberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Photo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BarberInvitation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "barberId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BarberInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Barber_userId_key" ON "Barber"("userId");

-- CreateIndex
CREATE INDEX "Barber_tenantId_deletedAt_idx" ON "Barber"("tenantId", "deletedAt");

-- CreateIndex
CREATE INDEX "TimeOff_tenantId_barberId_startsAt_idx" ON "TimeOff"("tenantId", "barberId", "startsAt");

-- CreateIndex
CREATE INDEX "Service_tenantId_deletedAt_idx" ON "Service"("tenantId", "deletedAt");

-- CreateIndex
CREATE INDEX "ServiceBarber_tenantId_idx" ON "ServiceBarber"("tenantId");

-- CreateIndex
CREATE INDEX "Photo_tenantId_deletedAt_idx" ON "Photo"("tenantId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BarberInvitation_barberId_key" ON "BarberInvitation"("barberId");

-- CreateIndex
CREATE UNIQUE INDEX "BarberInvitation_tokenHash_key" ON "BarberInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "BarberInvitation_tenantId_idx" ON "BarberInvitation"("tenantId");

-- CreateIndex
CREATE INDEX "BarberInvitation_email_idx" ON "BarberInvitation"("email");

-- AddForeignKey
ALTER TABLE "Barber" ADD CONSTRAINT "Barber_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Barber" ADD CONSTRAINT "Barber_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeOff" ADD CONSTRAINT "TimeOff_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeOff" ADD CONSTRAINT "TimeOff_barberId_fkey" FOREIGN KEY ("barberId") REFERENCES "Barber"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceBarber" ADD CONSTRAINT "ServiceBarber_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceBarber" ADD CONSTRAINT "ServiceBarber_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceBarber" ADD CONSTRAINT "ServiceBarber_barberId_fkey" FOREIGN KEY ("barberId") REFERENCES "Barber"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_barberId_fkey" FOREIGN KEY ("barberId") REFERENCES "Barber"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BarberInvitation" ADD CONSTRAINT "BarberInvitation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BarberInvitation" ADD CONSTRAINT "BarberInvitation_barberId_fkey" FOREIGN KEY ("barberId") REFERENCES "Barber"("id") ON DELETE CASCADE ON UPDATE CASCADE;
