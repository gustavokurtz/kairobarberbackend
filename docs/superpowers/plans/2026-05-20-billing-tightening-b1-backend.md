# Billing Tightening — Fase B1 (Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apertar a janela de inadimplência no backend: reduzir grace de 7→1 dia, bloquear escritas em `past_due`, fazer storefront cair em 404 nesse estado, acelerar cron sync pra 1x/hora, e expor `GET /admin/billing/status` com countdown e origem (trial vs payment) pro front consumir.

**Architecture:** Mudanças cirúrgicas em 3 arquivos existentes (guard, middleware, env validation) + 1 novo método no service + 1 novo endpoint no controller. Sem migration. Sem nova coluna. Filtragem leitura/escrita por método HTTP (GET libera, POST/PUT/PATCH/DELETE bloqueia em `past_due`), com whitelist hardcoded `/admin/billing/*`. Diferenciação trial vs payment via `currentPeriodEnd IS NOT NULL` (proxy).

**Tech Stack:** NestJS 11, Prisma 5, TypeScript estrito. Tests com Jest + supertest + testcontainers (Postgres + Redis). Spec base: [docs/superpowers/specs/2026-05-20-trial-grace-tightening-design.md](../specs/2026-05-20-trial-grace-tightening-design.md).

---

## Task 0: Recall (re-leitura obrigatória)

**Files:** nenhum (só leitura)

- [ ] **Step 1: Re-ler o spec inteiro**

Abrir e ler completamente:
`/home/ntconsult/Projetos/meus/kairobarber/kairobarber-api/docs/superpowers/specs/2026-05-20-trial-grace-tightening-design.md`

- [ ] **Step 2: Echo-back de 5 bullets antes de codar qualquer linha**

Responder mentalmente (ou em comentário no PR draft):
1. Em que método HTTP eu bloqueio em `past_due`? → `POST`, `PUT`, `PATCH`, `DELETE`. GET libera.
2. Qual é o whitelist de paths que funciona em qualquer status? → `/admin/billing/*` (qualquer subpath).
3. Qual é o default novo do `BILLING_PAST_DUE_GRACE_DAYS`? → `1` (era `7`).
4. O backend diferencia trial-origin vs payment-origin no gating? → **Não.** Mesma regra. Só `GET /admin/billing/status` expõe o `origin` pra UI.
5. Qual é o código HTTP de erro pra escrita bloqueada em `past_due`? → `402 Payment Required` + `code: 'SUBSCRIPTION_PAST_DUE'`.

---

## File Structure

**Modificados:**
- `src/config/env.validation.ts` — defaults: `BILLING_PAST_DUE_GRACE_DAYS=1`, `BILLING_SYNC_CRON='0 * * * *'`
- `.env.example` — mesmos defaults atualizados
- `src/common/exceptions/error-codes.ts` — novo `SUBSCRIPTION_PAST_DUE`
- `src/common/guards/subscription-active.guard.ts` — bypass `/admin/billing/*` + bloquear escritas em `past_due`
- `src/common/middleware/public-tenant.middleware.ts` — incluir `past_due` no 404
- `src/modules/billing/billing.service.ts` — novo método `getBillingStatus(tenantId)`
- `src/modules/billing/billing.controller.ts` — novo endpoint `GET /admin/billing/status`
- `src/modules/billing/billing.service.spec.ts` — atualizar mocks (grace 7→1)
- `src/modules/billing/billing.cron.spec.ts` — atualizar mocks (grace 7→1)
- `src/modules/billing/billing.checkout.spec.ts` — atualizar mocks (grace 7→1)
- `test/support/test-env.ts` — atualizar default de test env
- `test/e2e/billing-trial-check.e2e-spec.ts` — atualizar assertion da janela (7d → 1d)
- `CLAUDE.md` — corrigir "trial 14 dias" → "trial 3 dias, grace 1 dia"
- `docs/superpowers/specs/2026-05-11-kairobarber-backend-design.md` — atualizar seção billing referenciando o spec novo

**Criados:**
- `src/modules/billing/dto/billing-status-view.dto.ts` — DTO de resposta do `GET /status`
- `src/common/guards/subscription-active.guard.spec.ts` — **já existe**, atualizar com novos casos
- `test/e2e/billing-past-due-gating.e2e-spec.ts` — novo arquivo de e2e cobrindo gating em past_due (trial-origin + payment-origin)

---

## Task 1: Atualizar defaults de env e .env.example

**Files:**
- Modify: `src/config/env.validation.ts:66-67`
- Modify: `.env.example` (linhas 50-51 e seção billing cron, conforme estado atual)

- [ ] **Step 1: Modificar `env.validation.ts`**

Em [src/config/env.validation.ts:66-67](../../src/config/env.validation.ts), trocar:

```typescript
  BILLING_PAST_DUE_GRACE_DAYS: Joi.number().integer().min(0).max(60).default(7),
  BILLING_SYNC_CRON: Joi.string().default('0 6,18 * * *'),
```

Por:

```typescript
  BILLING_PAST_DUE_GRACE_DAYS: Joi.number().integer().min(0).max(60).default(1),
  BILLING_SYNC_CRON: Joi.string().default('0 * * * *'),
```

- [ ] **Step 2: Modificar `.env.example`**

Localizar `BILLING_PAST_DUE_GRACE_DAYS=7` e trocar pra `BILLING_PAST_DUE_GRACE_DAYS=1`.
Localizar `BILLING_SYNC_CRON=0 6,18 * * *` (ou similar) e trocar pra `BILLING_SYNC_CRON=0 * * * *`. Se não existir a linha, adicionar logo abaixo de `BILLING_PAST_DUE_GRACE_DAYS=1`:

```
BILLING_SYNC_CRON=0 * * * *
```

- [ ] **Step 3: Validar que `pnpm build` passa**

Run: `cd /home/ntconsult/Projetos/meus/kairobarber/kairobarber-api && pnpm build`
Expected: exit code 0, sem erros TypeScript.

