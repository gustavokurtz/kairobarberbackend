# KairoBarber — Fase 5 (Dashboard do dono do SaaS) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir o módulo `saas-admin` com endpoints `/saas/*` (dashboard com MRR/ARR/churn/conversão, listagem e detalhe de tenants, suspend/unsuspend, snapshot de uso de IA, listagem de usuários e audit-log), introduzir a tabela `AuditLog` (append-only) já registrando transições de subscription da Fase 4 + ações de suspensão da Fase 5, adicionar `Tenant.suspendedAt` para gating administrativo (separado de billing) e seed idempotente para criar o `saas_owner`.

**Architecture:** Continua monolito modular NestJS. Módulo novo `saas-admin` (em `src/modules/saas-admin/`) com controller único `/saas`, protegido por `JwtAuthGuard` (já global) + `RolesGuard` restrito a `UserRole.saas_owner`. Como `saas_owner` não tem `tenantId` no JWT, o `SubscriptionActiveGuard` global o ignora naturalmente; e como nenhum endpoint `/saas/*` é tenant-scoped, os services usam `this.prisma` direto (não `prisma.scoped`) para consultar through-tenant. Audit log fica em `src/common/audit/` como módulo global, exportando `AuditService.record()`; o `BillingService` passa a chamar `audit.record()` em cada transição (`trial_started`, `checkout_created`, `trial_expired`, `grace_period_expired`, `activated`, `past_due`, `cancelled`). `Tenant.suspendedAt` é uma decisão administrativa do SaaS, independente do billing: o `PublicTenantMiddleware` retorna 404 quando suspenso (igual a `cancelled`), e o `SubscriptionActiveGuard` passa a bloquear `/admin/*` com 402 `TENANT_SUSPENDED` exceto endpoints com `@AllowInactiveSubscription()` (mesmo bypass do `cancelled`). Métricas (MRR/ARR/active/churn/conversão) saem de queries Postgres simples sobre `Subscription` + `AuditLog`, sem agregação materializada (volume MVP é centenas de tenants — `count(*) WHERE status='active'` é instantâneo). Sem novas filas, sem novos crons, sem novo provider externo.

**Tech Stack:** Sem dependências novas. Reaproveita Prisma, class-validator, Nest, Jest, supertest, testcontainers Postgres. `prisma db seed` chama `prisma/seed.ts` (novo), via config `prisma.seed` no `package.json`.

**Spec de referência:** [`docs/superpowers/specs/2026-05-11-kairobarber-backend-design.md`](../specs/2026-05-11-kairobarber-backend-design.md) (seção 4 — Fase 5; seção 6 — `AuditLog`; seção 7 — endpoints `/saas/*`; seção 12 — segurança/LGPD).

**Plano anterior:** [`2026-05-12-kairobarber-fase-4-billing.md`](./2026-05-12-kairobarber-fase-4-billing.md).

---

## Estado atual do repositório (entrada da Fase 5)

- Schema Prisma (`prisma/schema.prisma`) tem todas as entidades das Fases 0-4 (`User`, `Tenant`, `Subscription`, `Barber`, `Service`, `Photo`, `Customer`, `Appointment` etc.). Falta `AuditLog` e o campo `Tenant.suspendedAt`. Última migration: `20260512034724_phase3_storefront_scheduling` (a Fase 4 não criou migration — só adicionou comportamento). `Subscription` já tem `aiQuotaUsedThisMonth` (Int, default 0) que será exposto pelo `/saas/ai-usage`.
- `UserRole` enum já tem `saas_owner`. Nenhum fluxo cria `User` com esse role — vamos adicionar via `prisma/seed.ts` (idempotente, bloqueado em produção pelo schema do env).
- `src/app.module.ts:48-52` registra `SubscriptionActiveGuard` como `APP_GUARD`. Vamos estender a lógica desse guard para também rejeitar `tenant.suspendedAt != null`, **sem** introduzir guard novo (o bypass `@AllowInactiveSubscription()` continua valendo para os mesmos endpoints).
- `src/common/middleware/public-tenant.middleware.ts:32-39` retorna 404 quando subscription `cancelled`. Vamos adicionar checagem de `tenant.suspendedAt`.
- `src/modules/billing/billing.service.ts` já loga transições via `this.logger.log({event: 'subscription.X'})`. Vamos plugar `AuditService.record()` nos mesmos pontos (mantendo o log; AuditLog é persistente).
- Não existe `src/common/audit/` ainda. A spec (seção 5 — estrutura de pastas) o lista, então é onde o módulo de audit fica.
- `prisma/seed.ts` não existe. `package.json` não tem `prisma.seed` config. Vamos criar.
- E2E suite em `test/e2e/` já tem 12 specs verdes. Helpers em `test/support/{postgres-container,test-app,test-env,billing,time}.ts`. Vamos adicionar `test/support/saas.ts` com helpers para criar `saas_owner` e popular tenants/audit-log.
- `src/common/exceptions/error-codes.ts` já tem códigos das Fases 1-4. Vamos adicionar os da Fase 5 (`TENANT_SUSPENDED`, `TENANT_NOT_FOUND_SAAS`, `SAAS_ACTION_FORBIDDEN` etc.).
- `src/common/decorators/roles.decorator.ts` + `src/common/guards/roles.guard.ts` já funcionam — usaremos `@Roles(UserRole.saas_owner)`.

---

## Decisões importantes desta fase (registrar antes de codar)

1. **`Tenant.suspendedAt` é decisão administrativa do SaaS, separada de billing.** Suspender ≠ cancelar assinatura. Quando o dono do SaaS suspende, o tenant fica inacessível tanto na storefront (404) quanto no admin (402 `TENANT_SUSPENDED`, com bypass via `@AllowInactiveSubscription()` para que o owner ainda veja `GET /admin/billing/subscription` e o motivo, mas não opere). Unsuspend é reversível imediatamente — não cancela assinatura, não interfere em `mpPreapprovalId`. Auditado.

2. **`AuditLog` é append-only e *hard* storage.** Sem `deletedAt`. Schema:
   ```
   AuditLog(id, tenantId?, actorUserId?, action, targetType, targetId?, diff Json?, ip?, userAgent?, createdAt)
   ```
   Indexes: `(tenantId, createdAt DESC)`, `(action, createdAt DESC)`, `(actorUserId, createdAt DESC)`. **Ações registradas nesta fase (constantes em `src/common/audit/audit-actions.ts`):**
   - `subscription.trial_started` (já existia como log; agora também persiste)
   - `subscription.checkout_created`
   - `subscription.activated`
   - `subscription.past_due`
   - `subscription.cancelled` (incluindo via cancel manual do owner ou via cron de grace)
   - `subscription.trial_expired` (subset de `past_due` para conversion math)
   - `tenant.suspended` / `tenant.unsuspended`
   
   Não vamos retrofitar a Fase 3 (`customer.identity_updated`) — fica como TODO da Fase 6+ se quiser cobertura. O `audit-log` endpoint mostra o que estiver lá.

3. **Métricas do dashboard são calculadas on-demand (sem cache).** Volume MVP é centenas de tenants — uma query `count(*) WHERE status='active'` rodando em < 5ms é aceitável. Sem materialized view, sem agregação por job. Quando passar de ~10k tenants reavaliamos.
   - **MRR** = `count(Subscription where status='active')` × `BILLING_MRR_CENTS` (env nova, default 4990).
   - **ARR** = `MRR * 12`.
   - **Tenants ativos** = `count(Subscription where status in ['trialing','active'])`.
   - **Churn 30d** = `cancelledIn30d / activeAt30dAgo`, derivado do `AuditLog`: numerador = `count(AuditLog where action='subscription.cancelled' AND createdAt > now-30d)`; denominador = `count(Subscription where status='active') + cancelledIn30d`. Se denominador = 0 → retorna 0 (não NaN).
   - **Conversão trial→paid 30d** = `activatedIn30d / trialsStartedIn60d` (janela de trial de 14d + folga). Ambos do `AuditLog`. Se denominador = 0 → 0.

4. **`/saas/ai-usage` é snapshot do mês corrente.** Retorna `[{tenantId, tenantSlug, tenantName, aiQuotaUsedThisMonth}]` ordenado por uso desc. DTO **não** aceita `from`/`to` (documentado no resumo da resposta: `windowMonth: 'YYYY-MM'`). Breakdown rico (por dia/consulta) entra na Fase 6 quando existir tabela `AiConsultation`. Endpoint suporta `?page=1&pageSize=20`.

5. **Bootstrap do `saas_owner` via `prisma/seed.ts`.** Lê `SAAS_OWNER_EMAIL`, `SAAS_OWNER_PASSWORD`, `SAAS_OWNER_NAME` do env. Faz `upsert` por email. **Bloqueia em prod** com `if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PROD_SEED !== 'true') throw`. Operador roda `npx prisma db seed` manualmente após deploy quando precisar criar/rotacionar o owner. Sem endpoint HTTP de bootstrap (YAGNI: rotação de senha do owner manda usar `/auth/forgot-password` depois que o owner existe).

6. **Listagem `/saas/tenants`** tem 3 filtros: `status` (subscription status: `trialing|active|past_due|cancelled|all`), `suspended` (`true|false|all`), `search` (substring em `slug` ou `name`, case-insensitive). Paginação `page` + `pageSize` (default 20, max 100). Order by `createdAt DESC`.

7. **Detalhe `/saas/tenants/:id`** retorna: tenant (id, slug, name, suspendedAt, createdAt, owner.email) + subscription (status, trialEndsAt, currentPeriodEnd, mpPreapprovalId, aiQuotaUsedThisMonth) + counters (`barbersCount`, `servicesCount`, `customersCount`, `appointmentsTotalCount`, `appointmentsLast30dCount`). Pequena query agregada, executada em paralelo (`Promise.all`).

8. **Endpoint `GET /saas/users`** lista todos os Users com filtros `role`, `search` (email/name). Paginado. Returna `[{id, email, name, role, emailVerifiedAt, createdAt}]`. Não exibe `passwordHash`.

9. **Endpoint `GET /saas/audit-log`** lista com filtros `tenantId`, `actorUserId`, `action` (exact match em uma string), `from`, `to` (ISO). Paginado. Order by `createdAt DESC`.

10. **Permissão consistente em todo `/saas/*`**: `@Roles(UserRole.saas_owner)` aplicado no controller via `@UseGuards(RolesGuard)`. Como o `RolesGuard` confia em `req.user.role`, e o `JwtAuthGuard` global popula `req.user`, qualquer JWT com role diferente recebe 403 `FORBIDDEN`. **Não usar `TenantGuard`** porque saas_owner não tem `tenantId`.

11. **`AuditService.record()` é fire-and-forget? Não — é síncrono mas tolerante a falha.** A escrita do log roda no mesmo banco. Se falhar (raríssimo), loga `warn` e segue: nunca propaga exception (audit não pode quebrar a operação de negócio). Não tem transação compartilhada com a operação principal (poderia, mas adiciona complexidade — toleramos a janela de 1ms entre o commit do billing e o write do audit).

12. **Order de execução em `BillingService` em transições**: 1) update do banco, 2) log estruturado, 3) `AuditService.record()`. Garante que se o audit falhar não desfaz a transição.

