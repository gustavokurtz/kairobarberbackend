import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SubscriptionActiveGuard } from './subscription-active.guard';
import { ALLOW_INACTIVE_SUBSCRIPTION_KEY } from 'src/modules/billing/billing.constants';
import { PrismaService } from 'src/infra/prisma/prisma.service';

function mkContext(opts: {
  user?: { tenantId?: string };
  url?: string;
  method?: string;
  headers?: Record<string, string>;
}): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({
        user: opts.user,
        url: opts.url ?? '/admin/foo',
        method: opts.method ?? 'GET',
        headers: opts.headers ?? {},
      }),
    }),
  } as never as ExecutionContext;
}

describe('SubscriptionActiveGuard', () => {
  const reflector = new Reflector();
  let repo: { findByTenantId: jest.Mock };
  let tokens: { verifyAccess: jest.Mock };
  let prisma: { tenant: { findUnique: jest.Mock } };
  let guard: SubscriptionActiveGuard;

  beforeEach(() => {
    repo = { findByTenantId: jest.fn() };
    tokens = { verifyAccess: jest.fn() };
    prisma = {
      tenant: { findUnique: jest.fn().mockResolvedValue({ suspendedAt: null }) },
    };
    guard = new SubscriptionActiveGuard(
      reflector,
      repo as never,
      tokens as never,
      prisma as unknown as PrismaService,
    );
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

  it('libera GET quando subscription é trialing, active ou past_due', async () => {
    for (const status of ['trialing', 'active', 'past_due']) {
      repo.findByTenantId.mockResolvedValue({ status });
      expect(await guard.canActivate(mkContext({ user: { tenantId: 't1' }, method: 'GET' }))).toBe(
        true,
      );
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

  it('lança TENANT_SUSPENDED quando suspendedAt != null', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({ suspendedAt: new Date() });
    await expect(guard.canActivate(mkContext({ user: { tenantId: 't1' } }))).rejects.toMatchObject({
      opts: { code: 'TENANT_SUSPENDED', status: 402 },
    });
  });
});

describe('SubscriptionActiveGuard — past_due gating', () => {
  const reflector = new Reflector();
  let repo: { findByTenantId: jest.Mock };
  let tokens: { verifyAccess: jest.Mock };
  let prisma: { tenant: { findUnique: jest.Mock } };
  let guard: SubscriptionActiveGuard;

  beforeEach(() => {
    repo = { findByTenantId: jest.fn() };
    tokens = { verifyAccess: jest.fn() };
    prisma = {
      tenant: { findUnique: jest.fn().mockResolvedValue({ suspendedAt: null }) },
    };
    guard = new SubscriptionActiveGuard(
      reflector,
      repo as never,
      tokens as never,
      prisma as unknown as PrismaService,
    );
  });

  it('libera GET em past_due', async () => {
    repo.findByTenantId.mockResolvedValue({ status: 'past_due' });
    const ctx = mkContext({
      method: 'GET',
      url: '/admin/services',
      user: { tenantId: 't1' },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('bloqueia POST em past_due com SUBSCRIPTION_PAST_DUE + 402', async () => {
    repo.findByTenantId.mockResolvedValue({ status: 'past_due' });
    const ctx = mkContext({
      method: 'POST',
      url: '/admin/services',
      user: { tenantId: 't1' },
    });
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      opts: { code: 'SUBSCRIPTION_PAST_DUE', status: 402 },
    });
  });

  it.each(['PUT', 'PATCH', 'DELETE'])('bloqueia %s em past_due', async (method) => {
    repo.findByTenantId.mockResolvedValue({ status: 'past_due' });
    const ctx = mkContext({
      method,
      url: '/admin/services/abc',
      user: { tenantId: 't1' },
    });
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      opts: { code: 'SUBSCRIPTION_PAST_DUE', status: 402 },
    });
  });

  it('libera POST /admin/billing/checkout em past_due (whitelist)', async () => {
    repo.findByTenantId.mockResolvedValue({ status: 'past_due' });
    const ctx = mkContext({
      method: 'POST',
      url: '/admin/billing/checkout',
      user: { tenantId: 't1' },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('libera POST /admin/billing/sync em past_due (whitelist)', async () => {
    repo.findByTenantId.mockResolvedValue({ status: 'past_due' });
    const ctx = mkContext({
      method: 'POST',
      url: '/admin/billing/sync',
      user: { tenantId: 't1' },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('libera POST em trialing e active', async () => {
    repo.findByTenantId.mockResolvedValue({ status: 'trialing' });
    const ctx1 = mkContext({
      method: 'POST',
      url: '/admin/services',
      user: { tenantId: 't1' },
    });
    await expect(guard.canActivate(ctx1)).resolves.toBe(true);

    repo.findByTenantId.mockResolvedValue({ status: 'active' });
    const ctx2 = mkContext({
      method: 'POST',
      url: '/admin/services',
      user: { tenantId: 't1' },
    });
    await expect(guard.canActivate(ctx2)).resolves.toBe(true);
  });

  it('bloqueia POST em cancelled com SUBSCRIPTION_INACTIVE (comportamento existente)', async () => {
    repo.findByTenantId.mockResolvedValue({ status: 'cancelled' });
    const ctx = mkContext({
      method: 'POST',
      url: '/admin/services',
      user: { tenantId: 't1' },
    });
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      opts: { code: 'SUBSCRIPTION_INACTIVE', status: 402 },
    });
  });

  it('whitelist /admin/billing/* libera mesmo sem tenantId/headers', async () => {
    const ctx = mkContext({
      method: 'POST',
      url: '/admin/billing/checkout',
      user: undefined,
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});
