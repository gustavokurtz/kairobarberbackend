import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { CustomerRepository } from './repositories/customer.repository';

export type FindOrCreateInput = {
  name: string;
  phone: string;
  email?: string;
};

const CLAIM_TOKEN_TTL_DAYS = 7;

@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  constructor(private readonly repo: CustomerRepository) {}

  async getById(id: string) {
    const c = await this.repo.findById(id);
    if (!c) {
      throw new DomainException({
        code: ErrorCodes.CUSTOMER_NOT_FOUND,
        message: 'Cliente não encontrado.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    return c;
  }

  list(search?: string) {
    return this.repo.list(search);
  }

  listAppointments(customerId: string) {
    return this.repo.listAppointmentsForCustomer(customerId);
  }

  async findOrCreateByPhone(input: FindOrCreateInput) {
    const existing = await this.repo.findByPhone(input.phone);
    if (existing) {
      const patch: { name?: string; email?: string } = {};
      if (existing.name !== input.name) patch.name = input.name;
      if (input.email && existing.email !== input.email) patch.email = input.email;
      if (Object.keys(patch).length > 0) {
        await this.repo.update(existing.id, patch);
        this.logger.log(
          `customer.identity_updated id=${existing.id} fields=${Object.keys(patch).join(',')}`,
        );
      }
      return {
        customer: { ...existing, ...patch },
        claimPlainToken: undefined as string | undefined,
      };
    }

    let claimPlainToken: string | undefined;
    let claimTokenHash: string | undefined;
    let claimTokenExpiresAt: Date | undefined;
    if (input.email) {
      claimPlainToken = randomBytes(32).toString('base64url');
      claimTokenHash = createHash('sha256').update(claimPlainToken).digest('hex');
      claimTokenExpiresAt = new Date(Date.now() + CLAIM_TOKEN_TTL_DAYS * 24 * 3600 * 1000);
    }

    const data: Omit<Prisma.CustomerUncheckedCreateInput, 'tenantId'> = {
      name: input.name,
      phone: input.phone,
      email: input.email ?? null,
      ...(claimTokenHash ? { claimTokenHash, claimTokenExpiresAt } : {}),
    };
    const customer = await this.repo.create(data as Prisma.CustomerUncheckedCreateInput);

    return { customer, claimPlainToken };
  }

  async consumeClaimToken(plainToken: string) {
    const claimTokenHash = createHash('sha256').update(plainToken).digest('hex');
    const customer = await this.repo.findByClaimTokenHash(claimTokenHash);
    if (!customer || !customer.claimTokenExpiresAt || customer.claimTokenExpiresAt < new Date()) {
      throw new DomainException({
        code: ErrorCodes.CLAIM_TOKEN_INVALID,
        message: 'Token de claim inválido ou expirado.',
        status: HttpStatus.BAD_REQUEST,
      });
    }
    if (customer.userId) {
      throw new DomainException({
        code: ErrorCodes.CLAIM_TOKEN_INVALID,
        message: 'Conta já reivindicada.',
        status: HttpStatus.CONFLICT,
      });
    }
    return customer;
  }

  async linkUser(customerId: string, userId: string) {
    return this.repo.update(customerId, {
      user: { connect: { id: userId } },
      claimTokenHash: null,
      claimTokenExpiresAt: null,
    });
  }
}
