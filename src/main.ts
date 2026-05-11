import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import type { Request, Response, NextFunction } from 'express';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { initSentry } from './infra/sentry/sentry.init';
import { tenantAls } from './infra/prisma/prisma.service';

initSentry(process.env.SENTRY_DSN, process.env.NODE_ENV);

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  app.use(helmet());
  app.enableCors({ origin: true, credentials: true });

  // Wrap every request in an AsyncLocalStorage context so JwtAuthGuard can
  // populate tenantId and PrismaService.scoped picks it up automatically.
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

  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
}
void bootstrap();
