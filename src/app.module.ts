import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './infra/prisma/prisma.module';
import { buildLoggerOptions } from './infra/logger/logger.config';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      useFactory: () => buildLoggerOptions(process.env),
    }),
    PrismaModule,
  ],
})
export class AppModule {}
