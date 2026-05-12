import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { BarberInvitationsService } from 'src/modules/barbers/barber-invitations.service';

interface AuthResponse {
  user: { id: string; email: string; role: string };
  tenant?: { id: string; slug: string };
  accessToken: string;
  refreshToken: string;
  tenantId?: string;
}

interface BarberResponse {
  id: string;
  displayName: string;
}

interface ServiceResponse {
  id: string;
  name: string;
  durationMin: number;
  priceCents: number;
}

interface PhotoUploadUrlResponse {
  uploadUrl: string;
  r2Key: string;
  expiresAt: string;
  contentType: string;
  maxBytes: number;
}

interface PhotoResponse {
  id: string;
  r2Key: string;
}

interface TenantResponse {
  id: string;
  slug: string;
  name: string;
  bio: string | null;
  address: string | null;
  businessHours: unknown;
}

describe('Painel do Barbeiro — configura barbearia inteira (e2e)', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    setTestEnv();
    process.env.STORAGE_PROVIDER = 'console';
    container = await startTestPostgres();
    app = await buildTestApp();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('configura perfil, horário, 3 barbeiros, 5 serviços, 10 fotos (acceptance)', async () => {
    // ---- 1. Cadastra owner + tenant
    const reg = await request(app.getHttpServer())
      .post('/auth/register/owner')
      .send({
        email: 'dono@barbearia.test',
        password: 'StrongPass!1',
        name: 'Dono',
        tenantName: 'Studio do Bigode',
        slug: 'studio-bigode',
      })
      .expect(201);
    const ownerAuth = reg.body as AuthResponse;
    const ownerToken = ownerAuth.accessToken;

    // ---- 2. PATCH /admin/tenant — perfil
    await request(app.getHttpServer())
      .patch('/admin/tenant')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        bio: 'A barbearia mais foda da Zona Sul.',
        address: 'Rua das Tesouras, 42',
        phone: '+55 11 99999-0000',
      })
      .expect(200);

    // ---- 3. PATCH /admin/tenant/business-hours
    await request(app.getHttpServer())
      .patch('/admin/tenant/business-hours')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        businessHours: {
          days: [
            { open: false, intervals: [] },
            { open: true, intervals: [{ startMin: 540, endMin: 1080 }] },
            { open: true, intervals: [{ startMin: 540, endMin: 1080 }] },
            { open: true, intervals: [{ startMin: 540, endMin: 1080 }] },
            { open: true, intervals: [{ startMin: 540, endMin: 1080 }] },
            { open: true, intervals: [{ startMin: 540, endMin: 1140 }] },
            { open: true, intervals: [{ startMin: 600, endMin: 1020 }] },
          ],
        },
      })
      .expect(200);

    // ---- 4. POST /admin/barbers (3 barbeiros)
    const barberIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await request(app.getHttpServer())
        .post('/admin/barbers')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ displayName: `Barbeiro ${i + 1}`, bio: `Bio ${i + 1}` })
        .expect(201);
      const body = res.body as BarberResponse;
      expect(body.id).toBeDefined();
      barberIds.push(body.id);
    }

    // Time-off para o primeiro barbeiro
    await request(app.getHttpServer())
      .post(`/admin/barbers/${barberIds[0]}/time-off`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        startsAt: '2026-06-01T00:00:00Z',
        endsAt: '2026-06-08T00:00:00Z',
        reason: 'férias',
      })
      .expect(201);

    // ---- 5. POST /admin/services (5 serviços)
    const services: ServiceResponse[] = [];
    const catalog = [
      { name: 'Corte tradicional', durationMin: 30, priceCents: 5000 },
      { name: 'Corte + barba', durationMin: 60, priceCents: 9000 },
      { name: 'Barba', durationMin: 25, priceCents: 4000 },
      { name: 'Pigmentação', durationMin: 45, priceCents: 8000 },
      { name: 'Sobrancelha', durationMin: 15, priceCents: 2500 },
    ];
    for (const s of catalog) {
      const res = await request(app.getHttpServer())
        .post('/admin/services')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(s)
        .expect(201);
      services.push(res.body as ServiceResponse);
    }

    // Vincula barbeiros nos serviços
    for (const svc of services) {
      await request(app.getHttpServer())
        .put(`/admin/services/${svc.id}/barbers`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ barberIds })
        .expect(200);
    }

    // ---- 6. Upload de 10 fotos
    for (let i = 0; i < 10; i++) {
      const presign = await request(app.getHttpServer())
        .post('/admin/photos/upload-url')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ contentType: 'image/jpeg' })
        .expect(200);
      const presignBody = presign.body as PhotoUploadUrlResponse;
      expect(presignBody.r2Key).toMatch(/tenants\/.*\/photos\//);

      const confirmed = await request(app.getHttpServer())
        .post('/admin/photos')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ r2Key: presignBody.r2Key, caption: `Foto ${i + 1}` })
        .expect(201);
      expect((confirmed.body as PhotoResponse).id).toBeDefined();
    }

    // ---- 7. GETs finais validam estado
    const list = await request(app.getHttpServer())
      .get('/admin/photos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect((list.body as PhotoResponse[]).length).toBe(10);

    const tenantState = await request(app.getHttpServer())
      .get('/admin/tenant')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const t = tenantState.body as TenantResponse;
    expect(t.bio).toContain('Zona Sul');
    expect(t.address).toContain('Tesouras');
    expect(t.businessHours).toBeTruthy();

    const barbersList = await request(app.getHttpServer())
      .get('/admin/barbers')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect((barbersList.body as BarberResponse[]).length).toBe(3);

    const servicesList = await request(app.getHttpServer())
      .get('/admin/services')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect((servicesList.body as ServiceResponse[]).length).toBe(5);
  }, 120_000);

  it('barbeiro convidado consegue fazer login e editar próprio perfil', async () => {
    // Registra outro tenant pra testar o fluxo de convite isoladamente
    const reg = await request(app.getHttpServer())
      .post('/auth/register/owner')
      .send({
        email: 'dono2@barbearia.test',
        password: 'StrongPass!1',
        name: 'Dono 2',
        tenantName: 'Outra Barbearia',
        slug: 'outra-barbearia',
      })
      .expect(201);
    const ownerAuth = reg.body as AuthResponse;

    // Cria barber com email → dispara convite. ConsoleEmailProvider só loga; capturamos o token via banco.
    const create = await request(app.getHttpServer())
      .post('/admin/barbers')
      .set('Authorization', `Bearer ${ownerAuth.accessToken}`)
      .send({ displayName: 'Joaquim', email: 'joaquim@barbeiros.test' })
      .expect(201);
    const barber = create.body as BarberResponse;

    // Pra capturar o token plain dentro do teste, reemitimos via service.
    // Primeiro deletamos o convite original (criado pelo POST /admin/barbers) para poder re-emitir.
    const prisma = app.get(PrismaService);
    const invitationsSvc = app.get(BarberInvitationsService);

    // Remove the invitation created by POST /admin/barbers so we can re-issue and capture the plain token
    await prisma.barberInvitation.deleteMany({ where: { barberId: barber.id } });

    let tokenPlain = '';
    await prisma.withTenant(ownerAuth.tenant!.id, async () => {
      const issued = await invitationsSvc.issue({
        barberId: barber.id,
        email: 'joaquim@barbeiros.test',
        displayName: 'Joaquim',
      });
      tokenPlain = issued.tokenPlain;
    });
    expect(tokenPlain.length).toBeGreaterThan(20);

    // Aceita o convite
    const accept = await request(app.getHttpServer())
      .post('/auth/barbers/accept-invite')
      .send({ token: tokenPlain, password: 'StrongPass!1', name: 'Joaquim' })
      .expect(200);
    const acceptBody = accept.body as AuthResponse;
    expect(acceptBody.user.role).toBe('barber_member');
    expect(acceptBody.tenantId).toBe(ownerAuth.tenant!.id);

    // Joaquim edita o próprio perfil
    await request(app.getHttpServer())
      .patch(`/admin/barbers/${barber.id}`)
      .set('Authorization', `Bearer ${acceptBody.accessToken}`)
      .send({ bio: 'Especialista em barba' })
      .expect(200);

    // Joaquim tenta criar outro barbeiro — deve falhar (role barber_member não tem permissão)
    const denied = await request(app.getHttpServer())
      .post('/admin/barbers')
      .set('Authorization', `Bearer ${acceptBody.accessToken}`)
      .send({ displayName: 'X' });
    expect(denied.status).toBe(403);
  }, 120_000);
});
