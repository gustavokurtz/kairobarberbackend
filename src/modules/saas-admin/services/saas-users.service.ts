import { Injectable } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { SaasUserRepository } from '../repositories/saas-user.repository';

@Injectable()
export class SaasUsersService {
  constructor(private readonly repo: SaasUserRepository) {}

  async list(args: { role?: UserRole; search?: string; page: number; pageSize: number }) {
    const { rows, total } = await this.repo.list(args);
    return {
      page: args.page,
      pageSize: args.pageSize,
      total,
      data: rows,
    };
  }
}
