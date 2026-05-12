import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import { createSaasOwner, createTenantOwner } from '../support/saas';

describe('SaaS admin — tenants (e2e)', () => {
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

  it('lista, filtra por search, e detalha um tenant existente', async () => {
    const saas = await createSaasOwner(app, { email: 'saas-tenants@test.io' });
    const t1 = await createTenantOwner(app, 'barberone', 'one@bar.test');
    await createTenantOwner(app, 'twobarber', 'two@bar.test');

    const listAll = await request(app.getHttpServer())
      .get('/saas/tenants')
      .set('Authorization', `Bearer ${saas.accessToken}`)
      .expect(200);
    expect((listAll.body as { total: number }).total).toBeGreaterThanOrEqual(2);

    const filtered = await request(app.getHttpServer())
      .get('/saas/tenants?search=barberone')
      .set('Authorization', `Bearer ${saas.accessToken}`)
      .expect(200);
    expect((filtered.body as { data: Array<{ slug: string }> }).data).toHaveLength(1);
    expect((filtered.body as { data: Array<{ slug: string }> }).data[0].slug).toBe('barberone');

    const detail = await request(app.getHttpServer())
      .get(`/saas/tenants/${t1.tenantId}`)
      .set('Authorization', `Bearer ${saas.accessToken}`)
      .expect(200);
    expect((detail.body as { id: string }).id).toBe(t1.tenantId);
    expect((detail.body as { ownerEmail: string }).ownerEmail).toBe('one@bar.test');
    expect((detail.body as { counters: { barbersCount: number } }).counters.barbersCount).toBe(0);
  });

  it('GET /saas/tenants/:id inexistente → 404 SAAS_TENANT_NOT_FOUND', async () => {
    const saas = await createSaasOwner(app, { email: 'saas-tenant-404@test.io' });
    await request(app.getHttpServer())
      .get('/saas/tenants/c0000000000000000000000000')
      .set('Authorization', `Bearer ${saas.accessToken}`)
      .expect(404)
      .expect(({ body }) => {
        expect((body as { code: string }).code).toBe('SAAS_TENANT_NOT_FOUND');
      });
  });
});
