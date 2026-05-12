import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import { nextOpenSlotISO } from '../support/time';

interface CreateAppointmentResp {
  id: string;
  status: string;
  startsAt: string;
  cancellationToken: string;
  claimToken?: string;
  emailDelivered: boolean;
}

describe('Storefront pública — booking + cancel ponta a ponta (e2e)', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    setTestEnv();
    process.env.STORAGE_PROVIDER = 'console';
    process.env.THROTTLE_LIMIT = '1000';
    container = await startTestPostgres();
    app = await buildTestApp();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('owner configura barbearia → cliente lista, vê disponibilidade, agenda, recebe token, cancela', async () => {
    const server: Express.Application = app.getHttpServer() as Express.Application;

    // 1) Owner cadastrado + tenant
    const reg = await request(server)
      .post('/auth/register/owner')
      .send({
        email: 'dono@bb.test',
        password: 'StrongPass!1',
        name: 'Dono',
        tenantName: 'BB Studio',
        slug: 'bb-studio',
      })
      .expect(201);
    const ownerToken = (reg.body as { accessToken: string }).accessToken;

    // 2) Business hours: seg-sex 09:00-18:00 SP
    const openDay = { open: true, intervals: [{ startMin: 540, endMin: 1080 }] };
    const closedDay = { open: false, intervals: [] as { startMin: number; endMin: number }[] };
    await request(server)
      .patch('/admin/tenant/business-hours')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        businessHours: {
          days: [closedDay, openDay, openDay, openDay, openDay, openDay, closedDay],
        },
      })
      .expect(200);

    // 3) 1 barbeiro, 1 serviço, vínculo
    const barber = await request(server)
      .post('/admin/barbers')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ displayName: 'Pedro' })
      .expect(201);
    const barberId = (barber.body as { id: string }).id;

    const service = await request(server)
      .post('/admin/services')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Corte', durationMin: 30, priceCents: 4500 })
      .expect(201);
    const serviceId = (service.body as { id: string }).id;

    await request(server)
      .put(`/admin/services/${serviceId}/barbers`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ barberIds: [barberId] })
      .expect(200);

    // 4) Cliente lista catálogo público
    await request(server).get('/public/bb-studio').expect(200);
    const servicesList = await request(server).get('/public/bb-studio/services').expect(200);
    expect((servicesList.body as Array<{ id: string }>)[0].id).toBe(serviceId);

    // 5) Cliente consulta disponibilidade
    const from = new Date();
    from.setUTCDate(from.getUTCDate() + 1);
    from.setUTCHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setUTCDate(to.getUTCDate() + 7);
    const avail = await request(server)
      .get(`/public/bb-studio/availability/by-service/${serviceId}`)
      .query({ from: from.toISOString(), to: to.toISOString() })
      .expect(200);
    expect((avail.body as Array<{ slots: unknown[] }>)[0].slots.length).toBeGreaterThan(0);

    // 6) Cliente agenda
    const startsAt = nextOpenSlotISO();
    const booking = await request(server)
      .post('/public/bb-studio/appointments')
      .send({
        serviceId,
        barberId,
        startsAt,
        customer: { name: 'João', phone: '+5511999999999', email: 'joao@x.com' },
      })
      .expect(201);
    const b = booking.body as CreateAppointmentResp;
    expect(b.status).toBe('pending');
    expect(b.cancellationToken).toBeTruthy();
    expect(b.claimToken).toBeTruthy();

    // 7) Lookup com token
    await request(server)
      .get(`/public/appointments/${b.id}`)
      .query({ token: b.cancellationToken })
      .expect(200);

    // 8) Cancel via token
    const cancel = await request(server)
      .post(`/public/appointments/${b.id}/cancel`)
      .query({ token: b.cancellationToken })
      .send({})
      .expect(200);
    expect((cancel.body as { status: string }).status).toBe('cancelled');

    // 9) Re-cancel falha 409
    await request(server)
      .post(`/public/appointments/${b.id}/cancel`)
      .query({ token: b.cancellationToken })
      .send({})
      .expect(409);
  });

  it('SLOT_TAKEN: segundo cliente no mesmo slot recebe 409', async () => {
    const server: Express.Application = app.getHttpServer() as Express.Application;
    const startsAt = nextOpenSlotISO(3, 15);

    const services = await request(server).get('/public/bb-studio/services').expect(200);
    const serviceId = (services.body as Array<{ id: string }>)[0].id;
    const barberIds = (services.body as Array<{ barberIds: string[] }>)[0].barberIds;

    const [r1, r2] = await Promise.all([
      request(server)
        .post('/public/bb-studio/appointments')
        .send({
          serviceId,
          barberId: barberIds[0],
          startsAt,
          customer: { name: 'Ana', phone: '+551130001' },
        }),
      request(server)
        .post('/public/bb-studio/appointments')
        .send({
          serviceId,
          barberId: barberIds[0],
          startsAt,
          customer: { name: 'Bruno', phone: '+551130002' },
        }),
    ]);
    const codes = [r1.status, r2.status].sort();
    expect(codes).toEqual([201, 409]);
  });
});
