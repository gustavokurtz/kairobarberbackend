import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import { createSaasOwner, createTenantOwner } from '../support/saas';

describe('SaaS admin — autorização (e2e)', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    setTestEnv();
    container = await startTestPostgres();
    app = await buildTestApp();
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('GET /saas/ping sem token → 401', async () => {
    await request(app.getHttpServer()).get('/saas/ping').expect(401);
  });

  it('GET /saas/ping com token de tenant_owner → 403', async () => {
    const owner = await createTenantOwner(app, 'authztenant', 'authz@tenant.test');
    await request(app.getHttpServer())
      .get('/saas/ping')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(403);
  });

  it('GET /saas/ping com token de saas_owner → 200', async () => {
    const saas = await createSaasOwner(app, { email: 'saas-authz@test.io' });
    await request(app.getHttpServer())
      .get('/saas/ping')
      .set('Authorization', `Bearer ${saas.accessToken}`)
      .expect(200)
      .expect(({ body }) => {
        expect((body as { ok: boolean }).ok).toBe(true);
      });
  });
});