---

## Estrutura de arquivos resultante (delta da Fase 5)

```
kairobarber/
├── package.json                                             # ATUALIZA: prisma.seed config
│
├── prisma/
│   ├── schema.prisma                                        # ATUALIZA: +AuditLog, +Tenant.suspendedAt
│   ├── seed.ts                                              # NOVO: cria saas_owner idempotente
│   └── migrations/
│       └── <ts>_phase5_saas_admin_and_audit/                # NOVO
│           └── migration.sql
│
├── src/
│   ├── config/
│   │   └── env.validation.ts                                # ATUALIZA: +BILLING_MRR_CENTS, +SAAS_OWNER_* (opcionais)
│   │
│   ├── common/
│   │   ├── exceptions/
│   │   │   └── error-codes.ts                               # ATUALIZA: TENANT_SUSPENDED, TENANT_ALREADY_SUSPENDED, TENANT_NOT_SUSPENDED, SAAS_TENANT_NOT_FOUND
│   │   ├── middleware/
│   │   │   └── public-tenant.middleware.ts                  # ATUALIZA: 404 quando suspendedAt != null
│   │   ├── guards/
│   │   │   └── subscription-active.guard.ts                 # ATUALIZA: 402 TENANT_SUSPENDED quando suspendedAt != null
│   │   └── audit/                                           # NOVO
│   │       ├── audit.module.ts
│   │       ├── audit.service.ts
│   │       ├── audit.service.spec.ts
│   │       ├── audit.repository.ts
│   │       ├── audit-actions.ts
│   │       └── audit.types.ts
│   │
│   ├── modules/
│   │   ├── billing/
│   │   │   ├── billing.module.ts                            # ATUALIZA: importa AuditModule
│   │   │   ├── billing.service.ts                           # ATUALIZA: chama AuditService.record() em todas transições
│   │   │   └── billing.service.spec.ts                      # ATUALIZA: cobre chamadas de audit
│   │   │
│   │   └── saas-admin/                                      # NOVO MÓDULO
│   │       ├── saas-admin.module.ts
│   │       ├── saas-admin.controller.ts
│   │       ├── dto/
│   │       │   ├── list-tenants-query.dto.ts
│   │       │   ├── list-users-query.dto.ts
│   │       │   ├── list-audit-log-query.dto.ts
│   │       │   ├── list-ai-usage-query.dto.ts
│   │       │   └── pagination.dto.ts
│   │       ├── services/
│   │       │   ├── saas-metrics.service.ts
│   │       │   ├── saas-metrics.service.spec.ts
│   │       │   ├── saas-tenants.service.ts
│   │       │   ├── saas-tenants.service.spec.ts
│   │       │   ├── saas-users.service.ts
│   │       │   ├── saas-audit.service.ts
│   │       │   └── saas-ai-usage.service.ts
│   │       └── repositories/
│   │           ├── saas-tenant.repository.ts
│   │           ├── saas-user.repository.ts
│   │           └── saas-subscription.repository.ts
│   │
│   └── app.module.ts                                        # ATUALIZA: registra AuditModule (global), SaasAdminModule
│
└── test/
    ├── e2e/
    │   ├── saas-admin-authz.e2e-spec.ts                     # NOVO: só saas_owner acessa /saas/*
    │   ├── saas-admin-tenants.e2e-spec.ts                   # NOVO: list + detail + filtros
    │   ├── saas-admin-suspend.e2e-spec.ts                   # NOVO: suspend bloqueia storefront + admin; unsuspend libera
    │   ├── saas-admin-dashboard.e2e-spec.ts                 # NOVO: métricas calculadas com fixtures
    │   ├── saas-admin-audit-log.e2e-spec.ts                 # NOVO: lista com filtros
    │   ├── saas-admin-users.e2e-spec.ts                     # NOVO: lista users com role/search
    │   └── saas-admin-ai-usage.e2e-spec.ts                  # NOVO: snapshot do mês ordenado
    └── support/
        └── saas.ts                                          # NOVO: createSaasOwner, getSaasToken, seedTenantsWithStatus
```

---

## Tasks

### Task 1: Schema Prisma — adicionar `AuditLog` + `Tenant.suspendedAt`

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_phase5_saas_admin_and_audit/migration.sql` (gerado)

- [ ] **Step 1: Adicionar enum `AuditAction` opcional? Não — manter `action` como `String`.**

Decisão: `action` é livre como `String` (formato `dominio.evento`). Validação fica em `audit-actions.ts` em runtime. Razão: enum no banco força migration toda vez que aparece nova action.

- [ ] **Step 2: Editar `prisma/schema.prisma` — adicionar campo em `Tenant`**

No bloco `model Tenant`, depois de `deletedAt DateTime?`, adicionar:

```prisma
  suspendedAt DateTime?
```

E adicionar `auditLogs AuditLog[]` na seção de relações (depois de `appointments Appointment[]`):

```prisma
  auditLogs         AuditLog[]
```

- [ ] **Step 3: Editar `prisma/schema.prisma` — adicionar relação em `User`**

No bloco `model User`, depois de `customerProfile Customer?`, adicionar:

```prisma
  auditLogs       AuditLog[]
```

- [ ] **Step 4: Editar `prisma/schema.prisma` — adicionar bloco `model AuditLog` no final do arquivo**

```prisma
model AuditLog {
  id            String   @id @default(cuid())
  tenantId      String?
  actorUserId   String?
  action        String
  targetType    String?
  targetId      String?
  diff          Json?
  ip            String?
  userAgent     String?
  createdAt     DateTime @default(now())

  tenant Tenant? @relation(fields: [tenantId], references: [id], onDelete: SetNull)
  actor  User?   @relation(fields: [actorUserId], references: [id], onDelete: SetNull)

  @@index([tenantId, createdAt(sort: Desc)])
  @@index([action, createdAt(sort: Desc)])
  @@index([actorUserId, createdAt(sort: Desc)])
}
```

- [ ] **Step 5: Gerar migration**

```bash
cd /home/ntconsult/Projetos/meus/kairobarber
docker compose up -d postgres
npx prisma migrate dev --name phase5_saas_admin_and_audit
```

Expected: migration aplicada, `npx prisma generate` rodou automaticamente, tipos `AuditLog` aparecem em `@prisma/client`.

- [ ] **Step 6: Verificar tipos gerados**

```bash
npx tsc --noEmit
```

Expected: zero erros (o resto do código não usa `AuditLog` ainda, então só validamos que o schema compila).

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(phase5): add AuditLog model and Tenant.suspendedAt"
```

---

### Task 2: Módulo `common/audit` — service, repository, constants

**Files:**
- Create: `src/common/audit/audit-actions.ts`
- Create: `src/common/audit/audit.types.ts`
- Create: `src/common/audit/audit.repository.ts`
- Create: `src/common/audit/audit.service.ts`
- Create: `src/common/audit/audit.service.spec.ts`
- Create: `src/common/audit/audit.module.ts`

- [ ] **Step 1: Criar `src/common/audit/audit-actions.ts`**

```ts
export const AuditActions = {
  SUBSCRIPTION_TRIAL_STARTED: 'subscription.trial_started',
  SUBSCRIPTION_CHECKOUT_CREATED: 'subscription.checkout_created',
  SUBSCRIPTION_ACTIVATED: 'subscription.activated',
  SUBSCRIPTION_PAST_DUE: 'subscription.past_due',
  SUBSCRIPTION_CANCELLED: 'subscription.cancelled',
  SUBSCRIPTION_TRIAL_EXPIRED: 'subscription.trial_expired',
  TENANT_SUSPENDED: 'tenant.suspended',
  TENANT_UNSUSPENDED: 'tenant.unsuspended',
} as const;

export type AuditAction = (typeof AuditActions)[keyof typeof AuditActions];
```

- [ ] **Step 2: Criar `src/common/audit/audit.types.ts`**

```ts
import { AuditAction } from './audit-actions';

export interface AuditRecordInput {
  action: AuditAction | string;
  tenantId?: string | null;
  actorUserId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  diff?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditQuery {
  tenantId?: string;
  actorUserId?: string;
  action?: string;
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
}
```

- [ ] **Step 3: Criar `src/common/audit/audit.repository.ts`**

```ts
import { Injectable } from '@nestjs/common';
import { AuditLog, Prisma } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AuditQuery, AuditRecordInput } from './audit.types';

@Injectable()
export class AuditRepository {
  constructor(private readonly prisma: PrismaService) {}

  insert(input: AuditRecordInput): Promise<AuditLog> {
    return this.prisma.auditLog.create({
      data: {
        action: input.action,
        tenantId: input.tenantId ?? null,
        actorUserId: input.actorUserId ?? null,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        diff: (input.diff ?? null) as Prisma.InputJsonValue | undefined,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
  }

  async listPaginated(
    q: AuditQuery,
  ): Promise<{ rows: AuditLog[]; total: number; page: number; pageSize: number }> {
    const where: Prisma.AuditLogWhereInput = {
      tenantId: q.tenantId,
      actorUserId: q.actorUserId,
      action: q.action,
      createdAt:
        q.from || q.to
          ? {
              gte: q.from,
              lte: q.to,
            }
          : undefined,
    };
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { rows, total, page: q.page, pageSize: q.pageSize };
  }
}
```

- [ ] **Step 4: Criar `src/common/audit/audit.service.ts`**

```ts
import { Injectable, Logger } from '@nestjs/common';
import { AuditRepository } from './audit.repository';
import { AuditRecordInput } from './audit.types';

@Injectable()
export class AuditService {
  constructor(
    private readonly repo: AuditRepository,
    private readonly logger: Logger,
  ) {}

  async record(input: AuditRecordInput): Promise<void> {
    try {
      await this.repo.insert(input);
    } catch (err) {
      this.logger.warn({
        event: 'audit.record_failed',
        action: input.action,
        tenantId: input.tenantId,
        error: (err as Error).message,
      });
      // engole — audit nunca quebra fluxo de negócio
    }
  }
}
```

- [ ] **Step 5: Escrever `src/common/audit/audit.service.spec.ts` (test first style — confirma comportamento de tolerância a falha)**

```ts
import { Logger } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditRepository } from './audit.repository';
import { AuditActions } from './audit-actions';

describe('AuditService', () => {
  let repo: jest.Mocked<Pick<AuditRepository, 'insert'>>;
  let logger: jest.Mocked<Pick<Logger, 'warn'>>;
  let service: AuditService;

  beforeEach(() => {
    repo = { insert: jest.fn() };
    logger = { warn: jest.fn() };
    service = new AuditService(repo as unknown as AuditRepository, logger as unknown as Logger);
  });

  it('insere o log e retorna sem erro no caminho feliz', async () => {
    repo.insert.mockResolvedValueOnce({} as never);
    await service.record({
      action: AuditActions.SUBSCRIPTION_ACTIVATED,
      tenantId: 't1',
    });
    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'subscription.activated',
        tenantId: 't1',
      }),
    );
  });

  it('engole exception do repository e loga warn (audit não quebra negócio)', async () => {
    repo.insert.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.record({ action: AuditActions.TENANT_SUSPENDED, tenantId: 't1' }),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'audit.record_failed', action: 'tenant.suspended' }),
    );
  });
});
```

