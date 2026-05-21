import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from 'src/common/decorators/public.decorator';
import { AuthService } from './auth.service';
import { RegisterOwnerDto } from './dto/register-owner.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { LogoutDto } from './dto/logout.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { AcceptBarberInviteDto } from './dto/accept-barber-invite.dto';
import { ClaimCustomerDto } from './dto/claim-customer.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('register/owner')
  @HttpCode(HttpStatus.CREATED)
  async registerOwner(@Body() dto: RegisterOwnerDto) {
    const r = await this.auth.registerOwner(dto);
    return {
      user: { id: r.user.id, email: r.user.email, name: r.user.name, role: r.user.role },
      tenant: { id: r.tenant.id, slug: r.tenant.slug, name: r.tenant.name },
      accessToken: r.accessToken,
      refreshToken: r.refreshToken,
    };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto) {
    const r = await this.auth.login(dto.email, dto.password);
    return {
      user: { id: r.user.id, email: r.user.email, name: r.user.name, role: r.user.role },
      accessToken: r.accessToken,
      refreshToken: r.refreshToken,
    };
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() dto: RefreshDto) {
    const r = await this.auth.refresh(dto.refreshToken);
    return { accessToken: r.accessToken, refreshToken: r.refreshToken };
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Body() dto: LogoutDto) {
    await this.auth.logout(dto.refreshToken);
  }

  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.NO_CONTENT)
  async verifyEmail(@Body() dto: VerifyEmailDto) {
    await this.auth.verifyEmail(dto.token);
  }

  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('forgot-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.auth.forgotPassword(dto.email);
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.auth.resetPassword(dto.token, dto.newPassword);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('barbers/accept-invite')
  @HttpCode(HttpStatus.OK)
  async acceptBarberInvite(@Body() dto: AcceptBarberInviteDto) {
    const r = await this.auth.acceptBarberInvite(dto);
    return {
      user: { id: r.user.id, email: r.user.email, name: r.user.name, role: r.user.role },
      tenantId: r.tenantId,
      accessToken: r.accessToken,
      refreshToken: r.refreshToken,
    };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('customers/claim')
  @HttpCode(HttpStatus.OK)
  async claimCustomer(@Body() dto: ClaimCustomerDto) {
    const r = await this.auth.claimCustomer(dto);
    return {
      user: { id: r.user.id, email: r.user.email, name: r.user.name, role: r.user.role },
      accessToken: r.accessToken,
      refreshToken: r.refreshToken,
    };
  }
}
