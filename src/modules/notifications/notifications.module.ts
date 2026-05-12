import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { EMAIL_PROVIDER } from './email.provider';
import { ConsoleEmailProvider } from './providers/console-email.provider';
import { ResendEmailProvider } from './providers/resend-email.provider';

@Global()
@Module({
  providers: [
    {
      provide: EMAIL_PROVIDER,
      useFactory: (cfg: ConfigService) => {
        const provider = cfg.get<string>('EMAIL_PROVIDER');
        if (provider === 'console') return new ConsoleEmailProvider();
        if (provider === 'resend') {
          const apiKey = cfg.get<string>('RESEND_API_KEY');
          const from = cfg.get<string>('EMAIL_FROM');
          if (!apiKey || !from) {
            throw new Error(
              'RESEND_API_KEY and EMAIL_FROM are required when EMAIL_PROVIDER=resend',
            );
          }
          return new ResendEmailProvider(new Resend(apiKey), from);
        }
        throw new Error(`Unsupported EMAIL_PROVIDER: ${provider}`);
      },
      inject: [ConfigService],
    },
  ],
  exports: [EMAIL_PROVIDER],
})
export class NotificationsModule {}