- [ ] **Step 6: Criar `src/common/audit/audit.module.ts`**

```ts
import { Global, Logger, Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { AuditRepository } from './audit.repository';
import { AuditService } from './audit.service';

@Global()
@Module({
  imports: [PrismaModule],
  providers: [AuditService, AuditRepository, Logger],
  exports: [AuditService],
})
export class AuditModule {}
```

- [ ] **Step 7: Registrar `AuditModule` em `src/app.module.ts` (depois de `PrismaModule`)**

Em `src/app.module.ts`, no array `imports`, adicionar `AuditModule` após `PrismaModule`:

```ts
import { AuditModule } from './common/audit/audit.module';

// ... no array imports:
    PrismaModule,
    AuditModule,
    RedisModule,
```

- [ ] **Step 8: Rodar testes unitários**

```bash
npx jest --config jest.config.ts src/common/audit/audit.service.spec.ts
```

Expected: 2 tests passed.

- [ ] **Step 9: Commit**

```bash
git add src/common/audit/ src/app.module.ts
git commit -m "feat(audit): add AuditModule with record() service"
```

---

### Task 3: Plugar `AuditService.record()` nas transições do `BillingService`

**Files:**
- Modify: `src/modules/billing/billing.service.ts`
- Modify: `src/modules/billing/billing.module.ts`
- Modify: `src/modules/billing/billing.service.spec.ts`

- [ ] **Step 1: Injetar `AuditService` no `BillingService`**

Em `src/modules/billing/billing.service.ts`, no topo do arquivo adicionar imports:

```ts
import { AuditService } from 'src/common/audit/audit.service';
import { AuditActions } from 'src/common/audit/audit-actions';
```

No constructor, adicionar `private readonly audit: AuditService` como último parâmetro:

```ts
  constructor(
    private readonly repo: SubscriptionRepository,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    private readonly config: ConfigService,
    private readonly logger: Logger,
    private readonly audit: AuditService,
  ) {}
```

- [ ] **Step 2: Chamar `audit.record()` em `startTrial`**

Depois do `return this.repo.create(...)` (no método `startTrial`), refatorar para capturar o resultado e gravar audit antes de retornar:

```ts
  async startTrial(input: {
    tenantId: string;
    tx?: Prisma.TransactionClient;
  }): Promise<Subscription> {
    const trialDays = this.config.get<number>('BILLING_TRIAL_DAYS') ?? 14;
    const trialEndsAt = new Date(this.now().getTime() + trialDays * 24 * 60 * 60 * 1000);
    const sub = await this.repo.create({
      tenantId: input.tenantId,
      status: SubscriptionStatus.trialing,
      trialEndsAt,
      tx: input.tx,
    });
    await this.audit.record({
      action: AuditActions.SUBSCRIPTION_TRIAL_STARTED,
      tenantId: input.tenantId,
      targetType: 'subscription',
      targetId: sub.id,
      diff: { trialEndsAt: trialEndsAt.toISOString() },
    });
    return sub;
  }
```

- [ ] **Step 3: Chamar `audit.record()` em `createCheckout`**

No final do método `createCheckout`, **antes do return**, adicionar:

```ts
    await this.audit.record({
      action: AuditActions.SUBSCRIPTION_CHECKOUT_CREATED,
      tenantId: input.tenantId,
      targetType: 'subscription',
      targetId: sub.id,
      diff: { mpPreapprovalId: created.preapprovalId },
    });
```

- [ ] **Step 4: Chamar `audit.record()` em `applyRemoteState` (transições)**

No bloco `if (mappedStatus !== local.status)` (depois do `this.logger.log({...})`), adicionar:

```ts
      const action =
        mappedStatus === SubscriptionStatus.active
          ? AuditActions.SUBSCRIPTION_ACTIVATED
          : mappedStatus === SubscriptionStatus.past_due
            ? AuditActions.SUBSCRIPTION_PAST_DUE
            : mappedStatus === SubscriptionStatus.cancelled
              ? AuditActions.SUBSCRIPTION_CANCELLED
              : null;
      if (action) {
        await this.audit.record({
          action,
          tenantId: local.tenantId,
          targetType: 'subscription',
          targetId: local.id,
          diff: { fromStatus: local.status, toStatus: mappedStatus },
        });
      }
```

- [ ] **Step 5: Chamar `audit.record()` em `cancelSubscription`**

Depois do `this.logger.log({event: 'subscription.cancelled', ...})`:

```ts
    await this.audit.record({
      action: AuditActions.SUBSCRIPTION_CANCELLED,
      tenantId,
      targetType: 'subscription',
      targetId: sub.id,
      diff: { fromStatus: sub.status, toStatus: 'cancelled', reason: 'owner_cancelled' },
    });
```

- [ ] **Step 6: Chamar `audit.record()` em `runTrialCheck`**

Dentro do loop `for (const sub of trialEnded)`, depois do `this.logger.log({event: 'subscription.trial_expired', ...})`:

```ts
      await this.audit.record({
        action: AuditActions.SUBSCRIPTION_TRIAL_EXPIRED,
        tenantId: sub.tenantId,
        targetType: 'subscription',
        targetId: sub.id,
        diff: { fromStatus: 'trialing', toStatus: 'past_due' },
      });
      await this.audit.record({
        action: AuditActions.SUBSCRIPTION_PAST_DUE,
        tenantId: sub.tenantId,
        targetType: 'subscription',
        targetId: sub.id,
        diff: { fromStatus: 'trialing', toStatus: 'past_due', reason: 'trial_expired' },
      });
```

E dentro do loop `for (const sub of overGrace)`, depois da chamada de `repo.update({status: cancelled, ...})`:

```ts
      await this.audit.record({
        action: AuditActions.SUBSCRIPTION_CANCELLED,
        tenantId: sub.tenantId,
        targetType: 'subscription',
        targetId: sub.id,
        diff: { fromStatus: 'past_due', toStatus: 'cancelled', reason: 'grace_period_expired' },
      });
```

- [ ] **Step 7: Atualizar `src/modules/billing/billing.module.ts` — não precisa importar AuditModule (é Global), mas precisa estar disponível**

Confirme apenas que `AuditModule` está registrado no `AppModule`. Nada a mudar no `billing.module.ts`.

- [ ] **Step 8: Atualizar `src/modules/billing/billing.service.spec.ts`**

Onde o `BillingService` é instanciado no test, adicionar mock de `AuditService` como último argumento. Buscar `new BillingService(`:

```ts
import { AuditService } from 'src/common/audit/audit.service';

// ...
    const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    const service = new BillingService(repo, provider, config, logger, audit);
```

Adicionar **um teste novo** ao describe principal:

```ts
  it('grava audit log em startTrial', async () => {
    repo.create.mockResolvedValueOnce({ id: 's1' } as never);
    await service.startTrial({ tenantId: 't1' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'subscription.trial_started',
        tenantId: 't1',
        targetId: 's1',
      }),
    );
  });
```

- [ ] **Step 9: Rodar testes do billing**

```bash
npx jest --config jest.config.ts src/modules/billing/
```

Expected: todos os testes passam (incluindo o novo).

- [ ] **Step 10: Commit**

```bash
git add src/modules/billing/billing.service.ts src/modules/billing/billing.service.spec.ts
git commit -m "feat(billing): record subscription transitions to AuditLog"
```

---

### Task 4: Gating de suspensão — `Tenant.suspendedAt` no middleware e no guard

**Files:**
- Modify: `src/common/middleware/public-tenant.middleware.ts`
- Modify: `src/common/middleware/public-tenant.middleware.spec.ts`
- Modify: `src/common/guards/subscription-active.guard.ts`
- Modify: `src/common/guards/subscription-active.guard.spec.ts`
- Modify: `src/common/exceptions/error-codes.ts`

- [ ] **Step 1: Adicionar códigos de erro**

Em `src/common/exceptions/error-codes.ts`, adicionar na seção "Phase 5":

```ts
  // Phase 5 — SaaS admin
  TENANT_SUSPENDED: 'TENANT_SUSPENDED',
  TENANT_ALREADY_SUSPENDED: 'TENANT_ALREADY_SUSPENDED',
  TENANT_NOT_SUSPENDED: 'TENANT_NOT_SUSPENDED',
  SAAS_TENANT_NOT_FOUND: 'SAAS_TENANT_NOT_FOUND',
```

- [ ] **Step 2: Atualizar `PublicTenantMiddleware` para bloquear suspended**

Em `src/common/middleware/public-tenant.middleware.ts`, depois do bloco `if (tenant.subscription && tenant.subscription.status === 'cancelled')`, adicionar:

```ts
    if (tenant.suspendedAt) {
      return next(
        new DomainException({
          code: ErrorCodes.TENANT_NOT_FOUND,
          message: 'Barbearia não encontrada.',
          status: HttpStatus.NOT_FOUND,
        }),
      );
    }
```

(Storefront retorna 404 sem expor que está suspended — preserva UX consistente com o gating de `cancelled`.)

- [ ] **Step 3: Adicionar teste em `public-tenant.middleware.spec.ts`**

Buscar o describe principal e adicionar:

```ts
  it('retorna 404 quando tenant está suspended (suspendedAt != null)', async () => {
    prisma.tenant.findFirst = jest.fn().mockResolvedValue({
      id: 't1',
      slug: 'mybarber',
      deletedAt: null,
      suspendedAt: new Date(),
      subscription: { status: 'active' },
    });
    const req = { params: { slug: 'mybarber' }, url: '/public/mybarber/services' } as never;
    const next = jest.fn();
    await middleware.use(req, {} as never, next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'TENANT_NOT_FOUND', status: 404 }),
    );
  });
```

- [ ] **Step 4: Atualizar `SubscriptionActiveGuard` para também bloquear quando suspended**

Em `src/common/guards/subscription-active.guard.ts`, após injetar `SubscriptionRepository`, precisamos do `PrismaService` direto para ler `Tenant.suspendedAt`:

Adicionar no topo:
```ts
import { PrismaService } from 'src/infra/prisma/prisma.service';
```

No constructor adicionar `private readonly prisma: PrismaService`:

```ts
  constructor(
    private readonly reflector: Reflector,
    private readonly subscriptions: SubscriptionRepository,
    private readonly tokens: TokensService,
    private readonly prisma: PrismaService,
  ) {}
```

Depois do bloco do `allowInactive` (que faz early return `return true`), antes da query de subscription, adicionar:

```ts
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
```

- [ ] **Step 5: Atualizar `subscription-active.guard.spec.ts`**

Onde o guard é instanciado, adicionar o quarto argumento `prisma`:

```ts
const prisma = { tenant: { findUnique: jest.fn().mockResolvedValue({ suspendedAt: null }) } } as unknown as PrismaService;
const guard = new SubscriptionActiveGuard(reflector, subs, tokens, prisma);
```

Adicionar teste novo:

```ts
  it('lança TENANT_SUSPENDED quando suspendedAt != null', async () => {
    (prisma.tenant.findUnique as jest.Mock).mockResolvedValueOnce({ suspendedAt: new Date() });
    await expect(guard.canActivate(makeCtx('Bearer valid', 't1', false))).rejects.toMatchObject({
      code: 'TENANT_SUSPENDED',
    });
  });
```

