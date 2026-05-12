import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { ALLOW_INACTIVE_SUBSCRIPTION_KEY } from 'src/modules/billing/billing.constants';
import { SubscriptionRepository } from 'src/modules/billing/repositories/subscription.repository';

@Injectable()
export class SubscriptionActiveGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly subscriptions: SubscriptionRepository,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{ user?: { tenantId?: string } }>();
    const tenantId = req.user?.tenantId;
    if (!tenantId) return true;

    const allowInactive = this.reflector.getAllAndOverride<boolean>(
      ALLOW_INACTIVE_SUBSCRIPTION_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (allowInactive) return true;

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
    return true;
  }
}
