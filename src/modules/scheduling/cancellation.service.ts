import { HttpStatus, Injectable } from '@nestjs/common';
import { AppointmentStatus } from '@prisma/client';
import { createHash } from 'crypto';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { AppointmentRepository } from './repositories/appointment.repository';

const MIN_CANCEL_LEAD_HOURS = 2;
const ACTIVE = new Set<AppointmentStatus>([AppointmentStatus.pending, AppointmentStatus.confirmed]);

@Injectable()
export class CancellationService {
  constructor(
    private readonly repo: AppointmentRepository,
    private readonly nowFn: () => Date = () => new Date(),
  ) {}

  async lookupByToken(plainToken: string) {
    const tokenHash = createHash('sha256').update(plainToken).digest('hex');
    const apt = await this.repo.findByCancellationTokenHash(tokenHash);
    if (!apt) {
      throw new DomainException({
        code: ErrorCodes.CANCELLATION_TOKEN_INVALID,
        message: 'Token inválido.',
        status: HttpStatus.BAD_REQUEST,
      });
    }
    return apt;
  }

  async cancelByToken(plainToken: string, reason?: string) {
    const apt = await this.lookupByToken(plainToken);
    if (!ACTIVE.has(apt.status)) {
      throw new DomainException({
        code: ErrorCodes.APPOINTMENT_TRANSITION_INVALID,
        message: 'Agendamento não pode mais ser cancelado.',
        status: HttpStatus.CONFLICT,
      });
    }
    const now = this.nowFn();
    const hoursUntil = (apt.startsAt.getTime() - now.getTime()) / 3600000;
    if (hoursUntil < MIN_CANCEL_LEAD_HOURS) {
      throw new DomainException({
        code: ErrorCodes.CANCELLATION_TOO_LATE,
        message: `Cancelamento só é permitido com mais de ${MIN_CANCEL_LEAD_HOURS}h de antecedência.`,
        status: HttpStatus.UNPROCESSABLE_ENTITY,
      });
    }
    return this.repo.updateStatus(apt.id, AppointmentStatus.cancelled, {
      cancelledAt: now,
      cancellationReason: reason ?? 'Cancelado pelo cliente',
    });
  }
}
