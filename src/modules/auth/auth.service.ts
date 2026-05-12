import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OneTimeTokenPurpose, SubscriptionStatus, UserRole } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { EMAIL_PROVIDER } from 'src/modules/notifications/email.provider';
import type { EmailProvider } from 'src/modules/notifications/email.provider';
import { PasswordService } from './password.service';
import { TokensService } from './tokens.service';
import { OneTimeTokenService } from './one-time-token.service';
import { UserRepository } from './repositories/user.repository';
import { RefreshTokenRepository } from './repositories/refresh-token.repository';
import { RegisterOwnerDto } from './dto/register-owner.dto';
import { RESERVED_SLUGS } from './reserved-slugs';
import { BarberInvitationsService } from 'src/modules/barbers/barber-invitations.service';
import { CustomersService } from 'src/modules/customers/customers.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly password: PasswordService,
    private readonly tokens: TokensService,
    private readonly otts: OneTimeTokenService,
    private readonly users: UserRepository,
    private readonly refreshes: RefreshTokenRepository,
    private readonly config: ConfigService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    private readonly barberInvitations: BarberInvitationsService,
    private readonly customers: CustomersService,
  ) {}

  private async resolveTenantIdFor(userId: string, role: UserRole): Promise<string | undefined> {
    if (role === UserRole.tenant_owner) {
      const tenant = await this.prisma.tenant.findUnique({ where: { ownerUserId: userId } });
      return tenant?.id;
    }
    if (role === UserRole.barber_member) {
      const barber = await this.prisma.barber.findUnique({
        where: { userId },
        select: { tenantId: true },
      });
      return barber?.tenantId;
    }
    return undefined;
  }

  async registerOwner(dto: RegisterOwnerDto) {
    if (RESERVED_SLUGS.has(dto.slug)) {
      throw new DomainException({
        code: ErrorCodes.SLUG_RESERVED,
        message: 'Slug reservado.',
        status: HttpStatus.CONFLICT,
      });
    }
    const existingEmail = await this.users.findByEmail(dto.email);
    if (existingEmail) {
      throw new DomainException({
        code: ErrorCodes.EMAIL_ALREADY_REGISTERED,
        message: 'Email já cadastrado.',
        status: HttpStatus.CONFLICT,
      });
    }
    const existingSlug = await this.prisma.tenant.findUnique({ where: { slug: dto.slug } });
    if (existingSlug) {
      throw new DomainException({
        code: ErrorCodes.SLUG_TAKEN,
        message: 'Slug já em uso.',
        status: HttpStatus.CONFLICT,
      });
    }

    const passwordHash = await this.password.hash(dto.password);

    const { user, tenant } = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email: dto.email, passwordHash, name: dto.name, role: UserRole.tenant_owner },
      });
      const tenant = await tx.tenant.create({
        data: { slug: dto.slug, name: dto.tenantName, ownerUserId: user.id },
      });
      await tx.subscription.create({
        data: {
          tenantId: tenant.id,
          status: SubscriptionStatus.trialing,
          trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        },
      });
      return { user, tenant };
    });

    const pair = await this.tokens.issuePair({
      userId: user.id,
      role: user.role,
      tenantId: tenant.id,
    });

    const { plain } = await this.otts.issue(
      user.id,
      OneTimeTokenPurpose.email_verification,
      24 * 3600,
    );
    await this.email.send({
      to: user.email,
      subject: 'Confirme seu email no KairoBarber',
      text: `Olá ${user.name}! Confirme seu email com o token abaixo (válido por 24h):\n\n${plain}\n\nOu acesse: ${this.config.get<string>('APP_URL')}/verify-email?token=${plain}`,
    });

    return { user, tenant, ...pair };
  }

  async login(email: string, plainPassword: string) {
    const user = await this.users.findByEmail(email);
    if (!user) {
      throw new DomainException({
        code: ErrorCodes.INVALID_CREDENTIALS,
        message: 'Credenciais inválidas.',
        status: HttpStatus.UNAUTHORIZED,
      });
    }
    const ok = await this.password.verify(user.passwordHash, plainPassword);
    if (!ok) {
      throw new DomainException({
        code: ErrorCodes.INVALID_CREDENTIALS,
        message: 'Credenciais inválidas.',
        status: HttpStatus.UNAUTHORIZED,
      });
    }

    const tenantId = await this.resolveTenantIdFor(user.id, user.role);
    const pair = await this.tokens.issuePair({ userId: user.id, role: user.role, tenantId });
    return { user, ...pair };
  }

  async refresh(plainRefresh: string) {
    const tokenHash = this.tokens.hashRefresh(plainRefresh);
    const stored = await this.refreshes.findByHash(tokenHash);

    if (!stored) {
      throw new DomainException({
        code: ErrorCodes.TOKEN_INVALID,
        message: 'Refresh token inválido.',
        status: HttpStatus.UNAUTHORIZED,
      });
    }
    if (stored.expiresAt < new Date()) {
      throw new DomainException({
        code: ErrorCodes.TOKEN_EXPIRED,
        message: 'Refresh token expirado.',
        status: HttpStatus.UNAUTHORIZED,
      });
    }
    if (stored.revokedAt) {
      await this.refreshes.revokeAllForUser(stored.userId);
      throw new DomainException({
        code: ErrorCodes.REFRESH_REUSED,
        message: 'Refresh token reutilizado. Faça login novamente.',
        status: HttpStatus.UNAUTHORIZED,
      });
    }

    const user = await this.users.findById(stored.userId);
    if (!user) {
      throw new DomainException({
        code: ErrorCodes.TOKEN_INVALID,
        message: 'Usuário não encontrado.',
        status: HttpStatus.UNAUTHORIZED,
      });
    }

    const tenantId = await this.resolveTenantIdFor(user.id, user.role);
    const pair = await this.tokens.issuePair({ userId: user.id, role: user.role, tenantId });
    await this.refreshes.rotate(stored.id, pair.refreshTokenId);
    return pair;
  }

  async logout(plainRefresh: string) {
    const tokenHash = this.tokens.hashRefresh(plainRefresh);
    const stored = await this.refreshes.findByHash(tokenHash);
    if (stored && !stored.revokedAt) {
      await this.refreshes.rotate(stored.id, stored.id); // revoke without replacement
    }
  }

  async verifyEmail(token: string) {
    const result = await this.otts.consume(token, OneTimeTokenPurpose.email_verification);
    if (!result) {
      throw new DomainException({
        code: ErrorCodes.TOKEN_INVALID,
        message: 'Token de verificação inválido ou expirado.',
        status: HttpStatus.BAD_REQUEST,
      });
    }
    await this.users.markEmailVerified(result.userId);
  }

  async forgotPassword(email: string) {
    const user = await this.users.findByEmail(email);
    if (!user) return; // anti-enumeration
    const { plain } = await this.otts.issue(user.id, OneTimeTokenPurpose.password_reset, 3600);
    await this.email.send({
      to: user.email,
      subject: 'Redefinição de senha — KairoBarber',
      text: `Use o token abaixo para redefinir sua senha (válido por 1 hora):\n\n${plain}\n\nOu acesse: ${this.config.get<string>('APP_URL')}/reset-password?token=${plain}`,
    });
  }

  async resetPassword(token: string, newPassword: string) {
    const result = await this.otts.consume(token, OneTimeTokenPurpose.password_reset);
    if (!result) {
      throw new DomainException({
        code: ErrorCodes.TOKEN_INVALID,
        message: 'Token de reset inválido ou expirado.',
        status: HttpStatus.BAD_REQUEST,
      });
    }
    const passwordHash = await this.password.hash(newPassword);
    await this.users.updatePassword(result.userId, passwordHash);
    await this.refreshes.revokeAllForUser(result.userId);
  }

  async acceptBarberInvite(input: { token: string; password: string; name: string }) {
    const invitation = await this.barberInvitations.validate(input.token);

    const existingUser = await this.users.findByEmail(invitation.email);
    if (existingUser) {
      throw new DomainException({
        code: ErrorCodes.EMAIL_ALREADY_REGISTERED,
        message: 'Email já cadastrado.',
        status: HttpStatus.CONFLICT,
      });
    }

    const passwordHash = await this.password.hash(input.password);

    const { user } = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: invitation.email,
          name: input.name,
          passwordHash,
          role: UserRole.barber_member,
          emailVerifiedAt: new Date(),
        },
      });
      await tx.barber.update({
        where: { id: invitation.barberId },
        data: { userId: user.id },
      });
      const accepted = await tx.barberInvitation.updateMany({
        where: { id: invitation.id, acceptedAt: null },
        data: { acceptedAt: new Date() },
      });
      if (accepted.count === 0) {
        throw new DomainException({
          code: ErrorCodes.INVITATION_ALREADY_ACCEPTED,
          message: 'Convite já foi aceito.',
          status: HttpStatus.CONFLICT,
        });
      }
      return { user };
    });

    const pair = await this.tokens.issuePair({
      userId: user.id,
      role: user.role,
      tenantId: invitation.tenantId,
    });
    return { user, tenantId: invitation.tenantId, ...pair };
  }

  async claimCustomer(input: { token: string; password: string }) {
    const customer = await this.customers.consumeClaimToken(input.token);
    if (!customer.email) {
      throw new DomainException({
        code: ErrorCodes.CLAIM_TOKEN_INVALID,
        message: 'Customer sem email registrado.',
        status: HttpStatus.BAD_REQUEST,
      });
    }
    const existingUser = await this.users.findByEmail(customer.email);
    if (existingUser) {
      throw new DomainException({
        code: ErrorCodes.EMAIL_ALREADY_REGISTERED,
        message: 'Email já cadastrado. Faça login.',
        status: HttpStatus.CONFLICT,
      });
    }
    const passwordHash = await this.password.hash(input.password);
    const user = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          email: customer.email!,
          passwordHash,
          name: customer.name,
          role: UserRole.customer,
          emailVerifiedAt: new Date(),
        },
      });
      await tx.customer.update({
        where: { id: customer.id },
        data: {
          userId: u.id,
          claimTokenHash: null,
          claimTokenExpiresAt: null,
        },
      });
      return u;
    });
    const pair = await this.tokens.issuePair({
      userId: user.id,
      role: user.role,
      tenantId: undefined,
    });
    return { user, ...pair };
  }
}
