import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
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
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  // Em prod (nginx + opcionalmente Cloudflare na frente), os proxies setam
  // X-Forwarded-For com o IP real do cliente. Sem `trust proxy`, req.ip vira o IP
  // do último hop e o throttler trata todos os usuários como o mesmo IP.
  // TRUST_PROXY_HOPS controla quantos proxies confiar — nginx direto = 1; nginx
  // atrás de Cloudflare = 2. Em testes/local sem proxy, 0 desliga.
  const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 2);
  app.set('trust proxy', trustProxyHops);

  app.use(helmet());

  // CORS allowlist via env (CSV). Vazio = CORS desabilitado (api só acessível pelo
  // proxy server-side do front, fluxo padrão). Reflete somente origens listadas.
  const corsOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  if (corsOrigins.length > 0) {
    app.enableCors({
      origin: (
        origin: string | undefined,
        callback: (err: Error | null, allow?: boolean) => void,
      ) => {
        // Sem header Origin (curl, server-to-server) → libera.
        if (!origin) return callback(null, true);
        if (corsOrigins.includes(origin)) return callback(null, true);
        return callback(new Error(`CORS: origem não permitida (${origin})`), false);
      },
      credentials: true,
    });
  }

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
