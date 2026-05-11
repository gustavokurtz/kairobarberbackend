import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EMAIL_PROVIDER } from './email.provider';
import { ConsoleEmailProvider } from './providers/console-email.provider';

@Global()
@Module({
  providers: [
    {
      provide: EMAIL_PROVIDER,
      useFactory: (cfg: ConfigService) => {
        const provider = cfg.get<string>('EMAIL_PROVIDER');
        if (provider === 'console') return new ConsoleEmailProvider();
        // Fase 3 adicionará ResendEmailProvider aqui
        throw new Error(`Unsupported EMAIL_PROVIDER: ${provider}`);
      },
      inject: [ConfigService],
    },
  ],
  exports: [EMAIL_PROVIDER],
})
export class NotificationsModule {}
