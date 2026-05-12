import { Injectable } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class SaasUserRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(args: { role?: UserRole; search?: string; page: number; pageSize: number }) {
    const where: Prisma.UserWhereInput = {
      role: args.role,
      OR: args.search
        ? [
            { email: { contains: args.search, mode: 'insensitive' } },
            { name: { contains: args.search, mode: 'insensitive' } },
          ]
        : undefined,
    };
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          emailVerifiedAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: (args.page - 1) * args.pageSize,
        take: args.pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);
    return { rows, total };
  }
}
