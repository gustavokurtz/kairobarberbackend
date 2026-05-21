import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { Express, Request, Response, NextFunction } from 'express';
import { AppModule } from 'src/app.module';
import { GlobalExceptionFilter } from 'src/common/filters/global-exception.filter';
import { tenantAls } from 'src/infra/prisma/prisma.service';

export async function buildTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();

  // Habilita trust proxy igual main.ts pra que custom ThrottlerBehindProxyGuard
  // honre X-Forwarded-For dos testes (specs usam isso pra simular múltiplos
  // clientes e não bater no @Throttle local de endpoints como /auth/register/owner).
  const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 1);
  (app.getHttpAdapter().getInstance() as Express).set('trust proxy', trustProxyHops);

  // Mirror the ALS middleware from main.ts so JwtAuthGuard can populate tenantId
  // and PrismaService.scoped picks it up automatically in tests.
  app.use((_req: Request, _res: Response, next: NextFunction) => {
    tenantAls.run({}, () => next());
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
  return app;
}