- [ ] **Step 4: Commit**

```bash
cd /home/ntconsult/Projetos/meus/kairobarber/kairobarber-api
git add src/config/env.validation.ts .env.example
git commit -m "config(billing): grace 7d->1d, sync 2x/dia->1x/hora

Defaults novos: BILLING_PAST_DUE_GRACE_DAYS=1 e BILLING_SYNC_CRON='0 * * * *'.
Spec: docs/superpowers/specs/2026-05-20-trial-grace-tightening-design.md (D-11)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Adicionar `SUBSCRIPTION_PAST_DUE` em ErrorCodes

**Files:**
- Modify: `src/common/exceptions/error-codes.ts:48-54`

- [ ] **Step 1: Adicionar novo código**

Em [src/common/exceptions/error-codes.ts:48](../../src/common/exceptions/error-codes.ts), localizar o bloco "Phase 4 — billing" e adicionar:

```typescript
  // Phase 4 — billing
  SUBSCRIPTION_INACTIVE: 'SUBSCRIPTION_INACTIVE',
  SUBSCRIPTION_PAST_DUE: 'SUBSCRIPTION_PAST_DUE',
  SUBSCRIPTION_ALREADY_ACTIVE: 'SUBSCRIPTION_ALREADY_ACTIVE',
  SUBSCRIPTION_NOT_FOUND: 'SUBSCRIPTION_NOT_FOUND',
  BILLING_PROVIDER_ERROR: 'BILLING_PROVIDER_ERROR',
  BILLING_PROVIDER_UNAUTHORIZED: 'BILLING_PROVIDER_UNAUTHORIZED',
  BILLING_CHECKOUT_FAILED: 'BILLING_CHECKOUT_FAILED',
  TENANT_DOCUMENT_REQUIRED: 'TENANT_DOCUMENT_REQUIRED',
```

- [ ] **Step 2: Validar build**

Run: `pnpm build`
Expected: exit code 0.

- [ ] **Step 3: Commit**

```bash
git add src/common/exceptions/error-codes.ts
git commit -m "feat(billing): adiciona ErrorCode SUBSCRIPTION_PAST_DUE

Usado pelo SubscriptionActiveGuard quando bloquear escrita em past_due.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: Atualizar `SubscriptionActiveGuard` — TDD

**Files:**
- Modify: `src/common/guards/subscription-active.guard.ts`
- Modify: `src/common/guards/subscription-active.guard.spec.ts`

- [ ] **Step 1: Escrever testes que falham**

Abrir [src/common/guards/subscription-active.guard.spec.ts](../../src/common/guards/subscription-active.guard.spec.ts) e adicionar (ou substituir os existentes) os 6 casos abaixo. Manter os imports e o setup já existentes; apenas garantir que `Subscription` e `SubscriptionStatus` venham de `@prisma/client` e que o mock de `ExecutionContext` permita configurar `req.method` e `req.url`.

```typescript
import { ExecutionContext, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SubscriptionStatus } from '@prisma/client';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { SubscriptionActiveGuard } from './subscription-active.guard';

function buildCtx(opts: {
  method: string;
  url: string;
  tenantId?: string;
  headers?: Record<string, string>;
}): ExecutionContext {
  const req = {
    method: opts.method,
    url: opts.url,
    user: opts.tenantId ? { tenantId: opts.tenantId } : undefined,
    headers: opts.headers ?? {},
  };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('SubscriptionActiveGuard — past_due gating', () => {
  let guard: SubscriptionActiveGuard;
  let reflector: jest.Mocked<Reflector>;
  let subscriptionsRepo: { findByTenantId: jest.Mock };
  let prisma: { tenant: { findUnique: jest.Mock } };
  let tokens: { verifyAccess: jest.Mock };

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) } as never;
    subscriptionsRepo = { findByTenantId: jest.fn() };
    prisma = { tenant: { findUnique: jest.fn().mockResolvedValue({ suspendedAt: null }) } };
    tokens = { verifyAccess: jest.fn() };
    guard = new SubscriptionActiveGuard(
      reflector,
      subscriptionsRepo as never,
      tokens as never,
      prisma as never,
    );
  });

  it('libera GET em past_due', async () => {
    subscriptionsRepo.findByTenantId.mockResolvedValue({
      status: SubscriptionStatus.past_due,
    });
    const ctx = buildCtx({ method: 'GET', url: '/admin/services', tenantId: 't1' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('bloqueia POST em past_due com SUBSCRIPTION_PAST_DUE + 402', async () => {
    subscriptionsRepo.findByTenantId.mockResolvedValue({
      status: SubscriptionStatus.past_due,
    });
    const ctx = buildCtx({ method: 'POST', url: '/admin/services', tenantId: 't1' });
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      opts: {
        code: ErrorCodes.SUBSCRIPTION_PAST_DUE,
        status: HttpStatus.PAYMENT_REQUIRED,
      },
    });
  });

  it.each(['PUT', 'PATCH', 'DELETE'])(
    'bloqueia %s em past_due',
    async (method) => {
      subscriptionsRepo.findByTenantId.mockResolvedValue({
        status: SubscriptionStatus.past_due,
      });
      const ctx = buildCtx({ method, url: '/admin/services/abc', tenantId: 't1' });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(DomainException);
    },
  );

  it('libera POST /admin/billing/checkout em past_due (whitelist)', async () => {
    subscriptionsRepo.findByTenantId.mockResolvedValue({
      status: SubscriptionStatus.past_due,
    });
    const ctx = buildCtx({
      method: 'POST',
      url: '/admin/billing/checkout',
      tenantId: 't1',
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('libera POST /admin/billing/sync em past_due (whitelist)', async () => {
    subscriptionsRepo.findByTenantId.mockResolvedValue({
      status: SubscriptionStatus.past_due,
    });
    const ctx = buildCtx({
      method: 'POST',
      url: '/admin/billing/sync',
      tenantId: 't1',
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('libera POST em trialing e active (não-bloqueante fora de past_due/cancelled)', async () => {
    subscriptionsRepo.findByTenantId.mockResolvedValue({
      status: SubscriptionStatus.trialing,
    });
    const ctx1 = buildCtx({ method: 'POST', url: '/admin/services', tenantId: 't1' });
    await expect(guard.canActivate(ctx1)).resolves.toBe(true);

    subscriptionsRepo.findByTenantId.mockResolvedValue({
      status: SubscriptionStatus.active,
    });
    const ctx2 = buildCtx({ method: 'POST', url: '/admin/services', tenantId: 't1' });
    await expect(guard.canActivate(ctx2)).resolves.toBe(true);
  });

  it('bloqueia POST em cancelled com SUBSCRIPTION_INACTIVE (comportamento existente preservado)', async () => {
    subscriptionsRepo.findByTenantId.mockResolvedValue({
      status: SubscriptionStatus.cancelled,
    });
    const ctx = buildCtx({ method: 'POST', url: '/admin/services', tenantId: 't1' });
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      opts: {
        code: ErrorCodes.SUBSCRIPTION_INACTIVE,
        status: HttpStatus.PAYMENT_REQUIRED,
      },
    });
  });
});
```

