import { createParamDecorator, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AuthenticatedRequest } from '../types/request-context';
import { tenantAls } from 'src/infra/prisma/prisma.service';

export const CurrentTenant = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  const tenantId = req.user?.tenantId ?? tenantAls.getStore()?.tenantId;
  if (!tenantId) throw new ForbiddenException('No tenant in context');
  return tenantId;
});
