import type { IncomingMessage } from 'http';
import type { Params } from 'nestjs-pino';

interface PinoReq extends IncomingMessage {
  id: string;
}

export function buildLoggerOptions(env: NodeJS.ProcessEnv): Params {
  const isDev = env.NODE_ENV === 'development';
  return {
    pinoHttp: {
      level: env.LOG_LEVEL ?? 'info',
      transport: isDev
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
        : undefined,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.newPassword',
          'req.body.currentPassword',
          'req.body.token',
          'res.headers["set-cookie"]',
        ],
        censor: '[REDACTED]',
      },
      customProps: () => ({ service: 'kairobarber-api' }),
      serializers: {
        req(req: PinoReq) {
          return { id: req.id, method: req.method, url: req.url };
        },
      },
    },
  };
}
