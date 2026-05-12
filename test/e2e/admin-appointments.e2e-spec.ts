import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import { nextOpenSlotISO } from '../support/time';

describe('Admin appointments — agenda do barbeiro (e2e)', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    setTestEnv();
    container = await startTestPostgres();
    app = await buildTestApp();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('barbeiro vê appointment criado via storefront e consegue confirm + complete', async () => {
    const server: Express.Application = app.getHttpServer() as Express.Application;

    const reg = await request(server)
      .post('/auth/register/owner')
      .send({
        email: 'dono@adm.test',
        password: 'StrongPass!1',
        name: 'Dono',
        tenantName: 'Adm',
        slug: 'adm',
      })
      .expect(201);
    const ownerToken = (reg.body as { accessToken: string }).accessToken;

    const open = { open: true, intervals: [{ startMin: 540, endMin: 1080 }] };
    const closed = { open: false, intervals: [] as { startMin: number; endMin: number }[] };
    await request(server)
      .patch('/admin/tenant/business-hours')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ businessHours: { days: [closed, open, open, open, open, open, closed] } })
      .expect(200);

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

    const startsAt = nextOpenSlotISO(2, 14);
    const booking = await request(server)
      .post('/public/adm/appointments')
      .send({
        serviceId,
        barberId,
        startsAt,
        customer: { name: 'Cliente', phone: '+551144441111' },
      })
      .expect(201);
    const id = (booking.body as { id: string }).id;

    const from = new Date();
    from.setUTCDate(from.getUTCDate() + 1);
    from.setUTCHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setUTCDate(to.getUTCDate() + 5);

    const list = await request(server)
      .get('/admin/appointments')
      .set('Authorization', `Bearer ${ownerToken}`)
      .query({ from: from.toISOString(), to: to.toISOString() })
      .expect(200);
    expect((list.body as Array<{ id: string }>).some((a) => a.id === id)).toBe(true);

    await request(server)
      .post(`/admin/appointments/${id}/confirm`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    await request(server)
      .post(`/admin/appointments/${id}/complete`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    // completed → cancel inválido
    await request(server)
      .post(`/admin/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({})
      .expect(409);
  });
});