(Adapte o helper `makeCtx` conforme o existente no spec — leia o arquivo antes de editar.)

- [ ] **Step 6: Rodar testes**

```bash
npx jest --config jest.config.ts src/common/middleware/public-tenant.middleware.spec.ts src/common/guards/subscription-active.guard.spec.ts
```

Expected: todos passam.

- [ ] **Step 7: Commit**

```bash
git add src/common/middleware/public-tenant.middleware.ts src/common/middleware/public-tenant.middleware.spec.ts src/common/guards/subscription-active.guard.ts src/common/guards/subscription-active.guard.spec.ts src/common/exceptions/error-codes.ts
git commit -m "feat(saas): block public storefront and admin when tenant.suspendedAt set"
```

---

### Task 5: Esqueleto `saas-admin` — module + controller + authz guard

**Files:**
- Create: `src/modules/saas-admin/saas-admin.module.ts`
- Create: `src/modules/saas-admin/saas-admin.controller.ts`
- Modify: `src/app.module.ts`
- Create: `test/support/saas.ts`
- Create: `test/e2e/saas-admin-authz.e2e-spec.ts`

- [ ] **Step 1: Criar `src/modules/saas-admin/saas-admin.controller.ts` com um endpoint ping para testar authz**

```ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesGuard } from 'src/common/guards/roles.guard';

@Controller('saas')
@UseGuards(RolesGuard)
@Roles(UserRole.saas_owner)
export class SaasAdminController {
  @Get('ping')
  ping() {
    return { ok: true };
  }
}
```

- [ ] **Step 2: Criar `src/modules/saas-admin/saas-admin.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { SaasAdminController } from './saas-admin.controller';

@Module({
  imports: [PrismaModule],
  controllers: [SaasAdminController],
})
export class SaasAdminModule {}
```

- [ ] **Step 3: Registrar `SaasAdminModule` em `src/app.module.ts`**

Adicionar import e incluir no array `imports`, depois de `BillingModule`:

```ts
import { SaasAdminModule } from './modules/saas-admin/saas-admin.module';

// no array:
    BillingModule,
    SaasAdminModule,
```

- [ ] **Step 4: Criar `test/support/saas.ts`**

```ts
import { INestApplication } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { PasswordService } from 'src/modules/auth/password.service';
import { TokensService } from 'src/modules/auth/tokens.service';

export async function createSaasOwner(
  app: INestApplication,
  overrides: { email?: string; name?: string; password?: string } = {},
): Promise<{ id: string; email: string; accessToken: string }> {
  const prisma = app.get(PrismaService);
  const password = app.get(PasswordService);
  const tokens = app.get(TokensService);

  const email = overrides.email ?? 'saas@kairobarber.test';
  const name = overrides.name ?? 'SaaS Owner';
  const passwordHash = await password.hash(overrides.password ?? 'SuperSafe!1');
  const user = await prisma.user.create({
    data: { email, name, passwordHash, role: UserRole.saas_owner, emailVerifiedAt: new Date() },
  });
  const pair = await tokens.issuePair({ userId: user.id, role: user.role });
  return { id: user.id, email: user.email, accessToken: pair.accessToken };
}

export async function createTenantOwner(
  app: INestApplication,
  slug: string,
  email: string,
): Promise<{ accessToken: string; tenantId: string; userId: string }> {
  const server = app.getHttpServer() as unknown as import('http').Server;
  const reg = await request(server)
    .post('/auth/register/owner')
    .send({
      email,
      password: 'StrongPass!1',
      name: `Owner ${slug}`,
      tenantName: `Tenant ${slug}`,
      slug,
    })
    .expect(201);
  const body = reg.body as {
    accessToken: string;
    tenant: { id: string };
    user: { id: string };
  };
  return { accessToken: body.accessToken, tenantId: body.tenant.id, userId: body.user.id };
}
```

- [ ] **Step 5: Criar `test/e2e/saas-admin-authz.e2e-spec.ts`**

```ts
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import { createSaasOwner, createTenantOwner } from '../support/saas';

describe('SaaS admin — autorização (e2e)', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    setTestEnv();
    container = await startTestPostgres();
    app = await buildTestApp();
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('GET /saas/ping sem token → 401', async () => {
    await request(app.getHttpServer()).get('/saas/ping').expect(401);
  });

  it('GET /saas/ping com token de tenant_owner → 403', async () => {
    const owner = await createTenantOwner(app, 'authztenant', 'authz@tenant.test');
    await request(app.getHttpServer())
      .get('/saas/ping')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(403);
  });

  it('GET /saas/ping com token de saas_owner → 200', async () => {
    const saas = await createSaasOwner(app, { email: 'saas-authz@test.io' });
    await request(app.getHttpServer())
      .get('/saas/ping')
      .set('Authorization', `Bearer ${saas.accessToken}`)
      .expect(200)
      .expect(({ body }) => {
        expect((body as { ok: boolean }).ok).toBe(true);
      });
  });
});
```

- [ ] **Step 6: Rodar o E2E**

```bash
npx jest --config jest.e2e.config.ts test/e2e/saas-admin-authz.e2e-spec.ts --runInBand
```

Expected: 3 testes passam.

- [ ] **Step 7: Commit**

```bash
git add src/modules/saas-admin/ src/app.module.ts test/support/saas.ts test/e2e/saas-admin-authz.e2e-spec.ts
git commit -m "feat(saas-admin): scaffold module with ping endpoint gated by saas_owner role"
```

---

### Task 6: Listagem e detalhe de tenants — `GET /saas/tenants`, `GET /saas/tenants/:id`

**Files:**
- Create: `src/modules/saas-admin/dto/pagination.dto.ts`
- Create: `src/modules/saas-admin/dto/list-tenants-query.dto.ts`
- Create: `src/modules/saas-admin/repositories/saas-tenant.repository.ts`
- Create: `src/modules/saas-admin/services/saas-tenants.service.ts`
- Create: `src/modules/saas-admin/services/saas-tenants.service.spec.ts`
- Modify: `src/modules/saas-admin/saas-admin.controller.ts`
- Modify: `src/modules/saas-admin/saas-admin.module.ts`
- Create: `test/e2e/saas-admin-tenants.e2e-spec.ts`

- [ ] **Step 1: Criar `src/modules/saas-admin/dto/pagination.dto.ts`**

```ts
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class PaginationDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;
}
```

- [ ] **Step 2: Criar `src/modules/saas-admin/dto/list-tenants-query.dto.ts`**

```ts
import { IsBooleanString, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationDto } from './pagination.dto';

export class ListTenantsQueryDto extends PaginationDto {
  @IsOptional()
  @IsIn(['trialing', 'active', 'past_due', 'cancelled', 'all'])
  status: 'trialing' | 'active' | 'past_due' | 'cancelled' | 'all' = 'all';

  @IsOptional()
  @IsBooleanString()
  suspended?: 'true' | 'false';

  @IsOptional()
  @IsString()
  @MaxLength(80)
  search?: string;
}
```

- [ ] **Step 3: Criar `src/modules/saas-admin/repositories/saas-tenant.repository.ts`**

```ts
import { Injectable } from '@nestjs/common';
import { Prisma, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface ListTenantsArgs {
  status: 'trialing' | 'active' | 'past_due' | 'cancelled' | 'all';
  suspended?: 'true' | 'false';
  search?: string;
  page: number;
  pageSize: number;
}

@Injectable()
export class SaasTenantRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(args: ListTenantsArgs) {
    const where: Prisma.TenantWhereInput = {
      deletedAt: null,
      suspendedAt:
        args.suspended === 'true' ? { not: null } : args.suspended === 'false' ? null : undefined,
      subscription:
        args.status === 'all' ? undefined : { status: args.status as SubscriptionStatus },
      OR: args.search
        ? [
            { slug: { contains: args.search, mode: 'insensitive' } },
            { name: { contains: args.search, mode: 'insensitive' } },
          ]
        : undefined,
    };
    const [rows, total] = await Promise.all([
      this.prisma.tenant.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (args.page - 1) * args.pageSize,
        take: args.pageSize,
        include: {
          subscription: {
            select: { status: true, trialEndsAt: true, currentPeriodEnd: true },
          },
          owner: { select: { email: true } },
        },
      }),
      this.prisma.tenant.count({ where }),
    ]);
    return { rows, total };
  }

  async findOneDetailed(id: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      include: {
        subscription: true,
        owner: { select: { email: true } },
      },
    });
    if (!tenant) return null;
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [barbersCount, servicesCount, customersCount, appointmentsTotalCount, appointmentsLast30dCount] =
      await Promise.all([
        this.prisma.barber.count({ where: { tenantId: id, deletedAt: null } }),
        this.prisma.service.count({ where: { tenantId: id, deletedAt: null } }),
        this.prisma.customer.count({ where: { tenantId: id, deletedAt: null } }),
        this.prisma.appointment.count({ where: { tenantId: id } }),
        this.prisma.appointment.count({ where: { tenantId: id, createdAt: { gte: since30d } } }),
      ]);
    return {
      tenant,
      counters: {
        barbersCount,
        servicesCount,
        customersCount,
        appointmentsTotalCount,
        appointmentsLast30dCount,
      },
    };
  }
}
```

- [ ] **Step 4: Criar `src/modules/saas-admin/services/saas-tenants.service.ts`**

```ts
import { HttpStatus, Injectable } from '@nestjs/common';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import {
  ListTenantsArgs,
  SaasTenantRepository,
} from '../repositories/saas-tenant.repository';

@Injectable()
export class SaasTenantsService {
  constructor(private readonly repo: SaasTenantRepository) {}

  async list(args: ListTenantsArgs) {
    const { rows, total } = await this.repo.list(args);
    return {
      page: args.page,
      pageSize: args.pageSize,
      total,
      data: rows.map((t) => ({
        id: t.id,
        slug: t.slug,
        name: t.name,
        ownerEmail: t.owner.email,
        suspendedAt: t.suspendedAt,
        createdAt: t.createdAt,
        subscription: t.subscription
          ? {
              status: t.subscription.status,
              trialEndsAt: t.subscription.trialEndsAt,
              currentPeriodEnd: t.subscription.currentPeriodEnd,
            }
          : null,
      })),
    };
  }

  async detail(id: string) {
    const res = await this.repo.findOneDetailed(id);
    if (!res) {
      throw new DomainException({
        code: ErrorCodes.SAAS_TENANT_NOT_FOUND,
        message: 'Tenant não encontrado.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    const t = res.tenant;
    return {
      id: t.id,
      slug: t.slug,
      name: t.name,
      bio: t.bio,
      ownerEmail: t.owner.email,
      suspendedAt: t.suspendedAt,
      createdAt: t.createdAt,
      subscription: t.subscription
        ? {
            status: t.subscription.status,
            trialEndsAt: t.subscription.trialEndsAt,
            currentPeriodEnd: t.subscription.currentPeriodEnd,
            mpPreapprovalId: t.subscription.mpPreapprovalId,
            aiQuotaUsedThisMonth: t.subscription.aiQuotaUsedThisMonth,
          }
        : null,
      counters: res.counters,
    };
  }
}
```

