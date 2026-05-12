import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import { createSaasOwner, createTenantOwner } from '../support/saas';

describe('SaaS admin — users (e2e)', () => {
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

  it('lista todos os users e filtra por role', async () => {
    const saas = await createSaasOwner(app, { email: 'saas-users@test.io' });
    await createTenantOwner(app, 'usr1', 'u1@t.test');
    await createTenantOwner(app, 'usr2', 'u2@t.test');

    const all = await request(app.getHttpServer())
      .get('/saas/users')
      .set('Authorization', `Bearer ${saas.accessToken}`)
      .expect(200);
    expect((all.body as { total: number }).total).toBeGreaterThanOrEqual(3);

    const tenantOwners = await request(app.getHttpServer())
      .get('/saas/users?role=tenant_owner')
      .set('Authorization', `Bearer ${saas.accessToken}`)
      .expect(200);
    const data = (tenantOwners.body as { data: Array<{ role: string }> }).data;
    expect(data.every((u) => u.role === 'tenant_owner')).toBe(true);

    const search = await request(app.getHttpServer())
      .get('/saas/users?search=u1@t.test')
      .set('Authorization', `Bearer ${saas.accessToken}`)
      .expect(200);
    const sData = (search.body as { data: Array<{ email: string }> }).data;
    expect(sData).toHaveLength(1);
    expect(sData[0].email).toBe('u1@t.test');
  });
});
