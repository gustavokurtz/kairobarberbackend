-- Migration: User email case-insensitive uniqueness
-- Spec: docs/superpowers/specs/2026-05-21-billing-hardening-v2-design.md R-F1-07

-- Step 1: normalize existing rows (idempotente; sem efeito se já estão lowercase pela T4)
UPDATE "User" SET email = LOWER(TRIM(email)) WHERE email <> LOWER(TRIM(email));

-- Step 2: drop legacy unique constraint
ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_email_key";

-- Step 3: create functional unique index (falha-rápido se houver duplicates case-insensitive)
CREATE UNIQUE INDEX "user_email_lower_unique" ON "User" (LOWER(email));