- [ ] **Step 5: Criar `src/modules/saas-admin/services/saas-tenants.service.spec.ts` (unit, mock do repo)**

```ts
import { SaasTenantsService } from './saas-tenants.service';
import { SaasTenantRepository } from '../repositories/saas-tenant.repository';

describe('SaasTenantsService', () => {
  let repo: jest.Mocked<Pick<SaasTenantRepository, 'list' | 'findOneDetailed'>>;
  let svc: SaasTenantsService;

  beforeEach(() => {
    repo = { list: jest.fn(), findOneDetailed: jest.fn() };
    svc = new SaasTenantsService(repo as unknown as SaasTenantRepository);
  });

  it('list mapeia rows e retorna paginação', async () => {
    repo.list.mockResolvedValueOnce({
      total: 1,
      rows: [
        {
          id: 't1',
          slug: 'a',
          name: 'A',
          suspendedAt: null,
          createdAt: new Date('2026-01-01'),
          owner: { email: 'owner@a.com' },
          subscription: {
            status: 'active',
            trialEndsAt: null,
            currentPeriodEnd: new Date('2026-06-01'),
          },
        } as never,
      ],
    });
    const res = await svc.list({ page: 1, pageSize: 20, status: 'all' });
    expect(res.total).toBe(1);
    expect(res.data[0]).toMatchObject({ id: 't1', ownerEmail: 'owner@a.com' });
  });

  it('detail lança 404 quando tenant não existe', async () => {
    repo.findOneDetailed.mockResolvedValueOnce(null);
    await expect(svc.detail('nope')).rejects.toMatchObject({
      code: 'SAAS_TENANT_NOT_FOUND',
    });
  });
});
```

- [ ] **Step 6: Atualizar `saas-admin.controller.ts` adicionando os 2 endpoints**

```ts
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { ListTenantsQueryDto } from './dto/list-tenants-query.dto';
import { SaasTenantsService } from './services/saas-tenants.service';

@Controller('saas')
@UseGuards(RolesGuard)
@Roles(UserRole.saas_owner)
export class SaasAdminController {
  constructor(private readonly tenants: SaasTenantsService) {}

  @Get('ping')
  ping() {
    return { ok: true };
  }

  @Get('tenants')
  listTenants(@Query() q: ListTenantsQueryDto) {
    return this.tenants.list({
      page: q.page,
      pageSize: q.pageSize,
      status: q.status,
      suspended: q.suspended,
      search: q.search,
    });
  }

  @Get('tenants/:id')
  detailTenant(@Param('id') id: string) {
    return this.tenants.detail(id);
  }
}
```

- [ ] **Step 7: Atualizar `saas-admin.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { SaasAdminController } from './saas-admin.controller';
import { SaasTenantsService } from './services/saas-tenants.service';
import { SaasTenantRepository } from './repositories/saas-tenant.repository';

@Module({
  imports: [PrismaModule],
  controllers: [SaasAdminController],
  providers: [SaasTenantsService, SaasTenantRepository],
})
export class SaasAdminModule {}
```

- [ ] **Step 8: Criar `test/e2e/saas-admin-tenants.e2e-spec.ts`**

```ts
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import { createSaasOwner, createTenantOwner } from '../support/saas';

describe('SaaS admin — tenants (e2e)', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    setTestEnv();
    container = await startTestPostgres();
    app = await buildTestApp();
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('lista, filtra por search, e detalha um tenant existente', async () => {
    const saas = await createSaasOwner(app, { email: 'saas-tenants@test.io' });
    const t1 = await createTenantOwner(app, 'barberone', 'one@bar.test');
    await createTenantOwner(app, 'twobarber', 'two@bar.test');

    const listAll = await request(app.getHttpServer())
      .get('/saas/tenants')
      .set('Authorization', `Bearer ${saas.accessToken}`)
      .expect(200);
    expect((listAll.body as { total: number }).total).toBeGreaterThanOrEqual(2);

    const filtered = await request(app.getHttpServer())
      .get('/saas/tenants?search=barberone')
      .set('Authorization', `Bearer ${saas.accessToken}`)
      .expect(200);
    expect((filtered.body as { data: Array<{ slug: string }> }).data).toHaveLength(1);
    expect((filtered.body as { data: Array<{ slug: string }> }).data[0].slug).toBe('barberone');

    const detail = await request(app.getHttpServer())
      .get(`/saas/tenants/${t1.tenantId}`)
      .set('Authorization', `Bearer ${saas.accessToken}`)
      .expect(200);
    expect((detail.body as { id: string }).id).toBe(t1.tenantId);
    expect((detail.body as { ownerEmail: string }).ownerEmail).toBe('one@bar.test');
    expect((detail.body as { counters: { barbersCount: number } }).counters.barbersCount).toBe(0);
  });

  it('GET /saas/tenants/:id inexistente → 404 SAAS_TENANT_NOT_FOUND', async () => {
    const saas = await createSaasOwner(app, { email: 'saas-tenant-404@test.io' });
    await request(app.getHttpServer())
      .get('/saas/tenants/c0000000000000000000000000')
      .set('Authorization', `Bearer ${saas.accessToken}`)
      .expect(404)
      .expect(({ body }) => {
        expect((body as { code: string }).code).toBe('SAAS_TENANT_NOT_FOUND');
      });
  });
});
```

- [ ] **Step 9: Rodar testes**

```bash
npx jest --config jest.config.ts src/modules/saas-admin/services/saas-tenants.service.spec.ts
npx jest --config jest.e2e.config.ts test/e2e/saas-admin-tenants.e2e-spec.ts --runInBand
```

Expected: todos passam.

- [ ] **Step 10: Commit**

```bash
git add src/modules/saas-admin/ test/e2e/saas-admin-tenants.e2e-spec.ts
git commit -m "feat(saas-admin): list and detail tenants with filters + counters"
```

---

### Task 7: Suspend / Unsuspend tenant — `POST /saas/tenants/:id/(suspend|unsuspend)`

**Files:**
- Modify: `src/modules/saas-admin/repositories/saas-tenant.repository.ts`
- Modify: `src/modules/saas-admin/services/saas-tenants.service.ts`
- Modify: `src/modules/saas-admin/saas-admin.controller.ts`
- Create: `test/e2e/saas-admin-suspend.e2e-spec.ts`

- [ ] **Step 1: Adicionar métodos `suspend` e `unsuspend` em `SaasTenantRepository`**

Append em `src/modules/saas-admin/repositories/saas-tenant.repository.ts`:

```ts
  setSuspended(id: string, suspendedAt: Date | null) {
    return this.prisma.tenant.update({
      where: { id },
      data: { suspendedAt },
      select: { id: true, suspendedAt: true },
    });
  }

  findById(id: string) {
    return this.prisma.tenant.findUnique({
      where: { id },
      select: { id: true, suspendedAt: true, slug: true },
    });
  }
```

- [ ] **Step 2: Adicionar métodos no `SaasTenantsService`**

Em `src/modules/saas-admin/services/saas-tenants.service.ts`, importar `AuditService` e injetar:

```ts
import { AuditService } from 'src/common/audit/audit.service';
import { AuditActions } from 'src/common/audit/audit-actions';

// no constructor:
  constructor(
    private readonly repo: SaasTenantRepository,
    private readonly audit: AuditService,
  ) {}
```

Adicionar:

```ts
  async suspend(id: string, actorUserId: string) {
    const t = await this.repo.findById(id);
    if (!t) {
      throw new DomainException({
        code: ErrorCodes.SAAS_TENANT_NOT_FOUND,
        message: 'Tenant não encontrado.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    if (t.suspendedAt) {
      throw new DomainException({
        code: ErrorCodes.TENANT_ALREADY_SUSPENDED,
        message: 'Tenant já está suspenso.',
        status: HttpStatus.CONFLICT,
      });
    }
    const updated = await this.repo.setSuspended(id, new Date());
    await this.audit.record({
      action: AuditActions.TENANT_SUSPENDED,
      tenantId: id,
      actorUserId,
      targetType: 'tenant',
      targetId: id,
    });
    return { id: updated.id, suspendedAt: updated.suspendedAt };
  }

  async unsuspend(id: string, actorUserId: string) {
    const t = await this.repo.findById(id);
    if (!t) {
      throw new DomainException({
        code: ErrorCodes.SAAS_TENANT_NOT_FOUND,
        message: 'Tenant não encontrado.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    if (!t.suspendedAt) {
      throw new DomainException({
        code: ErrorCodes.TENANT_NOT_SUSPENDED,
        message: 'Tenant não está suspenso.',
        status: HttpStatus.CONFLICT,
      });
    }
    const updated = await this.repo.setSuspended(id, null);
    await this.audit.record({
      action: AuditActions.TENANT_UNSUSPENDED,
      tenantId: id,
      actorUserId,
      targetType: 'tenant',
      targetId: id,
    });
    return { id: updated.id, suspendedAt: updated.suspendedAt };
  }
```

- [ ] **Step 3: Adicionar handlers no controller**

Em `src/modules/saas-admin/saas-admin.controller.ts`:

```ts
import { HttpCode, HttpStatus, Post } from '@nestjs/common';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import type { AuthenticatedUser } from 'src/common/types/request-context';

// dentro da classe:
  @Post('tenants/:id/suspend')
  @HttpCode(HttpStatus.OK)
  suspendTenant(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.tenants.suspend(id, user.id);
  }

  @Post('tenants/:id/unsuspend')
  @HttpCode(HttpStatus.OK)
  unsuspendTenant(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.tenants.unsuspend(id, user.id);
  }
```

- [ ] **Step 4: Criar `test/e2e/saas-admin-suspend.e2e-spec.ts`**

```ts
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import { createSaasOwner, createTenantOwner } from '../support/saas';

describe('SaaS admin — suspend/unsuspend (e2e)', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    setTestEnv();
    container = await startTestPostgres();
    app = await buildTestApp();
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('suspende um tenant → storefront 404 e admin 402 TENANT_SUSPENDED; unsuspend libera', async () => {
    const saas = await createSaasOwner(app, { email: 'saas-suspend@test.io' });
    const owner = await createTenantOwner(app, 'suspend1', 'sus@bar.test');
    const server = app.getHttpServer();

    // Antes: storefront responde 200
    await request(server).get('/public/suspend1').expect(200);

    // Suspend
    const sus = await request(server)
      .post(`/saas/tenants/${owner.tenantId}/suspend`)
      .set('Authorization', `Bearer ${saas.accessToken}`)
      .expect(200);
    expect((sus.body as { suspendedAt: string | null }).suspendedAt).toBeTruthy();

    // Storefront 404
    await request(server).get('/public/suspend1').expect(404);

    // Admin 402 TENANT_SUSPENDED (e.g. tentar listar barbers)
    await request(server)
      .get('/admin/barbers')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(402)
      .expect(({ body }) => {
        expect((body as { code: string }).code).toBe('TENANT_SUSPENDED');
      });

    // Suspender de novo → 409 TENANT_ALREADY_SUSPENDED
    await request(server)
      .post(`/saas/tenants/${owner.tenantId}/suspend`)
      .set('Authorization', `Bearer ${saas.accessToken}`)
      .expect(409)
      .expect(({ body }) => {
        expect((body as { code: string }).code).toBe('TENANT_ALREADY_SUSPENDED');
      });

    // Unsuspend
    const uns = await request(server)
      .post(`/saas/tenants/${owner.tenantId}/unsuspend`)
      .set('Authorization', `Bearer ${saas.accessToken}`)
      .expect(200);
    expect((uns.body as { suspendedAt: string | null }).suspendedAt).toBeNull();

    // Admin volta ao normal
    await request(server)
      .get('/admin/barbers')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    // Storefront volta
    await request(server).get('/public/suspend1').expect(200);

    // Unsuspend de novo → 409 TENANT_NOT_SUSPENDED
    await request(server)
      .post(`/saas/tenants/${owner.tenantId}/unsuspend`)
      .set('Authorization', `Bearer ${saas.accessToken}`)
      .expect(409)
      .expect(({ body }) => {
        expect((body as { code: string }).code).toBe('TENANT_NOT_SUSPENDED');
      });
  });
});
```

