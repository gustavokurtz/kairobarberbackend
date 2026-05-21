-- DropIndex (safe: constraint já foi dropado por 20260521172819_user_email_case_insensitive)
-- Prisma detectou drift entre schema (sem @unique) e histórico de migrations.
-- Esta migration é redundante mas necessária para o histórico ficar em sync.
DROP INDEX IF EXISTS "User_email_key";
