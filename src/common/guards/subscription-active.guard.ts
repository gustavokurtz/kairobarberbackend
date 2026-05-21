import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { ALLOW_INACTIVE_SUBSCRIPTION_KEY } from 'src/modules/billing/billing.constants';
import { SubscriptionRepository } from 'src/modules/billing/repositories/subscription.repository';
import { TokensService } from 'src/modules/auth/tokens.service';
import { PrismaService } from 'src/infra/prisma/prisma.service';

const BILLING_WHITELIST_PREFIX = '/admin/billing/';
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

@Injectable()
export class SubscriptionActiveGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly subscriptions: SubscriptionRepository,
    private readonly tokens: TokensService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{
      method?: string;
      url?: string;
      user?: { tenantId?: string };
      headers: Record<string, string | undefined>;
    }>();

    // Whitelist hardcoded: /admin/billing/* é o único caminho de saída do
    // past_due/cancelled (checkout, sync, cancel). Decorator esquecível seria pior.
    if (req.url?.startsWith(BILLING_WHITELIST_PREFIX)) {
      return true;
    }

    // APP_GUARDs from different modules don't have a deterministic cross-module
    // execution order, so JwtAuthGuard may not have populated req.user yet.
    // Parse the bearer token directly when req.user is missing.
    let tenantId = req.user?.tenantId;
    if (!tenantId) {
      const header = req.headers['authorization'];
      if (header?.startsWith('Bearer ')) {
        try {
          const payload = await this.tokens.verifyAccess(header.slice('Bearer '.length));
          tenantId = payload.tenantId;
        } catch {
          return true;
        }
      }
    }
    if (!tenantId) return true;

    const allowInactive = this.reflector.getAllAndOverride<boolean>(
      ALLOW_INACTIVE_SUBSCRIPTION_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (allowInactive) return true;

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { suspendedAt: true },
    });
    if (tenant?.suspendedAt) {
      throw new DomainException({
        code: ErrorCodes.TENANT_SUSPENDED,
        message: 'Tenant suspenso pelo administrador. Contate o suporte.',
        status: HttpStatus.PAYMENT_REQUIRED,
      });
    }

    const sub = await this.subscriptions.findByTenantId(tenantId);
    if (!sub) {
      throw new DomainException({
        code: ErrorCodes.SUBSCRIPTION_NOT_FOUND,
        message: 'Assinatura não encontrada.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    if (sub.status === 'cancelled') {
      throw new DomainException({
        code: ErrorCodes.SUBSCRIPTION_INACTIVE,
        message: 'Assinatura inativa. Renove para continuar usando o admin.',
        status: HttpStatus.PAYMENT_REQUIRED,
      });
    }
    // past_due bloqueia apenas mutações; GET continua liberado. Spec INV-02/INV-09.
    if (sub.status === 'past_due' && WRITE_METHODS.has(req.method?.toUpperCase() ?? '')) {
      throw new DomainException({
        code: ErrorCodes.SUBSCRIPTION_PAST_DUE,
        message: 'Pagamento pendente. Acesse /admin/billing pra regularizar e voltar a operar.',
        status: HttpStatus.PAYMENT_REQUIRED,
      });
    }
    return true;
  }
}
