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

export async function createTenantOwner(
  app: INestApplication,
  slug: string,
  email: string,
): Promise<{ accessToken: string; tenantId: string; userId: string }> {
  const server = app.getHttpServer() as unknown as import('http').Server;
  const reg = await request(server)
    .post('/auth/register/owner')
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
