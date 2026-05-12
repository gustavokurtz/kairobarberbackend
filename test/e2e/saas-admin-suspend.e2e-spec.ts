import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import { createSaasOwner, createTenantOwner } from '../support/saas';

describe('SaaS admin — suspend/unsuspend (e2e)', () => {
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

  it('suspende um tenant → storefront 404 e admin 402 TENANT_SUSPENDED; unsuspend libera', async () => {
    const saas = await createSaasOwner(app, { email: 'saas-suspend@test.io' });
    const owner = await createTenantOwner(app, 'suspend1', 'sus@bar.test');
    const server = app.getHttpServer();

    // Antes: storefront responde 200
    await request(server).get('/public/suspend1').expect(200);

    // Suspend
    const sus = await request(server)
      .post(`/saas/tenants/${owner.tenantId}/suspend`)
      .set('Authorization', `Bearer ${saas.accessToken}`)
      .expect(200);
    expect((sus.body as { suspendedAt: string | null }).suspendedAt).toBeTruthy();

    // Storefront 404
    await request(server).get('/public/suspend1').expect(404);

    // Admin 402 TENANT_SUSPENDED
    await request(server)
      .get('/admin/barbers')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(402)
      .expect(({ body }) => {
        expect((body as { code: string }).code).toBe('TENANT_SUSPENDED');
      });

    // Suspender de novo → 409 TENANT_ALREADY_SUSPENDED
    await request(server)
      .post(`/saas/tenants/${owner.tenantId}/suspend`)
      .set('Authorization', `Bearer ${saas.accessToken}`)
      .expect(409)
      .expect(({ body }) => {
        expect((body as { code: string }).code).toBe('TENANT_ALREADY_SUSPENDED');
      });

    // Unsuspend
    const uns = await request(server)
      .post(`/saas/tenants/${owner.tenantId}/unsuspend`)
      .set('Authorization', `Bearer ${saas.accessToken}`)
      .expect(200);
    expect((uns.body as { suspendedAt: string | null }).suspendedAt).toBeNull();

    // Admin volta ao normal
    await request(server)
      .get('/admin/barbers')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    // Storefront volta
    await request(server).get('/public/suspend1').expect(200);

    // Unsuspend de novo → 409 TENANT_NOT_SUSPENDED
    await request(server)
      .post(`/saas/tenants/${owner.tenantId}/unsuspend`)
      .set('Authorization', `Bearer ${saas.accessToken}`)
      .expect(409)
      .expect(({ body }) => {
        expect((body as { code: string }).code).toBe('TENANT_NOT_SUSPENDED');
      });
  });
});
