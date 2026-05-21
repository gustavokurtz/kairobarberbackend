import { HttpStatus, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { PrismaService, tenantAls } from 'src/infra/prisma/prisma.service';

@Injectable()
export class PublicTenantMiddleware implements NestMiddleware {
  constructor(private readonly prisma: PrismaService) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const slug = (req.params as Record<string, string>)?.slug ?? this.extractSlugFromUrl(req.url);
    if (!slug) {
      return next(
        new DomainException({
          code: ErrorCodes.TENANT_NOT_FOUND,
          message: 'Slug ausente.',
          status: HttpStatus.NOT_FOUND,
        }),
      );
    }
    const tenant = await this.prisma.tenant.findFirst({
      where: { slug, deletedAt: null },
      include: { subscription: true },
    });
    if (!tenant) {
      return next(
        new DomainException({
          code: ErrorCodes.TENANT_NOT_FOUND,
          message: 'Barbearia não encontrada.',
          status: HttpStatus.NOT_FOUND,
        }),
      );
    }
    if (
      tenant.subscription &&
      (tenant.subscription.status === 'cancelled' || tenant.subscription.status === 'past_due')
    ) {
      return next(
        new DomainException({
          code: ErrorCodes.TENANT_NOT_FOUND,
          message: 'Barbearia não encontrada.',
          status: HttpStatus.NOT_FOUND,
        }),
      );
    }
    if (tenant.suspendedAt) {
      return next(
        new DomainException({
          code: ErrorCodes.TENANT_NOT_FOUND,
          message: 'Barbearia não encontrada.',
          status: HttpStatus.NOT_FOUND,
        }),
      );
    }
    const store = tenantAls.getStore();
    if (store) store.tenantId = tenant.id;
    next();
  }

  private extractSlugFromUrl(url: string | undefined): string | undefined {
    if (!url) return undefined;
    const m = /^\/public\/([^/?#]+)/.exec(url);
    return m?.[1];
  }
}