- [ ] **Step 2: Rodar testes pra confirmar que falham**

Run: `cd /home/ntconsult/Projetos/meus/kairobarber/kairobarber-api && pnpm test src/common/guards/subscription-active.guard.spec.ts`
Expected: FAIL — guard ainda não conhece a regra de past_due nem o whitelist `/admin/billing/*`.

- [ ] **Step 3: Implementar mudanças no guard**

Substituir o conteúdo de [src/common/guards/subscription-active.guard.ts](../../src/common/guards/subscription-active.guard.ts) por:

```typescript
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
      method: string;
      url: string;
      user?: { tenantId?: string };
      headers: Record<string, string | undefined>;
    }>();

    // Whitelist: /admin/billing/* (checkout, sync, cancel, etc) sempre libera —
    // é o único caminho de saída do past_due/cancelled. Hardcoded por segurança
    // (decorator esquecível seria pior).
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
    // past_due bloqueia apenas mutações. Leituras (GET) continuam liberadas
    // pra ele ver os dados — só não pode criar/editar/deletar nada. Spec INV-02.
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
```

- [ ] **Step 4: Rodar testes — devem passar agora**

Run: `pnpm test src/common/guards/subscription-active.guard.spec.ts`
Expected: PASS — 7 testes.

- [ ] **Step 5: Rodar todos os testes unitários pra garantir não-regressão**

Run: `pnpm test`
Expected: todos verdes. Se algum spec antigo de billing falhar por causa do default novo (grace 1d), pular pra Task 6 (atualização dos mocks) antes de commitar esta task.

- [ ] **Step 6: Commit**

```bash
git add src/common/guards/subscription-active.guard.ts src/common/guards/subscription-active.guard.spec.ts
git commit -m "feat(billing): past_due bloqueia escritas, /admin/billing libera

- Whitelist /admin/billing/* (qualquer método) sempre libera
- POST/PUT/PATCH/DELETE em past_due → 402 SUBSCRIPTION_PAST_DUE
- GET em past_due continua liberado (read-only)
- cancelled continua bloqueando tudo (comportamento preservado)

Spec INV-01, INV-02, INV-03, INV-09, D-02, D-10.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: Atualizar `PublicTenantMiddleware` — TDD

**Files:**
- Modify: `src/common/middleware/public-tenant.middleware.ts:35-43`
- Modify: `src/common/middleware/public-tenant.middleware.spec.ts`

- [ ] **Step 1: Escrever teste que falha**

Em [src/common/middleware/public-tenant.middleware.spec.ts](../../src/common/middleware/public-tenant.middleware.spec.ts), adicionar (não substituir, adicionar) os casos:

```typescript
import { ErrorCodes } from 'src/common/exceptions/error-codes';

