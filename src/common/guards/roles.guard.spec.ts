import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { UserRole } from '@prisma/client';

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: jest.Mocked<Reflector>;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() } as unknown as jest.Mocked<Reflector>;
    guard = new RolesGuard(reflector);
  });

  function ctxFor(user: { role: UserRole }): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
  }

  it('allows when no @Roles applied', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    expect(guard.canActivate(ctxFor({ role: 'customer' }))).toBe(true);
  });

  it('blocks when user role not in list', () => {
    reflector.getAllAndOverride.mockReturnValue(['tenant_owner']);
    expect(() => guard.canActivate(ctxFor({ role: 'customer' }))).toThrow();
  });

  it('allows when role matches', () => {
    reflector.getAllAndOverride.mockReturnValue(['tenant_owner']);
    expect(guard.canActivate(ctxFor({ role: 'tenant_owner' }))).toBe(true);
  });
});
