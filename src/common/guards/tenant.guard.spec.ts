import { ExecutionContext } from '@nestjs/common';
import { TenantGuard } from './tenant.guard';

describe('TenantGuard', () => {
  const guard = new TenantGuard();

  function makeCtx(user: unknown): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext;
  }

  it('blocks when user has no tenantId', () => {
    expect(() => guard.canActivate(makeCtx({ id: 'u1', role: 'tenant_owner' }))).toThrow();
  });

  it('allows when user has tenantId', () => {
    expect(guard.canActivate(makeCtx({ id: 'u1', role: 'tenant_owner', tenantId: 't1' }))).toBe(
      true,
    );
  });
});
