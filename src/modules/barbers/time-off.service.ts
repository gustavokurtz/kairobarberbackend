import { HttpStatus, Injectable } from '@nestjs/common';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { TimeOffRepository } from './repositories/time-off.repository';
import { BarbersService } from './barbers.service';
import { CreateTimeOffDto } from './dto/create-time-off.dto';

@Injectable()
export class TimeOffService {
  constructor(
    private readonly repo: TimeOffRepository,
    private readonly barbers: BarbersService,
  ) {}

  async list(barberId: string) {
    await this.barbers.getById(barberId);
    return this.repo.listForBarber(barberId);
  }

  async create(barberId: string, dto: CreateTimeOffDto) {
    await this.barbers.getById(barberId);
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (!(endsAt > startsAt)) {
      throw new DomainException({
        code: ErrorCodes.TIME_OFF_INVALID_RANGE,
        message: 'endsAt deve ser maior que startsAt.',
        status: HttpStatus.BAD_REQUEST,
      });
    }
    return this.repo.create({ barberId, startsAt, endsAt, reason: dto.reason });
  }

  async delete(barberId: string, timeOffId: string) {
    await this.barbers.getById(barberId);
    const existing = await this.repo.findById(timeOffId);
    if (!existing || existing.barberId !== barberId) {
      throw new DomainException({
        code: ErrorCodes.TIME_OFF_NOT_FOUND,
        message: 'Folga não encontrada.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    await this.repo.delete(timeOffId);
  }
}
