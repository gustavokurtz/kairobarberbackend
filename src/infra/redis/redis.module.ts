import { Global, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import { REDIS_CLIENT } from './redis.tokens';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (cfg: ConfigService) => {
        const url = cfg.get<string>('REDIS_URL');
        if (!url) throw new Error('REDIS_URL is required');
        return new IORedis(url, { maxRetriesPerRequest: null, enableReadyCheck: false });
      },
      inject: [ConfigService],
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor() {}

  async onApplicationShutdown() {
    // ioredis fecha sozinho no SIGTERM via app.enableShutdownHooks(),
    // mas mantemos a interface explícita para futura quiesce de filas.
  }
}
