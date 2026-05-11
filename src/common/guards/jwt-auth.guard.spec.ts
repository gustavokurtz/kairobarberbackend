import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import { TokensService } from 'src/modules/auth/tokens.service';

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let tokens: jest.Mocked<TokensService>;
  let reflector: jest.Mocked<Reflector>;

  beforeEach(() => {
    tokens = { verifyAccess: jest.fn() } as unknown as jest.Mocked<TokensService>;
    reflector = { getAllAndOverride: jest.fn() } as unknown as jest.Mocked<Reflector>;
    guard = new JwtAuthGuard(tokens, reflector);
  });

  function makeCtx(reqObj: Record<string, unknown>): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => reqObj }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
  }

  it('allows when @Public', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    const ctx = makeCtx({ headers: {} });
    const ok = await guard.canActivate(ctx);
    expect(ok).toBe(true);
  });

  it('throws when missing header', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    const ctx = makeCtx({ headers: {} });
    await expect(guard.canActivate(ctx)).rejects.toThrow();
  });

  it('attaches user to request when valid', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    (tokens.verifyAccess as jest.Mock).mockResolvedValue({
      sub: 'u1',
      role: 'tenant_owner',
      tenantId: 't1',
    });
    const reqObj: Record<string, unknown> = { headers: { authorization: 'Bearer abc' } };
    const ctx = makeCtx(reqObj);
    const ok = await guard.canActivate(ctx);
    expect(ok).toBe(true);
    expect(reqObj['user']).toEqual({ id: 'u1', role: 'tenant_owner', tenantId: 't1' });
  });
});