- [ ] **Step 5: Rodar testes**

```bash
npx jest --config jest.e2e.config.ts test/e2e/saas-admin-suspend.e2e-spec.ts --runInBand
```

Expected: 1 teste passa.

- [ ] **Step 6: Commit**

```bash
git add src/modules/saas-admin/ test/e2e/saas-admin-suspend.e2e-spec.ts
git commit -m "feat(saas-admin): suspend/unsuspend tenant endpoints with audit"
```

---

### Task 8: Dashboard `GET /saas/dashboard` — MRR/ARR/active/churn/conversion

**Files:**
- Create: `src/modules/saas-admin/repositories/saas-subscription.repository.ts`
- Create: `src/modules/saas-admin/services/saas-metrics.service.ts`
- Create: `src/modules/saas-admin/services/saas-metrics.service.spec.ts`
- Modify: `src/modules/saas-admin/saas-admin.controller.ts`
- Modify: `src/modules/saas-admin/saas-admin.module.ts`
- Modify: `src/config/env.validation.ts`
- Create: `test/e2e/saas-admin-dashboard.e2e-spec.ts`

- [ ] **Step 1: Adicionar `BILLING_MRR_CENTS` em `env.validation.ts`**

Em `envValidationSchema`, depois de `BILLING_TRIAL_DAYS`:

```ts
  BILLING_MRR_CENTS: Joi.number().integer().min(100).default(4990),
```

Adicionar em `AppEnv`:

```ts
  BILLING_MRR_CENTS: number;
```

- [ ] **Step 2: Criar `src/modules/saas-admin/repositories/saas-subscription.repository.ts`**

```ts
import { Injectable } from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class SaasSubscriptionRepository {
  constructor(private readonly prisma: PrismaService) {}

  countByStatus(status: SubscriptionStatus) {
    return this.prisma.subscription.count({ where: { status } });
  }

  countActiveOrTrialing() {
    return this.prisma.subscription.count({
      where: { status: { in: ['trialing', 'active'] } },
    });
  }
}
```

- [ ] **Step 3: Criar `src/modules/saas-admin/services/saas-metrics.service.ts`**

```ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AuditActions } from 'src/common/audit/audit-actions';
import { SaasSubscriptionRepository } from '../repositories/saas-subscription.repository';

@Injectable()
export class SaasMetricsService {
  constructor(
    private readonly subs: SaasSubscriptionRepository,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async dashboard(now: Date = new Date()) {
    const mrrCents = this.config.get<number>('BILLING_MRR_CENTS') ?? 4990;
    const since30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const since60d = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    const [active, tenantsAlive, cancelledIn30d, activatedIn30d, trialsStartedIn60d] =
      await Promise.all([
        this.subs.countByStatus('active'),
        this.subs.countActiveOrTrialing(),
        this.prisma.auditLog.count({
          where: {
            action: AuditActions.SUBSCRIPTION_CANCELLED,
            createdAt: { gte: since30d, lte: now },
          },
        }),
        this.prisma.auditLog.count({
          where: {
            action: AuditActions.SUBSCRIPTION_ACTIVATED,
            createdAt: { gte: since30d, lte: now },
          },
        }),
        this.prisma.auditLog.count({
          where: {
            action: AuditActions.SUBSCRIPTION_TRIAL_STARTED,
            createdAt: { gte: since60d, lte: now },
          },
        }),
      ]);

    const totalMrrCents = active * mrrCents;
    const totalArrCents = totalMrrCents * 12;
    const churnDenominator = active + cancelledIn30d;
    const churn30d = churnDenominator > 0 ? cancelledIn30d / churnDenominator : 0;
    const conversion = trialsStartedIn60d > 0 ? activatedIn30d / trialsStartedIn60d : 0;

    return {
      asOf: now.toISOString(),
      mrrCents: totalMrrCents,
      arrCents: totalArrCents,
      tenantsActive: tenantsAlive,
      cancelledLast30d: cancelledIn30d,
      activatedLast30d: activatedIn30d,
      trialsStartedLast60d: trialsStartedIn60d,
      churn30d: Number(churn30d.toFixed(4)),
      trialConversion30d: Number(conversion.toFixed(4)),
    };
  }
}
```

- [ ] **Step 4: Criar `src/modules/saas-admin/services/saas-metrics.service.spec.ts`**

```ts
import { ConfigService } from '@nestjs/config';
import { SaasMetricsService } from './saas-metrics.service';
import { SaasSubscriptionRepository } from '../repositories/saas-subscription.repository';
import { PrismaService } from 'src/infra/prisma/prisma.service';

describe('SaasMetricsService', () => {
  it('calcula MRR, ARR, churn e conversão a partir de contagens', async () => {
    const subs = {
      countByStatus: jest.fn().mockImplementation((s: string) => (s === 'active' ? 10 : 0)),
      countActiveOrTrialing: jest.fn().mockResolvedValue(12),
    } as unknown as SaasSubscriptionRepository;

    const prisma = {
      auditLog: {
        count: jest
          .fn()
          // ordem das chamadas: cancelledIn30d, activatedIn30d, trialsStartedIn60d
          .mockResolvedValueOnce(2)
          .mockResolvedValueOnce(3)
          .mockResolvedValueOnce(8),
      },
    } as unknown as PrismaService;

    const config = { get: jest.fn().mockReturnValue(4990) } as unknown as ConfigService;
    const svc = new SaasMetricsService(subs, prisma, config);

    const res = await svc.dashboard(new Date('2026-05-12T00:00:00Z'));
    expect(res.mrrCents).toBe(10 * 4990);
    expect(res.arrCents).toBe(10 * 4990 * 12);
    expect(res.tenantsActive).toBe(12);
    expect(res.churn30d).toBeCloseTo(2 / (10 + 2), 4);
    expect(res.trialConversion30d).toBeCloseTo(3 / 8, 4);
  });

  it('retorna 0 em vez de NaN quando denominadores são 0', async () => {
    const subs = {
      countByStatus: jest.fn().mockResolvedValue(0),
      countActiveOrTrialing: jest.fn().mockResolvedValue(0),
    } as unknown as SaasSubscriptionRepository;
    const prisma = {
      auditLog: { count: jest.fn().mockResolvedValue(0) },
    } as unknown as PrismaService;
    const config = { get: jest.fn().mockReturnValue(4990) } as unknown as ConfigService;
    const svc = new SaasMetricsService(subs, prisma, config);
    const res = await svc.dashboard();
    expect(res.churn30d).toBe(0);
    expect(res.trialConversion30d).toBe(0);
  });
});
```

- [ ] **Step 5: Registrar service e repo no module**

Em `src/modules/saas-admin/saas-admin.module.ts`:

```ts
import { SaasMetricsService } from './services/saas-metrics.service';
import { SaasSubscriptionRepository } from './repositories/saas-subscription.repository';

// providers:
  providers: [
    SaasTenantsService,
    SaasTenantRepository,
    SaasMetricsService,
    SaasSubscriptionRepository,
  ],
```

- [ ] **Step 6: Adicionar handler no controller**

```ts
import { SaasMetricsService } from './services/saas-metrics.service';

// no constructor:
  constructor(
    private readonly tenants: SaasTenantsService,
    private readonly metrics: SaasMetricsService,
  ) {}

// novo handler:
  @Get('dashboard')
  dashboard() {
    return this.metrics.dashboard();
  }
```

- [ ] **Step 7: Criar `test/e2e/saas-admin-dashboard.e2e-spec.ts`**

```ts
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import { createSaasOwner, createTenantOwner } from '../support/saas';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AuditActions } from 'src/common/audit/audit-actions';

describe('SaaS admin — dashboard (e2e)', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    setTestEnv();
    container = await startTestPostgres();
    app = await buildTestApp();
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('retorna MRR/ARR baseados em subscriptions active e métricas a partir do AuditLog', async () => {
    const saas = await createSaasOwner(app, { email: 'saas-dash@test.io' });
    // Cria 2 tenants — ambos começam em trialing (e geram audit subscription.trial_started)
    const t1 = await createTenantOwner(app, 'dash1', 'd1@bar.test');
    await createTenantOwner(app, 'dash2', 'd2@bar.test');

    // Marca t1 como active diretamente no banco + AuditLog manualmente
    const prisma = app.get(PrismaService);
    await prisma.subscription.update({
      where: { tenantId: t1.tenantId },
      data: { status: 'active', currentPeriodEnd: new Date('2026-06-12') },
    });
    await prisma.auditLog.create({
      data: {
        action: AuditActions.SUBSCRIPTION_ACTIVATED,
        tenantId: t1.tenantId,
        targetType: 'subscription',
      },
    });

    const dash = await request(app.getHttpServer())
      .get('/saas/dashboard')
      .set('Authorization', `Bearer ${saas.accessToken}`)
      .expect(200);
    const body = dash.body as {
      mrrCents: number;
      arrCents: number;
      tenantsActive: number;
      activatedLast30d: number;
      trialsStartedLast60d: number;
      churn30d: number;
      trialConversion30d: number;
    };
    expect(body.mrrCents).toBe(4990);
    expect(body.arrCents).toBe(4990 * 12);
    expect(body.tenantsActive).toBe(2); // 1 active + 1 trialing
    expect(body.activatedLast30d).toBe(1);
    expect(body.trialsStartedLast60d).toBeGreaterThanOrEqual(2);
    expect(body.churn30d).toBe(0);
    expect(body.trialConversion30d).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 8: Rodar testes**

```bash
npx jest --config jest.config.ts src/modules/saas-admin/services/saas-metrics.service.spec.ts
npx jest --config jest.e2e.config.ts test/e2e/saas-admin-dashboard.e2e-spec.ts --runInBand
```

Expected: 2 unit tests + 1 e2e passam.

- [ ] **Step 9: Commit**

```bash
git add src/modules/saas-admin/ src/config/env.validation.ts test/e2e/saas-admin-dashboard.e2e-spec.ts
git commit -m "feat(saas-admin): dashboard endpoint with MRR/ARR/churn/conversion"
```

---

### Task 9: `GET /saas/ai-usage` — snapshot do mês corrente

**Files:**
- Create: `src/modules/saas-admin/dto/list-ai-usage-query.dto.ts`
- Create: `src/modules/saas-admin/services/saas-ai-usage.service.ts`
- Modify: `src/modules/saas-admin/saas-admin.controller.ts`
- Modify: `src/modules/saas-admin/saas-admin.module.ts`
- Create: `test/e2e/saas-admin-ai-usage.e2e-spec.ts`

- [ ] **Step 1: Criar DTO**

`src/modules/saas-admin/dto/list-ai-usage-query.dto.ts`:

```ts
import { PaginationDto } from './pagination.dto';

