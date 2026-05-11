import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { TokensService } from './tokens.service';
import { OneTimeTokenService } from './one-time-token.service';
import { UserRepository } from './repositories/user.repository';
import { RefreshTokenRepository } from './repositories/refresh-token.repository';
import { OneTimeTokenRepository } from './repositories/one-time-token.repository';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';

@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    TokensService,
    OneTimeTokenService,
    UserRepository,
    RefreshTokenRepository,
    OneTimeTokenRepository,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [TokensService],
})
export class AuthModule {}
