import { PrismaClient, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';

async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PROD_SEED !== 'true') {
    throw new Error(
      'Seed bloqueado em produção. Defina ALLOW_PROD_SEED=true se realmente quer rodar.',
    );
  }
  const email = process.env.SAAS_OWNER_EMAIL ?? 'saas-owner@kairobarber.dev';
  const name = process.env.SAAS_OWNER_NAME ?? 'SaaS Owner';
  const password = process.env.SAAS_OWNER_PASSWORD ?? 'ChangeMe!1234';

  const prisma = new PrismaClient();
  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

    if (existing) {
      if (existing.role !== UserRole.saas_owner) {
        throw new Error(
          `Usuário ${email} já existe mas role é ${existing.role}, não saas_owner. Aborta.`,
        );
      }
      await prisma.user.update({
        where: { id: existing.id },
        data: { passwordHash, name, emailVerifiedAt: existing.emailVerifiedAt ?? new Date() },
      });
      // eslint-disable-next-line no-console
      console.log(`[seed] saas_owner atualizado: ${email}`);
    } else {
      await prisma.user.create({
        data: {
          email,
          name,
          passwordHash,
          role: UserRole.saas_owner,
          emailVerifiedAt: new Date(),
        },
      });
      // eslint-disable-next-line no-console
      console.log(`[seed] saas_owner criado: ${email}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[seed] erro:', err);
  process.exit(1);
});