describe('PublicTenantMiddleware — past_due gating', () => {
  // Replicar o setup do describe existente (mock de PrismaService etc).
  // Use o mesmo padrão de construção do middleware presente no spec atual.

  it('retorna 404 (TENANT_NOT_FOUND) quando subscription.status = past_due', async () => {
    const prisma = {
      tenant: {
        findFirst: jest.fn().mockResolvedValue({
          id: 't1',
          slug: 'mock',
          suspendedAt: null,
          subscription: { status: 'past_due' },
        }),
      },
    };
    const mw = new (await import('./public-tenant.middleware')).PublicTenantMiddleware(
      prisma as never,
    );
    const next = jest.fn();
    await mw.use(
      { params: { slug: 'mock' }, url: '/public/mock' } as never,
      {} as never,
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeDefined();
    expect(err.opts.code).toBe(ErrorCodes.TENANT_NOT_FOUND);
    expect(err.opts.status).toBe(404);
  });

  it('libera quando subscription.status = trialing', async () => {
    const prisma = {
      tenant: {
        findFirst: jest.fn().mockResolvedValue({
          id: 't1',
          slug: 'mock',
          suspendedAt: null,
          subscription: { status: 'trialing' },
        }),
      },
    };
    const mw = new (await import('./public-tenant.middleware')).PublicTenantMiddleware(
      prisma as never,
    );
    const next = jest.fn();
    await mw.use(
      { params: { slug: 'mock' }, url: '/public/mock' } as never,
      {} as never,
      next,
    );
    expect(next).toHaveBeenCalledWith();
  });
});
```

- [ ] **Step 2: Rodar testes — devem falhar**

Run: `pnpm test src/common/middleware/public-tenant.middleware.spec.ts`
Expected: FAIL — `past_due` ainda não retorna 404.

- [ ] **Step 3: Implementar mudança no middleware**

Em [src/common/middleware/public-tenant.middleware.ts:35](../../src/common/middleware/public-tenant.middleware.ts), trocar:

```typescript
    if (tenant.subscription && tenant.subscription.status === 'cancelled') {
```

Por:

```typescript
    if (
      tenant.subscription &&
      (tenant.subscription.status === 'cancelled' ||
        tenant.subscription.status === 'past_due')
    ) {
```

- [ ] **Step 4: Rodar testes — devem passar**

Run: `pnpm test src/common/middleware/public-tenant.middleware.spec.ts`
Expected: PASS — todos os casos.

- [ ] **Step 5: Commit**

```bash
git add src/common/middleware/public-tenant.middleware.ts src/common/middleware/public-tenant.middleware.spec.ts
git commit -m "feat(billing): storefront pública cai em 404 em past_due

Mesma resposta de cancelled (TENANT_NOT_FOUND/404), pra forçar
pressão social: cliente não consegue agendar, barbeiro corre pra pagar.

Spec INV-07.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: Criar DTO `BillingStatusViewDto`

**Files:**
- Create: `src/modules/billing/dto/billing-status-view.dto.ts`

- [ ] **Step 1: Criar arquivo**

```typescript
import { SubscriptionStatus } from '@prisma/client';

export type BillingStatusOrigin = 'trial' | 'payment' | null;

export interface BillingStatusViewDto {
  status: SubscriptionStatus;
  origin: BillingStatusOrigin;
  deadlineAt: Date | null;
  msUntilDeadline: number | null;
  hasCheckout: boolean;
}
```

- [ ] **Step 2: Validar build**

Run: `pnpm build`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/modules/billing/dto/billing-status-view.dto.ts
git commit -m "feat(billing): DTO BillingStatusViewDto pro endpoint /status

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: Adicionar método `getBillingStatus` em `BillingService` — TDD

**Files:**
- Modify: `src/modules/billing/billing.service.ts`
- Modify: `src/modules/billing/billing.service.spec.ts`

- [ ] **Step 1: Escrever testes que falham**

Em [src/modules/billing/billing.service.spec.ts](../../src/modules/billing/billing.service.spec.ts), adicionar (não substituir) ao final do `describe('BillingService', ...)`:

```typescript
  describe('getBillingStatus', () => {
    const FIXED_NOW = new Date('2026-05-20T12:00:00Z');

    beforeEach(() => {
      process.env.BILLING_NOW_OVERRIDE_MS = String(FIXED_NOW.getTime());
    });
    afterEach(() => {
      delete process.env.BILLING_NOW_OVERRIDE_MS;
    });

    it('trialing → origin=trial, deadlineAt=trialEndsAt', async () => {
      const trialEndsAt = new Date('2026-05-23T12:00:00Z');
      repo.findByTenantId.mockResolvedValue({
        id: 's1',
        tenantId: 't1',
        status: 'trialing',
        trialEndsAt,
        currentPeriodEnd: null,
        mpPreapprovalId: null,
        lastSyncedAt: null,
        nextSyncAt: null,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      } as never);

      const out = await service.getBillingStatus('t1');
      expect(out).toEqual({
        status: 'trialing',
        origin: 'trial',
        deadlineAt: trialEndsAt,
        msUntilDeadline: 3 * 24 * 60 * 60 * 1000,
        hasCheckout: false,
      });
    });

    it('past_due + currentPeriodEnd null → origin=trial', async () => {
      repo.findByTenantId.mockResolvedValue({
        id: 's1',
        tenantId: 't1',
        status: 'past_due',
        trialEndsAt: new Date('2026-05-19T12:00:00Z'),
        currentPeriodEnd: null,
        mpPreapprovalId: null,
        lastSyncedAt: null,
        nextSyncAt: null,
        createdAt: FIXED_NOW,
        updatedAt: new Date('2026-05-19T12:00:00Z'),
      } as never);

      const out = await service.getBillingStatus('t1');
      expect(out.origin).toBe('trial');
      expect(out.deadlineAt).toEqual(new Date('2026-05-20T12:00:00Z'));
      expect(out.msUntilDeadline).toBe(0);
    });

    it('past_due + currentPeriodEnd não-null → origin=payment', async () => {
      const periodEnd = new Date('2026-05-10T12:00:00Z');
      const updatedAt = new Date('2026-05-20T06:00:00Z');
      repo.findByTenantId.mockResolvedValue({
        id: 's1',
        tenantId: 't1',
        status: 'past_due',
        trialEndsAt: null,
        currentPeriodEnd: periodEnd,
        mpPreapprovalId: 'mp_abc',
        lastSyncedAt: null,
        nextSyncAt: null,
        createdAt: FIXED_NOW,
        updatedAt,
      } as never);

      const out = await service.getBillingStatus('t1');
      expect(out.origin).toBe('payment');
      expect(out.deadlineAt).toEqual(new Date(updatedAt.getTime() + 24 * 60 * 60 * 1000));
      expect(out.hasCheckout).toBe(true);
    });

    it('active → origin=null, deadlineAt=null, msUntilDeadline=null', async () => {
      repo.findByTenantId.mockResolvedValue({
        id: 's1',
        tenantId: 't1',
        status: 'active',
        trialEndsAt: null,
        currentPeriodEnd: new Date('2026-06-10T12:00:00Z'),
        mpPreapprovalId: 'mp_abc',
        lastSyncedAt: FIXED_NOW,
        nextSyncAt: null,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      } as never);

      const out = await service.getBillingStatus('t1');
      expect(out).toMatchObject({
        status: 'active',
        origin: null,
        deadlineAt: null,
        msUntilDeadline: null,
      });
    });

    it('cancelled → origin=null, deadlineAt=null', async () => {
      repo.findByTenantId.mockResolvedValue({
        id: 's1',
        tenantId: 't1',
        status: 'cancelled',
        trialEndsAt: null,
        currentPeriodEnd: null,
        mpPreapprovalId: null,
        lastSyncedAt: FIXED_NOW,
        nextSyncAt: null,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      } as never);

      const out = await service.getBillingStatus('t1');
      expect(out.origin).toBeNull();
      expect(out.deadlineAt).toBeNull();
      expect(out.msUntilDeadline).toBeNull();
    });

    it('lança SUBSCRIPTION_NOT_FOUND se não existir', async () => {
      repo.findByTenantId.mockResolvedValue(null);
      await expect(service.getBillingStatus('t1')).rejects.toMatchObject({
        opts: { code: 'SUBSCRIPTION_NOT_FOUND' },
      });
    });
  });
```

- [ ] **Step 2: Rodar testes — devem falhar**

Run: `pnpm test src/modules/billing/billing.service.spec.ts -t getBillingStatus`
Expected: FAIL — `service.getBillingStatus` não existe.

- [ ] **Step 3: Implementar o método**

Em [src/modules/billing/billing.service.ts](../../src/modules/billing/billing.service.ts), adicionar logo após o método `getSubscription` (linha ~84):

```typescript
  async getBillingStatus(tenantId: string): Promise<BillingStatusViewDto> {
    const sub = await this.repo.findByTenantId(tenantId);
    if (!sub) {
      throw new DomainException({
        code: ErrorCodes.SUBSCRIPTION_NOT_FOUND,
        message: 'Assinatura não encontrada para o tenant.',
        status: HttpStatus.NOT_FOUND,
      });
    }

    const now = this.now();
    let origin: BillingStatusViewDto['origin'] = null;
    let deadlineAt: Date | null = null;

    if (sub.status === 'trialing') {
      origin = 'trial';
      deadlineAt = sub.trialEndsAt;
    } else if (sub.status === 'past_due') {
      // currentPeriodEnd só fica preenchido após o primeiro pagamento real.
      // Se null em past_due, é porque o trial expirou sem pagamento (trial-origin).
      // Se não-null, já houve cobrança anterior bem-sucedida (payment-origin).
      origin = sub.currentPeriodEnd ? 'payment' : 'trial';
      const graceDays = this.config.get<number>('BILLING_PAST_DUE_GRACE_DAYS') ?? 1;
      deadlineAt = new Date(sub.updatedAt.getTime() + graceDays * 24 * 60 * 60 * 1000);
    }

    const msUntilDeadline = deadlineAt
      ? Math.max(0, deadlineAt.getTime() - now.getTime())
      : null;

    return {
      status: sub.status,
      origin,
      deadlineAt,
      msUntilDeadline,
      hasCheckout: Boolean(sub.mpPreapprovalId),
    };
  }
```

Adicionar import no topo do arquivo, junto aos outros imports do diretório `dto`:

```typescript
import type { BillingStatusViewDto } from './dto/billing-status-view.dto';
```

- [ ] **Step 4: Rodar testes — devem passar**

Run: `pnpm test src/modules/billing/billing.service.spec.ts -t getBillingStatus`
Expected: PASS — 6 testes.

- [ ] **Step 5: Rodar TODOS os testes do billing (pode precisar atualizar mocks)**

Run: `pnpm test src/modules/billing`
Expected: PASS. Se `billing.service.spec.ts`, `billing.cron.spec.ts` ou `billing.checkout.spec.ts` falharem por causa do default novo de `BILLING_PAST_DUE_GRACE_DAYS`, atualizar os mocks:
- Buscar `BILLING_PAST_DUE_GRACE_DAYS: 7` → trocar pra `BILLING_PAST_DUE_GRACE_DAYS: 1` apenas onde o teste depende do valor padrão. Se o teste explicitamente seta 7 pra testar grace de 7 dias (cenário do spec antigo), mudar o cenário pra refletir 1 dia.

Em [test/support/test-env.ts:15](../../test/support/test-env.ts), trocar:
```typescript
process.env.BILLING_PAST_DUE_GRACE_DAYS = process.env.BILLING_PAST_DUE_GRACE_DAYS ?? '7';
```
Por:
```typescript
process.env.BILLING_PAST_DUE_GRACE_DAYS = process.env.BILLING_PAST_DUE_GRACE_DAYS ?? '1';
```

- [ ] **Step 6: Commit**

```bash
git add src/modules/billing/billing.service.ts src/modules/billing/billing.service.spec.ts test/support/test-env.ts
git commit -m "feat(billing): novo método getBillingStatus com countdown e origin

Calcula deadline (trialEndsAt pra trial; updatedAt+graceDays pra past_due)
e classifica origem (trial vs payment) via currentPeriodEnd IS NOT NULL.

active/cancelled retornam origin=null, deadline=null.

Spec INV-05, INV-10, D-05, D-08.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: Expor endpoint `GET /admin/billing/status` no controller

**Files:**
- Modify: `src/modules/billing/billing.controller.ts`

- [ ] **Step 1: Adicionar endpoint**

Em [src/modules/billing/billing.controller.ts:35](../../src/modules/billing/billing.controller.ts), logo após o método `getSubscription`, adicionar:

```typescript
  @Get('status')
  @AllowInactiveSubscription()
  async getStatus(@CurrentTenant() tenantId: string) {
    return this.billing.getBillingStatus(tenantId);
  }
```

`@AllowInactiveSubscription()` garante que tenants em `cancelled` também consigam consultar o status (precisam pra UI saber que devem mostrar paywall). E o whitelist `/admin/billing/*` no guard já cobre o caso de past_due.

- [ ] **Step 2: Smoke test via curl (manual)**

Run em terminal separado: `pnpm start:dev` (porta 3000)

Em outro terminal:
```bash
TOKEN="<access token de um tenant em trial>"
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/admin/billing/status | jq
```

Expected: JSON `{ status, origin, deadlineAt, msUntilDeadline, hasCheckout }`. Se não tiver token, pular esse step e confiar nos e2e da Task 8.

- [ ] **Step 3: Validar build + testes unitários**

Run: `pnpm build && pnpm test src/modules/billing`
Expected: tudo verde.

- [ ] **Step 4: Commit**

```bash
git add src/modules/billing/billing.controller.ts
git commit -m "feat(billing): GET /admin/billing/status com countdown e origin

Endpoint consumido pelo front (kairobarber-web) pra renderizar <BillingBanner>
com countdown e copy condicional trial-origin vs payment-origin.

Spec INV-10, R-B1-06.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 8: E2E test cobrindo gating em past_due (ambos os cenários)

**Files:**
- Create: `test/e2e/billing-past-due-gating.e2e-spec.ts`
- Modify: `test/e2e/billing-trial-check.e2e-spec.ts` (atualizar janela de 7d → 1d)

- [ ] **Step 1: Atualizar `billing-trial-check.e2e-spec.ts`**

Em [test/e2e/billing-trial-check.e2e-spec.ts:39](../../test/e2e/billing-trial-check.e2e-spec.ts):

Trocar o nome do test:
```typescript
it('trial expirado → past_due e past_due > 7d → cancelled', async () => {
```
Por:
```typescript
it('trial expirado → past_due e past_due > 1d → cancelled', async () => {
```

Trocar a linha 68 (o setBack do updatedAt):
```typescript
data: { updatedAt: new Date(clockMs - 8 * 24 * 60 * 60 * 1000) },
```
Por:
```typescript
data: { updatedAt: new Date(clockMs - 2 * 24 * 60 * 60 * 1000) },
```

A janela passou de 7d→1d, então simular 2d em past_due é suficiente pra cancelar.

- [ ] **Step 2: Criar novo arquivo de e2e**

Criar [test/e2e/billing-past-due-gating.e2e-spec.ts](../../test/e2e/billing-past-due-gating.e2e-spec.ts):

```typescript
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import { StartedRedis, flushTestRedis, startTestRedis } from '../support/billing';
import { PrismaService } from 'src/infra/prisma/prisma.service';

describe('Billing — past_due gating (e2e)', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let redis: StartedRedis;

  beforeAll(async () => {
    setTestEnv();
    container = await startTestPostgres();
    redis = await startTestRedis();
    app = await buildTestApp();
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await flushTestRedis(redis.url);
    await redis.container.stop();
    await container.stop();
  });

  async function registerAndLogin(slug: string): Promise<{
    accessToken: string;
    tenantId: string;
  }> {
    const server = app.getHttpServer() as unknown as import('http').Server;
    const email = `${slug}@bill.test`;
    const password = 'StrongPass!1';
    const register = await request(server)
      .post('/auth/register/owner')
      .send({
        email,
        password,
        name: `Owner ${slug}`,
        tenantName: `Barber ${slug}`,
        slug,
      })
      .expect(201);
    const accessToken = (register.body as { accessToken: string }).accessToken;
    const tenantId = (register.body as { tenant: { id: string } }).tenant.id;
    return { accessToken, tenantId };
  }

  async function forcePastDue(
    prisma: PrismaService,
    tenantId: string,
    opts: { currentPeriodEnd: Date | null },
  ): Promise<void> {
    await prisma.subscription.update({
      where: { tenantId },
      data: {
        status: 'past_due',
        currentPeriodEnd: opts.currentPeriodEnd,
        mpPreapprovalId: opts.currentPeriodEnd ? 'mp_test' : null,
      },
    });
  }

  describe('cenário trial-origin (currentPeriodEnd null)', () => {
    const slug = 'past-trial';

    it('POST /admin/services em past_due retorna 402 SUBSCRIPTION_PAST_DUE', async () => {
      const { accessToken, tenantId } = await registerAndLogin(slug);
      const prisma = app.get(PrismaService);
      await forcePastDue(prisma, tenantId, { currentPeriodEnd: null });

      const server = app.getHttpServer() as unknown as import('http').Server;
      const res = await request(server)
        .post('/admin/services')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'Corte', durationMinutes: 30, priceCents: 5000 })
        .expect(402);
      expect(res.body.error?.code ?? res.body.code).toBe('SUBSCRIPTION_PAST_DUE');
    });

    it('GET /admin/services em past_due retorna 200', async () => {
      const { accessToken, tenantId } = await registerAndLogin(`${slug}-2`);
      const prisma = app.get(PrismaService);
      await forcePastDue(prisma, tenantId, { currentPeriodEnd: null });

      const server = app.getHttpServer() as unknown as import('http').Server;
      await request(server)
        .get('/admin/services')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
    });

    it('GET /admin/billing/status retorna origin=trial', async () => {
      const { accessToken, tenantId } = await registerAndLogin(`${slug}-3`);
      const prisma = app.get(PrismaService);
      await forcePastDue(prisma, tenantId, { currentPeriodEnd: null });

      const server = app.getHttpServer() as unknown as import('http').Server;
      const res = await request(server)
        .get('/admin/billing/status')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(res.body.origin).toBe('trial');
      expect(res.body.status).toBe('past_due');
      expect(res.body.deadlineAt).toBeDefined();
    });

    it('GET /public/{slug} em past_due retorna 404', async () => {
      const { tenantId } = await registerAndLogin(`${slug}-4`);
      const prisma = app.get(PrismaService);
      await forcePastDue(prisma, tenantId, { currentPeriodEnd: null });

      const server = app.getHttpServer() as unknown as import('http').Server;
      await request(server).get(`/public/${slug}-4`).expect(404);
    });
  });

  describe('cenário payment-origin (currentPeriodEnd não-null)', () => {
    const slug = 'past-payment';

    it('POST /admin/services em past_due (origem pagamento) retorna 402 — mesma resposta de trial-origin', async () => {
      const { accessToken, tenantId } = await registerAndLogin(slug);
      const prisma = app.get(PrismaService);
      await forcePastDue(prisma, tenantId, {
        currentPeriodEnd: new Date('2026-05-10T12:00:00Z'),
      });

      const server = app.getHttpServer() as unknown as import('http').Server;
      const res = await request(server)
        .post('/admin/services')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'Corte', durationMinutes: 30, priceCents: 5000 })
        .expect(402);
      expect(res.body.error?.code ?? res.body.code).toBe('SUBSCRIPTION_PAST_DUE');
    });

    it('GET /admin/billing/status retorna origin=payment', async () => {
      const { accessToken, tenantId } = await registerAndLogin(`${slug}-2`);
      const prisma = app.get(PrismaService);
      await forcePastDue(prisma, tenantId, {
        currentPeriodEnd: new Date('2026-05-10T12:00:00Z'),
      });

      const server = app.getHttpServer() as unknown as import('http').Server;
      const res = await request(server)
        .get('/admin/billing/status')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(res.body.origin).toBe('payment');
      expect(res.body.hasCheckout).toBe(true);
    });

    it('POST /admin/billing/checkout em past_due (qualquer origem) retorna 200/201 (whitelist)', async () => {
      const { accessToken, tenantId } = await registerAndLogin(`${slug}-3`);
      const prisma = app.get(PrismaService);
      await prisma.tenant.update({
        where: { id: tenantId },
        data: { documentNumber: '12345678901' },
      });
      await forcePastDue(prisma, tenantId, {
        currentPeriodEnd: new Date('2026-05-10T12:00:00Z'),
      });

      const server = app.getHttpServer() as unknown as import('http').Server;
      const res = await request(server)
        .post('/admin/billing/checkout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({});
      expect([200, 201]).toContain(res.status);
      expect(res.body.initPoint).toBeDefined();
    });
  });

  describe('estados não-bloqueantes', () => {
    it('POST /admin/services em trialing retorna 201', async () => {
      const { accessToken } = await registerAndLogin('trial-write-ok');
      const server = app.getHttpServer() as unknown as import('http').Server;
      await request(server)
        .post('/admin/services')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'Corte trial', durationMinutes: 30, priceCents: 5000 })
        .expect(201);
    });
  });
});
```

> **Nota sobre o shape do body de erro:** o projeto usa `DomainException` mapeado por exception filter — confirmar com 1 teste local rodando que o body é `{ code, message }` ou `{ error: { code, message } }`. Os asserts acima cobrem ambos via `res.body.error?.code ?? res.body.code` pra ficar robusto.

> **Nota sobre `POST /admin/services` body:** se o DTO real exigir campos diferentes (ex.: `description`, `categoryId`), adaptar pelo arquivo `src/modules/services/dto/create-service.dto.ts`. O ponto do teste é o **status code 402**, não o sucesso da criação.

- [ ] **Step 3: Rodar e2e**

Run: `cd /home/ntconsult/Projetos/meus/kairobarber/kairobarber-api && pnpm test:e2e -- billing-past-due-gating billing-trial-check`
Expected: PASS — todos os testes (3 do trial-check + 7 do gating).

- [ ] **Step 4: Rodar e2e completo pra garantir não-regressão**

Run: `pnpm test:e2e`
Expected: todos verdes. Se algum spec de billing-cron-sync ou billing-admin-gating quebrar por mudança de janela, ajustar (geralmente é só trocar `7` por `1` em assertions).

- [ ] **Step 5: Commit**

```bash
git add test/e2e/billing-past-due-gating.e2e-spec.ts test/e2e/billing-trial-check.e2e-spec.ts
git commit -m "test(billing): e2e do gating em past_due cobrindo ambas as origens

- trial-origin (currentPeriodEnd null): POST 402, GET 200, status origin=trial, storefront 404
- payment-origin (currentPeriodEnd não-null): mesmo gating, status origin=payment, checkout libera (whitelist)
- trialing/active: escrita livre

Atualiza billing-trial-check pra refletir grace 1d (era 7d).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 9: Atualizar `CLAUDE.md` da API

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Corrigir frase desatualizada**

Em [CLAUDE.md](../../CLAUDE.md), seção "1. Sobre o projeto" → "Modelo de negócio". Localizar:

```
Plano único Mercado Pago, trial 14 dias. **Sem webhook MP** (decisão arquitetural): polling on-demand via `/admin/billing/sync` + cron de sync + cron diário pra trial. Gating: tenant `cancelled` ou `suspended` → storefront `/public/*` retorna 404 (não vaza), `/admin/*` (exceto `/admin/billing`) retorna 402.
```

Trocar por:

```
Plano único (Asaas primário, Mercado Pago legado/fallback). **Trial 3 dias** + **grace 1 dia em past_due**. **Sem webhook do gateway** (decisão arquitetural): polling on-demand via `/admin/billing/sync` + cron de sync 1x/hora + cron diário pra trial-check. Gating: tenant `cancelled` OU `past_due` OU `suspended` → storefront `/public/*` retorna 404 (não vaza). Em `past_due`, `/admin/*` libera leituras (GET) mas bloqueia escritas (POST/PUT/PATCH/DELETE) com 402; whitelist `/admin/billing/*` sempre libera. Em `cancelled`, `/admin/*` bloqueia tudo (exceto `/admin/billing`). Spec: [`docs/superpowers/specs/2026-05-20-trial-grace-tightening-design.md`](docs/superpowers/specs/2026-05-20-trial-grace-tightening-design.md).
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): atualiza modelo de negócio (trial 3d, grace 1d, past_due ativo)

CLAUDE.md estava desatualizada dizendo 'trial 14 dias' enquanto o env
default real era 3 (e agora é 3+1d grace). Aponta pro spec novo.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 10: Atualizar spec mestre do backend (referência cruzada)

**Files:**
- Modify: `docs/superpowers/specs/2026-05-11-kairobarber-backend-design.md`

- [ ] **Step 1: Adicionar bloco de referência**

Em [docs/superpowers/specs/2026-05-11-kairobarber-backend-design.md](../specs/2026-05-11-kairobarber-backend-design.md), localizar a primeira menção a "billing" ou "Mercado Pago" ou "trial". Adicionar **acima** dela um aviso visível:

```markdown
> **⚠️ Atualizado em 2026-05-20:** as decisões originais sobre trial de 14 dias e grace de 7 dias foram revisadas. Vigentes: trial **3 dias** + grace **1 dia** em past_due (bloqueante de escritas + storefront 404). Ver [spec dedicado](2026-05-20-trial-grace-tightening-design.md) — esse spec é load-bearing e tem prioridade sobre as menções a billing nesta página.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-05-11-kairobarber-backend-design.md
git commit -m "docs(spec): backend mestre aponta pro spec de billing tightening

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 11: Validação final (lint + test + build) e teste manual

**Files:** nenhum (validação)

- [ ] **Step 1: Lint**

Run: `cd /home/ntconsult/Projetos/meus/kairobarber/kairobarber-api && pnpm lint`
Expected: exit 0.

- [ ] **Step 2: Unit tests**

Run: `pnpm test`
Expected: todos verdes.

- [ ] **Step 3: E2E tests**

Run: `pnpm test:e2e`
Expected: todos verdes. Pode demorar (testcontainers boot ~2-3 min).

- [ ] **Step 4: Build**

Run: `pnpm build`
Expected: exit 0.

- [ ] **Step 5: Teste manual rápido (opcional, recomendado)**

Subir o stack local:

```bash
docker compose up -d postgres redis
pnpm start:dev
```

Em outro terminal, registrar um tenant e simular past_due:

```bash
# Registrar
curl -s -X POST http://localhost:3000/auth/register/owner \
  -H "Content-Type: application/json" \
  -d '{"email":"manual@test.com","password":"StrongPass!1","name":"Manual","tenantName":"Manual","slug":"manual"}' | jq

# Pegar accessToken da resposta acima e salvar em $TOK

# GET /status durante trial
curl -s -H "Authorization: Bearer $TOK" http://localhost:3000/admin/billing/status | jq
# Expected: { status: 'trialing', origin: 'trial', deadlineAt: <data>, msUntilDeadline: ~259200000, hasCheckout: false }

# Forçar past_due via psql
docker compose exec postgres psql -U kairobarber -d kairobarber \
  -c "UPDATE \"Subscription\" SET status='past_due' WHERE \"tenantId\"=(SELECT id FROM \"Tenant\" WHERE slug='manual');"

# Tentar POST → deve dar 402
curl -s -X POST -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"name":"Teste","durationMinutes":30,"priceCents":5000}' \
  http://localhost:3000/admin/services -w "\n%{http_code}\n"
# Expected: status 402, body com code SUBSCRIPTION_PAST_DUE

# GET ainda funciona
curl -s -H "Authorization: Bearer $TOK" http://localhost:3000/admin/services -w "\n%{http_code}\n"
# Expected: 200

# Storefront cai
curl -s http://localhost:3000/public/manual -w "\n%{http_code}\n"
# Expected: 404

# /admin/billing/status segue funcionando (whitelist)
curl -s -H "Authorization: Bearer $TOK" http://localhost:3000/admin/billing/status | jq
# Expected: origin: 'trial', deadlineAt: <updatedAt + 1d>
```

Se todos os 5 manual checks passarem, B1 está completa.

- [ ] **Step 6: Atualizar README se citar billing (opcional)**

Olhar `README.md` da api: se mencionar "trial 14 dias" ou janela antiga, atualizar pra refletir 3+1. Se não citar, pular.

- [ ] **Step 7: Commit final / push opcional**

Não há mais commits a fazer (tudo já foi commitado por task). Verificar:

```bash
git log --oneline -10
```

Expected: ver 9-10 commits desta fase (B1) em sequência. O user decide se faz `git push origin main` (não fazer sem confirmação dele).

---

## Spec Coverage Self-Review

| Requirement do spec | Coberto por |
|---|---|
| R-B1-01 (env default 7→1) | Task 1 |
| R-B1-02 (.env.example + sync cron) | Task 1 |
| R-B1-03 (guard: whitelist + write block) | Task 3 |
| R-B1-04 (SUBSCRIPTION_PAST_DUE) | Task 2 |
| R-B1-05 (middleware: past_due → 404) | Task 4 |
| R-B1-06 (GET /admin/billing/status) | Tasks 5, 6, 7 |
| R-B1-07 (testes unit + e2e) | Tasks 3, 4, 6, 8 |
| R-B1-08 (CLAUDE.md atualizada) | Task 9 |
| R-B1-09 (spec mestre backend atualizado) | Task 10 |
| INV-11 (cron 1x/hora) | Task 1 |

Sem placeholders. Sem TBD. Todos os arquivos têm path absoluto ou link clicável. Comandos pnpm exatos. Code blocks completos.

---

## Acceptance verificável (do spec, checagem final)

Quando todas as tasks acima passarem, estas afirmações devem ser verdade:

- ✅ `BILLING_PAST_DUE_GRACE_DAYS` default = 1
- ✅ `BILLING_SYNC_CRON` default = `'0 * * * *'`
- ✅ Trial-origin past_due + POST → 402 `SUBSCRIPTION_PAST_DUE`
- ✅ Payment-origin past_due + POST → 402 `SUBSCRIPTION_PAST_DUE` (mesma resposta)
- ✅ past_due (qualquer origem) + GET → 200
- ✅ past_due (qualquer origem) + POST /admin/billing/checkout → 200/201
- ✅ past_due (qualquer origem) + GET /public/{slug} → 404
- ✅ `GET /admin/billing/status` retorna `origin: 'trial' | 'payment' | null` corretamente
- ✅ Cron trial-check com grace=1d move past_due → cancelled em 24h
- ✅ Reativação cancelled → checkout → active continua passando
- ✅ CLAUDE.md atualizada
- ✅ Spec mestre backend referencia spec novo
- ✅ `pnpm test`, `pnpm test:e2e`, `pnpm lint`, `pnpm build` verdes

---

## Próxima fase

Após B1 estar em `main` e deployada (Railway → CI verde → auto deploy), abrir nova sessão pra plano da **Fase W1 (Web)**:
- `superpowers:writing-plans` com base no mesmo spec `2026-05-20-trial-grace-tightening-design.md`, seção §8 (Fase W1).
- Entrega: `<BillingBanner>` global no shell `/admin` + `<PastDuePaywallModal>` capturando 402 + `useBillingStatus()` hook consumindo o endpoint novo.
