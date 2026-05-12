import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SubscriptionActiveGuard } from './subscription-active.guard';
import { ALLOW_INACTIVE_SUBSCRIPTION_KEY } from 'src/modules/billing/billing.constants';

function mkContext(opts: {
  user?: { tenantId?: string };
  url?: string;
  metadata?: Record<string, unknown>;
}): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({ user: opts.user, url: opts.url ?? '/admin/foo' }),
    }),
  } as never as ExecutionContext;
}

describe('SubscriptionActiveGuard', () => {
  const reflector = new Reflector();
  let repo: { findByTenantId: jest.Mock };
  let guard: SubscriptionActiveGuard;

  beforeEach(() => {
    repo = { findByTenantId: jest.fn() };
    guard = new SubscriptionActiveGuard(reflector, repo as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('libera quando não há user.tenantId (deixa outras guards reclamarem)', async () => {
    expect(await guard.canActivate(mkContext({ user: undefined }))).toBe(true);
  });

  it('libera quando endpoint tem @AllowInactiveSubscription mesmo se cancelled', async () => {
    repo.findByTenantId.mockResolvedValue({ status: 'cancelled' });
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockImplementation((key: string) => key === ALLOW_INACTIVE_SUBSCRIPTION_KEY);
    expect(await guard.canActivate(mkContext({ user: { tenantId: 't1' } }))).toBe(true);
  });

  it('libera quando subscription é trialing, active ou past_due', async () => {
    for (const status of ['trialing', 'active', 'past_due']) {
      repo.findByTenantId.mockResolvedValue({ status });
      expect(await guard.canActivate(mkContext({ user: { tenantId: 't1' } }))).toBe(true);
    }
  });

  it('SUBSCRIPTION_INACTIVE (402) quando cancelled e endpoint não whitelisted', async () => {
    repo.findByTenantId.mockResolvedValue({ status: 'cancelled' });
    await expect(guard.canActivate(mkContext({ user: { tenantId: 't1' } }))).rejects.toMatchObject({
      opts: { code: 'SUBSCRIPTION_INACTIVE', status: 402 },
    });
  });

  it('SUBSCRIPTION_NOT_FOUND (404) quando subscription ausente', async () => {
    repo.findByTenantId.mockResolvedValue(null);
    await expect(guard.canActivate(mkContext({ user: { tenantId: 't1' } }))).rejects.toMatchObject({
      opts: { code: 'SUBSCRIPTION_NOT_FOUND' },
    });
  });
});
