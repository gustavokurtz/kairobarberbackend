import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { BarberRepository } from './repositories/barber.repository';
import { CreateBarberDto } from './dto/create-barber.dto';
import { UpdateBarberDto } from './dto/update-barber.dto';
import { BarberInvitationsService } from './barber-invitations.service';

@Injectable()
export class BarbersService {
  constructor(
    private readonly repo: BarberRepository,
    private readonly invitations: BarberInvitationsService,
  ) {}

  list() {
    return this.repo.list();
  }

  async getById(id: string) {
    const b = await this.repo.findById(id);
    if (!b) {
      throw new DomainException({
        code: ErrorCodes.BARBER_NOT_FOUND,
        message: 'Barbeiro não encontrado.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    return b;
  }

  async create(dto: CreateBarberDto) {
    const created = await this.repo.create({
      displayName: dto.displayName,
      bio: dto.bio,
    } as Prisma.BarberCreateInput);
    if (dto.email) {
      await this.invitations.issue({
        barberId: created.id,
        email: dto.email,
        displayName: dto.displayName,
      });
    }
    return created;
  }

  async update(id: string, dto: UpdateBarberDto) {
    await this.getById(id);
    return this.repo.update(id, dto);
  }

  async softDelete(id: string) {
    await this.getById(id);
    return this.repo.softDelete(id);
  }
}