export class ListAiUsageQueryDto extends PaginationDto {}
```

- [ ] **Step 2: Criar `SaasAiUsageService`**

`src/modules/saas-admin/services/saas-ai-usage.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class SaasAiUsageService {
  constructor(private readonly prisma: PrismaService) {}

  async snapshot(args: { page: number; pageSize: number }) {
    const now = new Date();
    const windowMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

    const [rows, total] = await Promise.all([
      this.prisma.subscription.findMany({
        where: { aiQuotaUsedThisMonth: { gt: 0 } },
        orderBy: { aiQuotaUsedThisMonth: 'desc' },
        skip: (args.page - 1) * args.pageSize,
        take: args.pageSize,
        include: { tenant: { select: { id: true, slug: true, name: true } } },
      }),
      this.prisma.subscription.count({ where: { aiQuotaUsedThisMonth: { gt: 0 } } }),
    ]);
    return {
      windowMonth,
      page: args.page,
      pageSize: args.pageSize,
      total,
      data: rows.map((s) => ({
        tenantId: s.tenant.id,
        tenantSlug: s.tenant.slug,
        tenantName: s.tenant.name,
        aiQuotaUsedThisMonth: s.aiQuotaUsedThisMonth,
      })),
    };
  }
}
```

- [ ] **Step 3: Registrar e adicionar handler no controller**

No `saas-admin.module.ts`: importar `SaasAiUsageService` e adicionar nos providers.

No `saas-admin.controller.ts`:

```ts
import { SaasAiUsageService } from './services/saas-ai-usage.service';
import { ListAiUsageQueryDto } from './dto/list-ai-usage-query.dto';

// constructor recebe + private readonly aiUsage: SaasAiUsageService

  @Get('ai-usage')
  aiUsage(@Query() q: ListAiUsageQueryDto) {
    return this.aiUsage.snapshot({ page: q.page, pageSize: q.pageSize });
  }
```

- [ ] **Step 4: Criar `test/e2e/saas-admin-ai-usage.e2e-spec.ts`**

```ts
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import { createSaasOwner, createTenantOwner } from '../support/saas';
import { PrismaService } from 'src/infra/prisma/prisma.service';

describe('SaaS admin — ai-usage (e2e)', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    setTestEnv();
    container = await startTestPostgres();
    app = await buildTestApp();
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('lista tenants com quota > 0 ordenados desc', async () => {
    const saas = await createSaasOwner(app, { email: 'saas-ai@test.io' });
    const a = await createTenantOwner(app, 'aiusage-a', 'a@ai.test');
    const b = await createTenantOwner(app, 'aiusage-b', 'b@ai.test');
    const prisma = app.get(PrismaService);
    await prisma.subscription.update({
      where: { tenantId: a.tenantId },
      data: { aiQuotaUsedThisMonth: 5 },
    });
    await prisma.subscription.update({
      where: { tenantId: b.tenantId },
      data: { aiQuotaUsedThisMonth: 20 },
    });

    const res = await request(app.getHttpServer())
      .get('/saas/ai-usage')
      .set('Authorization', `Bearer ${saas.accessToken}`)
      .expect(200);
    const body = res.body as {
      windowMonth: string;
      total: number;
      data: Array<{ tenantSlug: string; aiQuotaUsedThisMonth: number }>;
    };
    expect(body.windowMonth).toMatch(/^\d{4}-\d{2}$/);
    expect(body.total).toBe(2);
    expect(body.data[0].tenantSlug).toBe('aiusage-b');
    expect(body.data[0].aiQuotaUsedThisMonth).toBe(20);
    expect(body.data[1].tenantSlug).toBe('aiusage-a');
  });
});
```

- [ ] **Step 5: Rodar testes**

```bash
npx jest --config jest.e2e.config.ts test/e2e/saas-admin-ai-usage.e2e-spec.ts --runInBand
```

Expected: 1 teste passa.

- [ ] **Step 6: Commit**

```bash
git add src/modules/saas-admin/ test/e2e/saas-admin-ai-usage.e2e-spec.ts
git commit -m "feat(saas-admin): ai-usage snapshot of current month per tenant"
```

---

### Task 10: `GET /saas/users` — listagem global de usuários

**Files:**
- Create: `src/modules/saas-admin/dto/list-users-query.dto.ts`
- Create: `src/modules/saas-admin/repositories/saas-user.repository.ts`
- Create: `src/modules/saas-admin/services/saas-users.service.ts`
- Modify: `src/modules/saas-admin/saas-admin.controller.ts`
- Modify: `src/modules/saas-admin/saas-admin.module.ts`
- Create: `test/e2e/saas-admin-users.e2e-spec.ts`

- [ ] **Step 1: DTO**

`src/modules/saas-admin/dto/list-users-query.dto.ts`:

```ts
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { UserRole } from '@prisma/client';
import { PaginationDto } from './pagination.dto';

export class ListUsersQueryDto extends PaginationDto {
  @IsOptional()
  @IsIn(Object.values(UserRole))
  role?: UserRole;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;
}
```

- [ ] **Step 2: Repository**

`src/modules/saas-admin/repositories/saas-user.repository.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class SaasUserRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(args: { role?: UserRole; search?: string; page: number; pageSize: number }) {
    const where: Prisma.UserWhereInput = {
      role: args.role,
      OR: args.search
        ? [
            { email: { contains: args.search, mode: 'insensitive' } },
            { name: { contains: args.search, mode: 'insensitive' } },
          ]
        : undefined,
    };
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          emailVerifiedAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: (args.page - 1) * args.pageSize,
        take: args.pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);
    return { rows, total };
  }
}
```

- [ ] **Step 3: Service**

`src/modules/saas-admin/services/saas-users.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { SaasUserRepository } from '../repositories/saas-user.repository';

@Injectable()
export class SaasUsersService {
  constructor(private readonly repo: SaasUserRepository) {}

  async list(args: { role?: UserRole; search?: string; page: number; pageSize: number }) {
    const { rows, total } = await this.repo.list(args);
    return {
      page: args.page,
      pageSize: args.pageSize,
      total,
      data: rows,
    };
  }
}
```

- [ ] **Step 4: Registrar no module, adicionar handler no controller**

No `saas-admin.module.ts`: providers += `SaasUsersService, SaasUserRepository`.

No controller:

```ts
import { SaasUsersService } from './services/saas-users.service';
import { ListUsersQueryDto } from './dto/list-users-query.dto';

// constructor: private readonly users: SaasUsersService
  @Get('users')
  listUsers(@Query() q: ListUsersQueryDto) {
    return this.users.list({
      page: q.page,
      pageSize: q.pageSize,
      role: q.role,
      search: q.search,
    });
  }
```

- [ ] **Step 5: E2E**

`test/e2e/saas-admin-users.e2e-spec.ts`:

```ts
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import { createSaasOwner, createTenantOwner } from '../support/saas';

describe('SaaS admin — users (e2e)', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    setTestEnv();
    container = await startTestPostgres();
    app = await buildTestApp();
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('lista todos os users e filtra por role', async () => {
    const saas = await createSaasOwner(app, { email: 'saas-users@test.io' });
    await createTenantOwner(app, 'usr1', 'u1@t.test');
    await createTenantOwner(app, 'usr2', 'u2@t.test');

    const all = await request(app.getHttpServer())
      .get('/saas/users')
      .set('Authorization', `Bearer ${saas.accessToken}`)
      .expect(200);
    expect((all.body as { total: number }).total).toBeGreaterThanOrEqual(3);

    const tenantOwners = await request(app.getHttpServer())
      .get('/saas/users?role=tenant_owner')
      .set('Authorization', `Bearer ${saas.accessToken}`)
      .expect(200);
    const data = (tenantOwners.body as { data: Array<{ role: string }> }).data;
    expect(data.every((u) => u.role === 'tenant_owner')).toBe(true);

    const search = await request(app.getHttpServer())
      .get('/saas/users?search=u1@t.test')
      .set('Authorization', `Bearer ${saas.accessToken}`)
      .expect(200);
    const sData = (search.body as { data: Array<{ email: string }> }).data;
    expect(sData).toHaveLength(1);
    expect(sData[0].email).toBe('u1@t.test');
  });
});
```

- [ ] **Step 6: Rodar testes**

```bash
npx jest --config jest.e2e.config.ts test/e2e/saas-admin-users.e2e-spec.ts --runInBand
```

Expected: 1 teste passa.

- [ ] **Step 7: Commit**

```bash
git add src/modules/saas-admin/ test/e2e/saas-admin-users.e2e-spec.ts
git commit -m "feat(saas-admin): list users endpoint with role and search filters"
```

---

### Task 11: `GET /saas/audit-log` — leitura com filtros

**Files:**
- Create: `src/modules/saas-admin/dto/list-audit-log-query.dto.ts`
- Create: `src/modules/saas-admin/services/saas-audit.service.ts`
- Modify: `src/modules/saas-admin/saas-admin.controller.ts`
- Modify: `src/modules/saas-admin/saas-admin.module.ts`
- Create: `test/e2e/saas-admin-audit-log.e2e-spec.ts`

- [ ] **Step 1: DTO**

`src/modules/saas-admin/dto/list-audit-log-query.dto.ts`:

```ts
import { Type } from 'class-transformer';
import { IsDate, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationDto } from './pagination.dto';

export class ListAuditLogQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  tenantId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  actorUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  action?: string;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}
```

- [ ] **Step 2: Service (wrapper sobre `AuditRepository`)**

`src/modules/saas-admin/services/saas-audit.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { AuditRepository } from 'src/common/audit/audit.repository';
import { AuditQuery } from 'src/common/audit/audit.types';

@Injectable()
export class SaasAuditService {
  constructor(private readonly repo: AuditRepository) {}

  list(q: AuditQuery) {
    return this.repo.listPaginated(q);
  }
}
```

- [ ] **Step 3: Registrar no module e expor `AuditRepository`**

Como `AuditModule` é Global, `AuditService` está disponível, **mas** `AuditRepository` por padrão é privado do módulo. Adicionar `AuditRepository` em `exports` no `audit.module.ts`:

Em `src/common/audit/audit.module.ts`:

```ts
  exports: [AuditService, AuditRepository],
```

Em `src/modules/saas-admin/saas-admin.module.ts`, adicionar `SaasAuditService` em providers.

- [ ] **Step 4: Handler no controller**

```ts
import { SaasAuditService } from './services/saas-audit.service';
import { ListAuditLogQueryDto } from './dto/list-audit-log-query.dto';

