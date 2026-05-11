import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { AppModule } from 'src/app.module';
import { GlobalExceptionFilter } from 'src/common/filters/global-exception.filter';
import { tenantAls } from 'src/infra/prisma/prisma.service';

export async function buildTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();

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
