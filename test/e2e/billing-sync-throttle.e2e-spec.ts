import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import { StartedRedis, flushTestRedis, startTestRedis } from '../support/billing';

describe('Billing — POST /admin/billing/sync throttle (e2e)', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let redis: StartedRedis;

  beforeAll(async () => {
    setTestEnv();
    container = await startTestPostgres();
    redis = await startTestRedis();
    app = await buildTestApp();
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await flushTestRedis(redis.url);
    await redis.container.stop();
    await container.stop();
  });

  // Hash determinístico do slug pra X-Forwarded-For — cada tenant fica isolado no
  // throttler global. Pra forçar 429 no 6º call do MESMO IP, reusamos o mesmo IP
  // (mesmo slug) — diferente de outros specs que distribuem por tenant.
  function slugToFakeIp(slug: string): string {
    let h = 0;
    for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
    return `10.${(h >>> 16) & 0xff}.${(h >>> 8) & 0xff}.${h & 0xff}`;
  }

  async function registerAndLogin(slug: string): Promise<{
    accessToken: string;
    fakeIp: string;
  }> {
    const server = app.getHttpServer() as unknown as import('http').Server;
    const fakeIp = slugToFakeIp(slug);
    const reg = await request(server)
      .post('/auth/register/owner')
      .set('X-Forwarded-For', fakeIp)
      .send({
        email: `${slug}@sync.test`,
        password: 'StrongPass!1',
        name: `Owner ${slug}`,
        tenantName: `Barber ${slug}`,
        slug,
      })
      .expect(201);
    const body = reg.body as { accessToken: string };
    return { accessToken: body.accessToken, fakeIp };
  }

  it('aceita 5 calls consecutivas em POST /admin/billing/sync e bloqueia a 6ª com 429', async () => {
    const { accessToken, fakeIp } = await registerAndLogin('sync-throttle-1');
    const server = app.getHttpServer() as unknown as import('http').Server;

    // 5 calls válidas no mesmo IP — limite local é 5/60s (R-F3-01)
    for (let i = 0; i < 5; i++) {
      await request(server)
        .post('/admin/billing/sync')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('X-Forwarded-For', fakeIp)
        .expect(200);
    }

    // 6ª call no mesmo IP em < 60s deve retornar 429 Too Many Requests
    await request(server)
      .post('/admin/billing/sync')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-Forwarded-For', fakeIp)
      .expect(429);
  });
});