// constructor: private readonly audit: SaasAuditService

  @Get('audit-log')
  auditLog(@Query() q: ListAuditLogQueryDto) {
    return this.audit.list({
      page: q.page,
      pageSize: q.pageSize,
      tenantId: q.tenantId,
      actorUserId: q.actorUserId,
      action: q.action,
      from: q.from,
      to: q.to,
    });
  }
```

- [ ] **Step 5: E2E**

`test/e2e/saas-admin-audit-log.e2e-spec.ts`:

```ts
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import { createSaasOwner, createTenantOwner } from '../support/saas';

describe('SaaS admin — audit-log (e2e)', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    setTestEnv();
    container = await startTestPostgres();
    app = await buildTestApp();
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('audit-log inclui trial_started após onboarding e tenant.suspended após suspend', async () => {
    const saas = await createSaasOwner(app, { email: 'saas-audit@test.io' });
    const t = await createTenantOwner(app, 'auditone', 'a@audit.test');

    // Dispara suspend (gera audit tenant.suspended)
    await request(app.getHttpServer())
      .post(`/saas/tenants/${t.tenantId}/suspend`)
      .set('Authorization', `Bearer ${saas.accessToken}`)
      .expect(200);

    const all = await request(app.getHttpServer())
      .get(`/saas/audit-log?tenantId=${t.tenantId}`)
      .set('Authorization', `Bearer ${saas.accessToken}`)
      .expect(200);
    const actions = (all.body as { rows: Array<{ action: string }> }).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['subscription.trial_started', 'tenant.suspended']));

    const filtered = await request(app.getHttpServer())
      .get(`/saas/audit-log?tenantId=${t.tenantId}&action=tenant.suspended`)
      .set('Authorization', `Bearer ${saas.accessToken}`)
      .expect(200);
    expect((filtered.body as { rows: unknown[] }).rows).toHaveLength(1);
  });
});
```

- [ ] **Step 6: Rodar testes**

```bash
npx jest --config jest.e2e.config.ts test/e2e/saas-admin-audit-log.e2e-spec.ts --runInBand
```

Expected: 1 teste passa.

- [ ] **Step 7: Commit**

```bash
git add src/modules/saas-admin/ src/common/audit/audit.module.ts test/e2e/saas-admin-audit-log.e2e-spec.ts
git commit -m "feat(saas-admin): audit-log listing endpoint with filters"
```

---

### Task 12: Seed do `saas_owner` — `prisma/seed.ts`

**Files:**
- Create: `prisma/seed.ts`
- Modify: `package.json`
- Modify: `src/config/env.validation.ts`

- [ ] **Step 1: Adicionar vars opcionais em `env.validation.ts`**

```ts
  // SaaS owner bootstrap (lido apenas pelo seed)
  SAAS_OWNER_EMAIL: Joi.string().email({ tlds: { allow: false } }).optional(),
  SAAS_OWNER_PASSWORD: Joi.string().min(10).optional(),
  SAAS_OWNER_NAME: Joi.string().min(2).max(80).optional(),
  ALLOW_PROD_SEED: Joi.string().valid('true', 'false').optional(),
```

E em `AppEnv`:

```ts
  SAAS_OWNER_EMAIL?: string;
  SAAS_OWNER_PASSWORD?: string;
  SAAS_OWNER_NAME?: string;
  ALLOW_PROD_SEED?: 'true' | 'false';
```

- [ ] **Step 2: Criar `prisma/seed.ts`**

```ts
import { PrismaClient, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';

async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PROD_SEED !== 'true') {
    throw new Error(
      'Seed bloqueado em produção. Defina ALLOW_PROD_SEED=true se realmente quer rodar.',
    );
  }
  const email = process.env.SAAS_OWNER_EMAIL ?? 'saas-owner@kairobarber.dev';
  const name = process.env.SAAS_OWNER_NAME ?? 'SaaS Owner';
  const password = process.env.SAAS_OWNER_PASSWORD ?? 'ChangeMe!1234';

  const prisma = new PrismaClient();
  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

    if (existing) {
      if (existing.role !== UserRole.saas_owner) {
        throw new Error(
          `Usuário ${email} já existe mas role é ${existing.role}, não saas_owner. Aborta.`,
        );
      }
      await prisma.user.update({
        where: { id: existing.id },
        data: { passwordHash, name, emailVerifiedAt: existing.emailVerifiedAt ?? new Date() },
      });
      // eslint-disable-next-line no-console
      console.log(`[seed] saas_owner atualizado: ${email}`);
    } else {
      await prisma.user.create({
        data: {
          email,
          name,
          passwordHash,
          role: UserRole.saas_owner,
          emailVerifiedAt: new Date(),
        },
      });
      // eslint-disable-next-line no-console
      console.log(`[seed] saas_owner criado: ${email}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[seed] erro:', err);
  process.exit(1);
});
```

- [ ] **Step 3: Atualizar `package.json` para registrar o seed**

Adicionar no objeto raiz (ao lado de `scripts`, `dependencies` etc.):

```json
  "prisma": {
    "seed": "ts-node --transpile-only prisma/seed.ts"
  }
```

E adicionar um script:

```json
    "prisma:seed": "prisma db seed"
```

- [ ] **Step 4: Smoke test do seed**

```bash
docker compose up -d postgres
DATABASE_URL=postgresql://kairo:kairo@localhost:5432/kairo SAAS_OWNER_EMAIL=test-seed@kairo.test SAAS_OWNER_PASSWORD=SeedPass!123 SAAS_OWNER_NAME='Seed Test' npx prisma db seed
```

Expected: `[seed] saas_owner criado: test-seed@kairo.test`. Rodar de novo e ver `atualizado` (idempotência).

```bash
DATABASE_URL=postgresql://kairo:kairo@localhost:5432/kairo SAAS_OWNER_EMAIL=test-seed@kairo.test SAAS_OWNER_PASSWORD=SeedPass!123 npx prisma db seed
```

Expected: `[seed] saas_owner atualizado: test-seed@kairo.test`.

- [ ] **Step 5: Limpar usuário de teste e fechar**

```bash
DATABASE_URL=postgresql://kairo:kairo@localhost:5432/kairo npx prisma studio &
# ou via psql, remover test-seed@kairo.test; depois fechar studio.
```

(Opcional — só não deixar lixo no banco local.)

- [ ] **Step 6: Commit**

```bash
git add prisma/seed.ts package.json src/config/env.validation.ts
git commit -m "feat(seed): idempotent saas_owner bootstrap via prisma db seed"
```

---

### Task 13: Suite completa + atualizações de docs

**Files:**
- Modify: `README.md` (seção Fases — marcar Fase 5 como pronta)
- Modify: `.env.example` (adicionar `BILLING_MRR_CENTS`, `SAAS_OWNER_*`)

- [ ] **Step 1: Atualizar `.env.example` (se existir; senão criar)**

Adicionar:

```env
# SaaS / billing
BILLING_MRR_CENTS=4990

# SaaS owner bootstrap (consumido apenas por prisma/seed.ts)
SAAS_OWNER_EMAIL=
SAAS_OWNER_PASSWORD=
SAAS_OWNER_NAME=
# ALLOW_PROD_SEED=true   # só descomente em produção quando intencional
```

- [ ] **Step 2: Atualizar `README.md` — marcar Fase 5 como pronta**

Na seção Fases (ou equivalente), trocar:

```
- [x] Fase 4 — Billing
- [ ] Fase 5 — Dashboard do dono do SaaS
```

por:

```
- [x] Fase 4 — Billing
- [x] Fase 5 — Dashboard do dono do SaaS
```

E adicionar bullet no Resumo:

> Fase 5: módulo `saas-admin` (`/saas/*`) com dashboard, listagem/detalhe/suspend de tenants, ai-usage snapshot, lista de users e audit-log. AuditLog persistente em transições de billing e ações administrativas. Bootstrap de saas_owner via `npm run prisma:seed`.

- [ ] **Step 3: Rodar lint + typecheck**

```bash
npm run lint
npx tsc --noEmit
```

Expected: zero erros.

- [ ] **Step 4: Rodar suite unit completa**

```bash
npm test
```

Expected: todos os tests passam.

- [ ] **Step 5: Rodar suite e2e completa**

```bash
npm run test:e2e
```

Expected: todos os tests passam (incluindo os 7 novos: `saas-admin-authz`, `-tenants`, `-suspend`, `-dashboard`, `-ai-usage`, `-users`, `-audit-log`).

- [ ] **Step 6: Commit final**

```bash
git add README.md .env.example
git commit -m "docs(phase5): README + .env.example reflect SaaS admin completion"
```

---

## Critério de pronto da Fase 5

- [ ] `GET /saas/dashboard` retorna `mrrCents`, `arrCents`, `tenantsActive`, `churn30d`, `trialConversion30d` consistentes com dados do banco e `AuditLog`.
- [ ] `GET /saas/tenants` lista tenants com filtros `status`, `suspended`, `search` e paginação.
- [ ] `GET /saas/tenants/:id` retorna detalhe + counters.
- [ ] `POST /saas/tenants/:id/suspend` bloqueia storefront (404) e admin (402 `TENANT_SUSPENDED`); `/unsuspend` libera. Ambos auditados.
- [ ] `GET /saas/ai-usage` retorna snapshot do mês corrente ordenado por uso desc.
- [ ] `GET /saas/users` lista com filtros `role`, `search`.
- [ ] `GET /saas/audit-log` lista com filtros `tenantId`, `actorUserId`, `action`, `from`, `to`.
- [ ] Todos os endpoints `/saas/*` exigem `JWT` + `role=saas_owner` (403 quando outro role, 401 sem token).
- [ ] `BillingService` grava AuditLog em todas as transições: `trial_started`, `checkout_created`, `activated`, `past_due`, `trial_expired`, `cancelled`.
- [ ] `prisma/seed.ts` cria/atualiza `saas_owner` idempotentemente; bloqueado em prod sem `ALLOW_PROD_SEED=true`.
- [ ] Lint + typecheck + suite completa (unit + e2e) verde.

---

## Self-Review (foi rodado antes de salvar o plano)

- **Spec coverage (seção 4, Fase 5):** dashboard ✅ (Task 8), tenants ✅ (Tasks 6, 7), ai-usage ✅ (Task 9), audit-log ✅ (Task 11), users ✅ (Task 10), suspend/unsuspend ✅ (Task 7). AuditLog model + integração ✅ (Tasks 1-3).
- **Spec coverage (seção 6, AuditLog):** modelo idêntico ao spec ✅. Não retrofitamos a Fase 3 (`customer.identity_updated`) — está documentado na decisão #2; spec não exige cobertura retroativa para encerrar a Fase 5.
- **Type consistency:** `AuditService.record()` é mesma assinatura em todos os calls. `SaasTenantsService.list/detail/suspend/unsuspend` consistente entre tasks. `ListTenantsArgs` reusada por task 6 e task 7.
- **Placeholders:** nenhum "TODO/TBD/similar to" no plano. Cada step tem código real.
- **Gaps conhecidos e aceitos:** churn/conversion dependem do `AuditLog` populado a partir da Fase 4 — tenants criados antes dessa migration não terão histórico (documentado na decisão #3). Aceitável: o produto ainda não está em produção.
