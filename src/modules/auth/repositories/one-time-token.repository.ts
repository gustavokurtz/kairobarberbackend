import { Injectable } from '@nestjs/common';
import { OneTimeTokenPurpose } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class OneTimeTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: {
    userId: string;
    purpose: OneTimeTokenPurpose;
    tokenHash: string;
    expiresAt: Date;
  }) {
    return this.prisma.oneTimeToken.create({ data });
  }

  findValidByHash(tokenHash: string, purpose: OneTimeTokenPurpose) {
    return this.prisma.oneTimeToken.findFirst({
      where: { tokenHash, purpose, usedAt: null, expiresAt: { gt: new Date() } },
    });
  }

  markUsed(id: string) {
    return this.prisma.oneTimeToken.update({ where: { id }, data: { usedAt: new Date() } });
  }
}
