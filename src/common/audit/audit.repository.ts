import { Injectable } from '@nestjs/common';
import { AuditLog, Prisma } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AuditQuery, AuditRecordInput } from './audit.types';

@Injectable()
export class AuditRepository {
  constructor(private readonly prisma: PrismaService) {}

  insert(input: AuditRecordInput): Promise<AuditLog> {
    return this.prisma.auditLog.create({
      data: {
        action: input.action,
        tenantId: input.tenantId ?? null,
        actorUserId: input.actorUserId ?? null,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        diff: (input.diff ?? null) as Prisma.InputJsonValue | undefined,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
  }

  async listPaginated(
    q: AuditQuery,
  ): Promise<{ rows: AuditLog[]; total: number; page: number; pageSize: number }> {
    const where: Prisma.AuditLogWhereInput = {
      tenantId: q.tenantId,
      actorUserId: q.actorUserId,
      action: q.action,
      createdAt:
        q.from || q.to
          ? {
              gte: q.from,
              lte: q.to,
            }
          : undefined,
    };
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { rows, total, page: q.page, pageSize: q.pageSize };
  }
}
