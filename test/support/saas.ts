import { INestApplication } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { PasswordService } from 'src/modules/auth/password.service';
import { TokensService } from 'src/modules/auth/tokens.service';

export async function createSaasOwner(
  app: INestApplication,
  overrides: { email?: string; name?: string; password?: string } = {},
): Promise<{ id: string; email: string; accessToken: string }> {
  const prisma = app.get(PrismaService);
  const password = app.get(PasswordService);
  const tokens = app.get(TokensService);

  const email = overrides.email ?? 'saas@kairobarber.test';
  const name = overrides.name ?? 'SaaS Owner';
  const passwordHash = await password.hash(overrides.password ?? 'SuperSafe!1');
  const user = await prisma.user.create({
    data: { email, name, passwordHash, role: UserRole.saas_owner, emailVerifiedAt: new Date() },
  });
  const pair = await tokens.issuePair({ userId: user.id, role: user.role });
  return { id: user.id, email: user.email, accessToken: pair.accessToken };
}

// Hash determinístico do slug pra X-Forwarded-For: cada chamada vira "cliente"
// distinto pro throttler, evitando bater no @Throttle(3/60s) do /auth/register/owner
// quando specs fazem múltiplos signups. Funciona porque o custom
// ThrottlerBehindProxyGuard usa req.ips[0] (populado via trust proxy nos e2e).
function slugToFakeIp(slug: string): string {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return `10.${(h >>> 16) & 0xff}.${(h >>> 8) & 0xff}.${h & 0xff}`;
}

export async function createTenantOwner(
  app: INestApplication,
  slug: string,
  email: string,
): Promise<{ accessToken: string; tenantId: string; userId: string }> {
  const server = app.getHttpServer() as unknown as import('http').Server;
  const reg = await request(server)
    .post('/auth/register/owner')
    .set('X-Forwarded-For', slugToFakeIp(slug))
    .send({
      email,
      password: 'StrongPass!1',
      name: `Owner ${slug}`,
      tenantName: `Tenant ${slug}`,
      slug,
    })
    .expect(201);
  const body = reg.body as {
    accessToken: string;
    tenant: { id: string };
    user: { id: string };
  };
  return { accessToken: body.accessToken, tenantId: body.tenant.id, userId: body.user.id };
}
