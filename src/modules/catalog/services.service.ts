import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { ServiceRepository } from './repositories/service.repository';
import { CreateServiceDto } from './dto/create-service.dto';
import { UpdateServiceDto } from './dto/update-service.dto';

@Injectable()
export class ServicesService {
  constructor(private readonly repo: ServiceRepository) {}

  list() {
    return this.repo.list();
  }

  async getById(id: string) {
    const s = await this.repo.findById(id);
    if (!s) {
      throw new DomainException({
        code: ErrorCodes.SERVICE_NOT_FOUND,
        message: 'Serviço não encontrado.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    return s;
  }

  create(dto: CreateServiceDto) {
    return this.repo.create({
      name: dto.name,
      description: dto.description,
      durationMin: dto.durationMin,
      priceCents: dto.priceCents,
      ...(dto.active !== undefined ? { active: dto.active } : {}),
    } as Prisma.ServiceCreateInput);
  }

  async update(id: string, dto: UpdateServiceDto) {
    await this.getById(id);
    return this.repo.update(id, dto);
  }

  async softDelete(id: string) {
    await this.getById(id);
    return this.repo.softDelete(id);
  }
}
