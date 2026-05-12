import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { BarberRepository } from './repositories/barber.repository';
import { CreateBarberDto } from './dto/create-barber.dto';
import { UpdateBarberDto } from './dto/update-barber.dto';

@Injectable()
export class BarbersService {
  constructor(private readonly repo: BarberRepository) {}

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

  create(dto: CreateBarberDto) {
    // email is validated in DTO but intentionally ignored here — invitation flow is wired in Task 8
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { email, ...rest } = dto;
    // tenantId will be injected at runtime by the PrismaService ALS extension
    return this.repo.create(rest as Prisma.BarberCreateInput);
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
