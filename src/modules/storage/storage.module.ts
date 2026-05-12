import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { STORAGE_PROVIDER } from './storage.provider';
import { ConsoleStorageProvider } from './providers/console-storage.provider';
import { R2StorageProvider } from './providers/r2-storage.provider';

@Global()
@Module({
  providers: [
    {
      provide: STORAGE_PROVIDER,
      useFactory: (cfg: ConfigService) => {
        const provider = cfg.get<string>('STORAGE_PROVIDER');
        if (provider === 'console') return new ConsoleStorageProvider();
        if (provider === 'r2') return new R2StorageProvider(cfg);
        throw new Error(`Unsupported STORAGE_PROVIDER: ${provider}`);
      },
      inject: [ConfigService],
    },
  ],
  exports: [STORAGE_PROVIDER],
})
export class StorageModule {}
