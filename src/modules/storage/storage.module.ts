import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { STORAGE_PROVIDER } from './storage.provider';
import { ConsoleStorageProvider } from './providers/console-storage.provider';

@Global()
@Module({
  providers: [
    {
      provide: STORAGE_PROVIDER,
      useFactory: (cfg: ConfigService) => {
        const provider = cfg.get<string>('STORAGE_PROVIDER');
        if (provider === 'console') return new ConsoleStorageProvider();
        // R2 será adicionado na Task 13
        throw new Error(`Unsupported STORAGE_PROVIDER: ${provider}`);
      },
      inject: [ConfigService],
    },
  ],
  exports: [STORAGE_PROVIDER],
})
export class StorageModule {}
