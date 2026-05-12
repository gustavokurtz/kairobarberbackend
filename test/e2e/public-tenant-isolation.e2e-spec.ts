import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Application } from 'express';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';

describe('Storefront pública — isolation entre tenants (e2e)', () => {
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

  it('GET /public/tenantA/services não retorna serviços de tenantB', async () => {
    const server = app.getHttpServer() as Application;

    const regA = await request(server)
      .post('/auth/register/owner')
      .send({
        email: 'a@x.com',
        password: 'StrongPass!1',
        name: 'Owner A',
        tenantName: 'Tenant A',
        slug: 'isol-a',
      })
      .expect(201);
    const regB = await request(server)
      .post('/auth/register/owner')
      .send({
        email: 'b@x.com',
        password: 'StrongPass!1',
        name: 'Owner B',
        tenantName: 'Tenant B',
        slug: 'isol-b',
      })
      .expect(201);
    const tokenA = (regA.body as { accessToken: string }).accessToken;
    const tokenB = (regB.body as { accessToken: string }).accessToken;

    const serviceA = await request(server)
      .post('/admin/services')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'A-Corte', durationMin: 30, priceCents: 1000 })
      .expect(201);
    const serviceB = await request(server)
      .post('/admin/services')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'B-Corte', durationMin: 30, priceCents: 2000 })
      .expect(201);

    const listA = await request(server).get('/public/isol-a/services').expect(200);
    const listB = await request(server).get('/public/isol-b/services').expect(200);

    const idsA = (listA.body as Array<{ id: string }>).map((s) => s.id);
    const idsB = (listB.body as Array<{ id: string }>).map((s) => s.id);
    expect(idsA).toContain((serviceA.body as { id: string }).id);
    expect(idsA).not.toContain((serviceB.body as { id: string }).id);
    expect(idsB).toContain((serviceB.body as { id: string }).id);
    expect(idsB).not.toContain((serviceA.body as { id: string }).id);
  });

  it('slug inexistente devolve 404', async () => {
    await request(app.getHttpServer() as Application)
      .get('/public/nope-tenant')
      .expect(404);
  });
});
