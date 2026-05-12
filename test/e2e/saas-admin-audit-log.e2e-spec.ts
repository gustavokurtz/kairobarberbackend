import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import { createSaasOwner, createTenantOwner } from '../support/saas';

describe('SaaS admin — audit-log (e2e)', () => {
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

  it('audit-log inclui trial_started após onboarding e tenant.suspended após suspend', async () => {
    const saas = await createSaasOwner(app, { email: 'saas-audit@test.io' });
    const t = await createTenantOwner(app, 'auditone', 'a@audit.test');

    await request(app.getHttpServer())
      .post(`/saas/tenants/${t.tenantId}/suspend`)
      .set('Authorization', `Bearer ${saas.accessToken}`)
      .expect(200);

    const all = await request(app.getHttpServer())
      .get(`/saas/audit-log?tenantId=${t.tenantId}`)
      .set('Authorization', `Bearer ${saas.accessToken}`)
      .expect(200);
    const actions = (all.body as { rows: Array<{ action: string }> }).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['subscription.trial_started', 'tenant.suspended']));

    const filtered = await request(app.getHttpServer())
      .get(`/saas/audit-log?tenantId=${t.tenantId}&action=tenant.suspended`)
      .set('Authorization', `Bearer ${saas.accessToken}`)
      .expect(200);
    expect((filtered.body as { rows: unknown[] }).rows).toHaveLength(1);
  });
});
