import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class BarberInvitationRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: { barberId: string; email: string; tokenHash: string; expiresAt: Date }) {
    return this.prisma.scoped.barberInvitation.create({
      data: data as Prisma.BarberInvitationUncheckedCreateInput,
    });
  }

  findByTokenHash(tokenHash: string) {
    // NOT scoped: aceite do convite é PÚBLICO (sem tenant no contexto).
    return this.prisma.barberInvitation.findUnique({
      where: { tokenHash },
      include: { barber: true, tenant: true },
    });
  }

  markAccepted(id: string) {
    return this.prisma.barberInvitation.update({
      where: { id },
      data: { acceptedAt: new Date() },
    });
  }
}
