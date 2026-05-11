import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from 'src/app.module';

interface LiveResponse {
  status: string;
}

interface ReadyResponse {
  status: string;
  info: {
    database: {
      status: string;
    };
  };
}

describe('Health endpoints (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/live -> 200', async () => {
    const res = await request(app.getHttpServer()).get('/health/live');
    expect(res.status).toBe(200);
    const body = res.body as LiveResponse;
    expect(body.status).toBe('ok');
  });

  it('GET /health/ready -> 200 (db reachable)', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready');
    expect(res.status).toBe(200);
    const body = res.body as ReadyResponse;
    expect(body.status).toBe('ok');
    expect(body.info.database.status).toBe('up');
  });
});
