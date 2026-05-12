import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { EMAIL_PROVIDER } from 'src/modules/notifications/email.provider';
import type { EmailProvider } from 'src/modules/notifications/email.provider';
import { BarberInvitationRepository } from './repositories/barber-invitation.repository';

const INVITATION_TTL_SECONDS = 7 * 24 * 3600;

@Injectable()
export class BarberInvitationsService {
  constructor(
    private readonly repo: BarberInvitationRepository,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    private readonly config: ConfigService,
  ) {}

  async issue(input: { barberId: string; email: string; displayName: string }) {
    const tokenPlain = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(tokenPlain).digest('hex');
    const expiresAt = new Date(Date.now() + INVITATION_TTL_SECONDS * 1000);
    const invitation = await this.repo.create({
      barberId: input.barberId,
      email: input.email,
      tokenHash,
      expiresAt,
    });
    const appUrl = this.config.get<string>('APP_URL');
    await this.email.send({
      to: input.email,
      subject: 'Convite para entrar no KairoBarber',
      text:
        `Olá ${input.displayName}!\n\nVocê foi convidado(a) para entrar no KairoBarber como barbeiro(a). ` +
        `Aceite o convite com o token abaixo (válido por 7 dias):\n\n${tokenPlain}\n\n` +
        `Ou acesse: ${appUrl}/accept-invite?token=${tokenPlain}\n`,
    });
    return { invitation, tokenPlain };
  }

  async validate(tokenPlain: string) {
    const tokenHash = createHash('sha256').update(tokenPlain).digest('hex');
    const found = await this.repo.findByTokenHash(tokenHash);
    if (!found) {
      throw new DomainException({
        code: ErrorCodes.INVITATION_INVALID,
        message: 'Convite inválido.',
        status: HttpStatus.BAD_REQUEST,
      });
    }
    if (found.acceptedAt) {
      throw new DomainException({
        code: ErrorCodes.INVITATION_ALREADY_ACCEPTED,
        message: 'Convite já foi aceito.',
        status: HttpStatus.CONFLICT,
      });
    }
    if (found.expiresAt < new Date()) {
      throw new DomainException({
        code: ErrorCodes.INVITATION_EXPIRED,
        message: 'Convite expirado.',
        status: HttpStatus.BAD_REQUEST,
      });
    }
    return found;
  }
}
