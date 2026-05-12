# KairoBarber — Fase 4 (Billing — Mercado Pago via polling) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plugar pagamento da assinatura no Mercado Pago via polling (sem webhook), implementar o ciclo completo de billing (trial → checkout → active → past_due → cancelled), expor `/admin/billing/*` para o barbeiro dono da barbearia, rodar crons de sincronização (`billing-sync` 2x/dia) e de transição automática de trial (`trial-check` diário), e fazer o gating de tenant inadimplente bloquear admin (exceto novo checkout) e storefront pública (404) quando assinatura ficar `cancelled`.

**Architecture:** Continua monolito modular NestJS. Módulo novo `billing` encapsula a integração com o provider externo atrás de uma interface `BillingProvider` (token DI `BILLING_PROVIDER`), no mesmo padrão de `EMAIL_PROVIDER` / `STORAGE_PROVIDER`. Implementação real é `MercadopagoBillingProvider` (HTTP direto via `fetch` global do Node 18+, sem SDK pesado); implementação de dev/teste é `ConsoleBillingProvider` (em memória, transições explícitas via método `advanceToActive(preapprovalId)` etc., usada por testes E2E). Filas são introduzidas nesta fase: `@nestjs/bullmq` + `bullmq` + `ioredis`. Uma fila única `billing` carrega duas tarefas repeatable (`billing-sync` cron e `trial-check` cron) processadas por `BillingProcessor` no mesmo processo da API. Gating de tenant inadimplente é feito por um `SubscriptionActiveGuard` global registrado como `APP_GUARD` (rodando depois do JWT) que bloqueia `/admin/*` se subscription estiver `cancelled`, com bypass via decorator `@AllowInactiveSubscription()` aplicado nos endpoints de novo checkout e leitura de subscription. Storefront pública continua sob `PublicTenantMiddleware` (já bloqueia `cancelled` desde a Fase 3; nada a mudar lá).

**Tech Stack:** Novidades desta fase apenas: `@nestjs/bullmq@^11`, `bullmq@^5`, `ioredis@^5`. Sem SDK do Mercado Pago — REST direto via `fetch` (Node 18+ tem global). Crons via repeatable jobs do BullMQ (não usamos `@nestjs/schedule` pra não duplicar dependência de scheduler). Sem `mercadopago` npm — preferimos manter superfície mínima e mocar facilmente nos testes.

**Spec de referência:** [`docs/superpowers/specs/2026-05-11-kairobarber-backend-design.md`](../specs/2026-05-11-kairobarber-backend-design.md) (seção 4 — Fase 4; seção 6 — `Subscription`; seção 7 — endpoints `/admin/billing/*`; seção 8.5 — fluxo de billing; seção 12 — segurança/rate limit; seção 15 — riscos).

**Plano anterior:** [`2026-05-12-kairobarber-fase-3-storefront-agendamento.md`](./2026-05-12-kairobarber-fase-3-storefront-agendamento.md).

---

## Estado atual do repositório (entrada da Fase 4)

- `prisma/schema.prisma` já tem `Subscription` com todos os campos que a spec pede pra Fase 4: `status`, `trialEndsAt`, `currentPeriodEnd`, `mpPreapprovalId` (UNIQUE), `lastSyncedAt`, `nextSyncAt`, `aiQuotaUsedThisMonth`. Índice `(status, nextSyncAt)` já existe. Última migration: `20260512034724_phase3_storefront_scheduling`.
- `src/modules/auth/auth.service.ts:83-89` cria `Subscription{status:trialing, trialEndsAt:now+14d}` na transação de `registerOwner`. **Reescreveremos esse trecho** para usar `BillingService.startTrial()` (ponto único de criação), mas sem mudar o comportamento observável.
- `src/common/middleware/public-tenant.middleware.ts` já valida `tenant.subscription.status !== 'cancelled'` (404 quando `cancelled`). **Não muda nessa fase.** O cron é quem transiciona `past_due → cancelled` depois da janela de carência; o middleware só observa.
- `src/modules/notifications` injeta via token `EMAIL_PROVIDER`. Padrão será reaproveitado para `BILLING_PROVIDER`.
- `src/infra/prisma/prisma.service.ts` já tem `Subscription` em `TENANT_SCOPED_MODELS`. Repository da Fase 4 vai usar `prisma.subscription` direto (com tenant escopo via ALS), exceto nos crons que precisam varrer todas as subscriptions globalmente — pra isso, usaremos o cliente não-escopado (`prisma` direto) dentro de bloco `tenantAls.run({}, ...)` vazio.
- Sem BullMQ, Redis ou cron framework ainda no projeto. `docker-compose.yml` só tem Postgres.
- `src/config/env.validation.ts` exporta Joi + tipo `AppEnv`. Vamos estender.
- Test harness em `test/support/{postgres-container,test-app,test-env}.ts` está pronto. Vamos somar `test/support/billing.ts` com helpers de tempo (avanço de relógio via `BILLING_NOW_OVERRIDE_MS` no `BillingService`) e helpers para usar o `ConsoleBillingProvider` nos E2E.

---

## Estrutura de arquivos resultante (delta da Fase 4)

```
kairobarber/
├── docker-compose.yml                                       # ATUALIZA: serviço redis
├── package.json                                             # ATUALIZA: @nestjs/bullmq, bullmq, ioredis
├── .env.example                                             # ATUALIZA: MP_*, REDIS_URL, BILLING_*
│
├── prisma/
│   ├── schema.prisma                                        # ATUALIZA (cosmético): comentários, sem novos campos
│   └── migrations/
│       └── <novo timestamp>_phase4_billing_notes/           # NOVO se algum índice extra; vazio se nenhum
│
├── src/
│   ├── config/
│   │   └── env.validation.ts                                # ATUALIZA: MP_ACCESS_TOKEN, MP_PLAN_AMOUNT_CENTS, MP_BILLING_FREQUENCY, MP_RETURN_URL, REDIS_URL, BILLING_PROVIDER, BILLING_TRIAL_DAYS, BILLING_PAST_DUE_GRACE_DAYS, BILLING_SYNC_CRON, BILLING_TRIAL_CHECK_CRON
│   │
│   ├── common/
│   │   ├── exceptions/
│   │   │   └── error-codes.ts                               # ATUALIZA: códigos da Fase 4
│   │   ├── decorators/
│   │   │   └── allow-inactive-subscription.decorator.ts     # NOVO
│   │   └── guards/
│   │       └── subscription-active.guard.ts                 # NOVO + .spec.ts
│   │
│   ├── infra/
│   │   ├── redis/                                           # NOVO
│   │   │   ├── redis.module.ts
│   │   │   └── redis.tokens.ts
│   │   └── queues/                                          # NOVO
│   │       ├── queues.module.ts
│   │       └── queue-names.ts
│   │
│   └── modules/
│       ├── auth/
│       │   └── auth.service.ts                              # ATUALIZA: delega criação inicial de Subscription para BillingService.startTrial()
│       │
│       └── billing/                                         # NOVO MÓDULO
│           ├── billing.module.ts
│           ├── billing.service.ts
│           ├── billing.service.spec.ts
│           ├── billing.controller.ts
│           ├── billing.processor.ts                         # BullMQ worker (billing-sync + trial-check)
│           ├── billing.processor.spec.ts
│           ├── billing.schedules.ts                         # OnApplicationBootstrap registra repeatable jobs
│           ├── billing.constants.ts                         # MIN_LEAD_DAYS, etc.
│           ├── repositories/
│           │   └── subscription.repository.ts
│           ├── providers/
│           │   ├── billing.provider.ts                      # interface BillingProvider + token + types
│           │   ├── mercadopago.billing-provider.ts
│           │   ├── mercadopago.billing-provider.spec.ts
│           │   ├── console.billing-provider.ts
│           │   └── console.billing-provider.spec.ts
│           └── dto/
│               ├── create-checkout.dto.ts
│               ├── cancel-subscription.dto.ts
│               └── subscription-view.dto.ts
│
├── src/app.module.ts                                        # ATUALIZA: registra RedisModule, QueuesModule, BillingModule, SubscriptionActiveGuard APP_GUARD
│
└── test/
    ├── e2e/
    │   ├── billing-checkout.e2e-spec.ts                     # NOVO: checkout → sync → active
    │   ├── billing-trial-check.e2e-spec.ts                  # NOVO: trial expira → past_due; past_due + 8d → cancelled
    │   ├── billing-cron-sync.e2e-spec.ts                    # NOVO: cron sync polling pega mudança de status
    │   └── billing-admin-gating.e2e-spec.ts                 # NOVO: cancelled bloqueia admin exceto checkout/subscription; storefront 404
    └── support/
        └── billing.ts                                       # NOVO: helpers (advanceClockBy, console provider state, runBillingJobsNow)
```

---

## Decisões importantes desta fase (registrar antes de codar)

1. **Sem SDK do Mercado Pago**: `MercadopagoBillingProvider` chama REST via `fetch` global. Endpoints usados:
   - `POST https://api.mercadopago.com/preapproval` — cria preapproval (assinatura recorrente).
   - `GET  https://api.mercadopago.com/preapproval/{id}` — retorna status (`authorized | paused | cancelled | pending`) e `next_payment_date`.
   - `PUT  https://api.mercadopago.com/preapproval/{id}` — atualiza (usado para cancelar via `{ status: 'cancelled' }`).
   - `GET  https://api.mercadopago.com/authorized_payments/search?preapproval_id={id}` — lista cobranças (usado em `GET /admin/billing/invoices`, mapeado para DTO simples).
   Auth via header `Authorization: Bearer ${MP_ACCESS_TOKEN}`. Não estoca cartões — MP hospeda o pagamento; nosso fluxo é só preapproval + polling.

2. **Mapeamento de status MP → nosso enum**:
   | MP `status` | Nosso `SubscriptionStatus` |
   |---|---|
   | `pending`     | mantém o atual local (geralmente `trialing` se acabou de criar) |
   | `authorized`  | `active` |
   | `paused`      | `past_due` |
   | `cancelled`   | `cancelled` |
   Qualquer outro valor → loga warn + mantém local. **Nunca regredir de `cancelled` pra outro estado** (defesa contra resposta inconsistente do MP).

3. **`BillingProvider` interface**: 5 métodos — `createPreapproval(input)`, `fetchPreapproval(id)`, `cancelPreapproval(id)`, `listPayments(id, range)`, `healthCheck()`. Mais nada (YAGNI). `ConsoleBillingProvider` cumpre o contrato com store em memória; expõe métodos extra `__test_advance(id, status, currentPeriodEnd)` e `__test_addPayment(id, payment)` que **não** estão na interface (cast no E2E).

4. **Endpoint `/admin/billing/checkout` é idempotente por subscription**: se o tenant já tem `mpPreapprovalId` e o status local for `trialing`, devolve o `initPoint` salvo (re-buscando via `fetchPreapproval` se necessário). Se já estiver `active`, retorna 409 `SUBSCRIPTION_ALREADY_ACTIVE`. Se `past_due` ou `cancelled`, **cria preapproval novo** (substitui `mpPreapprovalId`), porque MP não permite "religar" um preapproval cancelado.

5. **`POST /admin/billing/sync` é gratuito e idempotente**: front chama logo após o redirect de retorno do checkout. Service: `BillingProvider.fetchPreapproval(mpPreapprovalId)` → aplica `applyRemoteState(local, remote)`. Sem rate limit dedicado, mas throttler global cobre.

6. **`POST /admin/billing/cancel`**: chama `BillingProvider.cancelPreapproval(id)`, e independente da resposta marca local como `cancelled` (idempotente; se MP já está cancelado, OK). `currentPeriodEnd` é preservado pra história.

7. **`GET /admin/billing/invoices`**: paginação via `?page=1&pageSize=20`. Retorna `[{ id, amountCents, status, paidAt?, dueAt? }]`. Se subscription ainda não tem `mpPreapprovalId`, retorna lista vazia.

8. **Crons via BullMQ repeatable**: ao bootstrap (`OnApplicationBootstrap` no `BillingSchedules`), registra dois jobs:
   - `billing-sync` cron default `0 6,18 * * *` (UTC), configurável por env.
   - `trial-check` cron default `15 6 * * *` (UTC), configurável por env.
   Job já existente com mesma `key` é substituído idempotentemente (`upsertJobScheduler`). Em ambiente de teste, **não bootstrapa** (env `NODE_ENV=test` desliga; testes acionam manualmente via `runBillingJobsNow`).

9. **`billing-sync` (cron) — varredura por status**:
   - `trialing`, `active`: agenda re-sync em `+24h` (define `nextSyncAt`).
   - `past_due`: re-sync em `+2h`.
   - `cancelled`: para de varrer (`nextSyncAt = null`).
   Cada execução do cron pega no banco até 50 subscriptions com `nextSyncAt <= now()` (e `mpPreapprovalId NOT NULL`), processa, atualiza `lastSyncedAt` e `nextSyncAt`. Falha individual (MP timeout) é loggada e segue; `nextSyncAt` recua só 15 min pra retry (não +2h/+24h).

10. **`trial-check` (cron) — duas transições determinísticas**:
    - `status='trialing' AND trialEndsAt < now()` → `past_due` (zera `currentPeriodEnd` se vazio; mantém `mpPreapprovalId` nulo se nunca houve checkout). Loga `event=subscription.trial_expired`.
    - `status='past_due' AND updatedAt < now() - BILLING_PAST_DUE_GRACE_DAYS` → `cancelled`. **A janela de graça é medida pelo `updatedAt` da última transição pra `past_due`, não pelo `trialEndsAt`** (pra também valer pra inadimplência depois do trial). Loga `event=subscription.grace_period_expired`.

11. **`BILLING_NOW_OVERRIDE_MS`**: `BillingService` expõe um método interno `now()` que devolve `new Date(Number(process.env.BILLING_NOW_OVERRIDE_MS))` se a env existir, senão `new Date()`. Usado **só em testes E2E** para viajar no tempo sem dependência de fake timers. Em produção a env é validada como ausente.

12. **`SubscriptionActiveGuard` (gating de admin)**: roda depois de `JwtAuthGuard` (mesmo nível, mas a guarda lê `req.user.tenantId`; se ausente → permite, deixa o próximo guard reclamar). Carrega `Subscription` por `tenantId`, e:
    - `cancelled` → bloqueia tudo exceto endpoints anotados `@AllowInactiveSubscription()`.
    - `trialing`, `active`, `past_due` → libera.
    Endpoints `@AllowInactiveSubscription()`: `GET /admin/billing/subscription`, `POST /admin/billing/checkout`, `POST /admin/billing/sync`. Resto bloqueado quando `cancelled` → 402 `SUBSCRIPTION_INACTIVE`.

13. **HTTP status para inadimplência**: 402 `Payment Required`. Front trata exibindo banner de checkout.

14. **Eventos de domínio**: implementação simples, **dentro do `BillingService`** (sem event bus genérico ainda — vai entrar quando IA chegar). Apenas loga `event=subscription.activated`, `event=subscription.past_due`, `event=subscription.cancelled`, `event=subscription.trial_expired` no `pino` com `{ tenantId, fromStatus, toStatus, mpPreapprovalId }`. Hooks de email (ex: notificar barbeiro de cobrança falha) ficam pra Fase 5 — out of scope.

15. **Webhook do MP**: explicitamente **fora do MVP**. Spec §15 prevê substituir polling por webhook depois. Interface `BillingProvider` já permite — o módulo que recebe webhook entraria como controller adicional chamando o mesmo `applyRemoteState`. Não codamos nada de webhook nesta fase.

16. **Cobertura mínima da spec §11**: `billing/` ≥ 90% em test:cov. Cada caminho crítico (criação de preapproval, sync com cada status, cancel, transições do cron) tem teste dedicado.

17. **LGPD**: não armazenamos cartão, CPF do cartão, ou qualquer dado de pagamento — só `mpPreapprovalId` (opaco) e snapshot de status. Pagamento é hospedado pelo MP.

18. **Idempotência do checkout**: header `Idempotency-Key` opcional ainda não implementado (depende de cache Redis — agora temos Redis, mas Idempotency-Key continua out of scope desta fase pra não inchar). A idempotência prática é dada pela regra do item 4 (mesma subscription = mesma resposta).

19. **`@AllowInactiveSubscription()`**: marca metadata `ALLOW_INACTIVE_SUBSCRIPTION_KEY`. Não confundir com `@Public()` (que desliga JWT). Endpoints anotados ainda exigem auth — só não exigem subscription ativa.

20. **Rate limit**: spec §12 não exige rate dedicado pra billing. Throttler global é suficiente.

---

## Pré-requisitos por tarefa

- Stack já bootstrapped Fases 0/1/2/3.
- Postgres roda via testcontainers nos E2E. Redis roda via container Docker local (`docker compose up redis`) ou testcontainers nos E2E (`@testcontainers/redis`). Usaremos testcontainers do Redis (instalação adicional na primeira tarefa que precisar).
- Cada tarefa termina com `npm run lint && npm run test` verdes antes do commit. Onde a tarefa envolve banco ou Redis, rodar também `npm run test:e2e` no fim do bloco lógico (indicado nas tarefas).

---

## Task 1: Dependências novas + docker-compose com Redis

**Files:**
- Modify: `package.json`
- Modify: `docker-compose.yml`

- [ ] **Step 1.1: Instalar deps**

Run:
```bash
npm install @nestjs/bullmq@^11 bullmq@^5 ioredis@^5
npm install -D @testcontainers/redis@^10
```
Expected: `package.json` + `package-lock.json` atualizados. Sem warnings de peer-dep críticos.

- [ ] **Step 1.2: Confirmar versões instaladas**

Run:
```bash
node -e "const p=require('./package.json'); console.log({bull:p.dependencies['@nestjs/bullmq'], bullmq:p.dependencies['bullmq'], ioredis:p.dependencies['ioredis'], tcRedis:p.devDependencies['@testcontainers/redis']});"
```
Expected: imprime objeto com 4 versões não-undefined. Se algum vier `undefined`, reinstalar.

- [ ] **Step 1.3: Adicionar Redis ao docker-compose.yml**

Edite `docker-compose.yml` adicionando o serviço `redis` antes do bloco `volumes`:

```yaml
  redis:
    image: redis:7-alpine
    container_name: kairobarber-redis-dev
    restart: unless-stopped
    command: ['redis-server', '--appendonly', 'yes']
    ports:
      - '6379:6379'
    volumes:
      - redis_data:/data
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 5s
      retries: 5
```

E inclua `redis_data` no bloco `volumes`:

```yaml
volumes:
  postgres_data:
  redis_data:
```

- [ ] **Step 1.4: Verificar que sobe**

Run:
```bash
docker compose up -d redis
docker compose exec redis redis-cli ping
```
Expected: `PONG`.

- [ ] **Step 1.5: Commit**

```bash
git add package.json package-lock.json docker-compose.yml
git commit -m "feat(infra): add bullmq, ioredis and redis dev container"
```

---

## Task 2: Env vars de billing + Redis

**Files:**
- Modify: `src/config/env.validation.ts`
- Modify: `.env.example`

- [ ] **Step 2.1: Estender o schema Joi e o tipo `AppEnv`**

Em `src/config/env.validation.ts`, adicione ao objeto `Joi.object({...})` (antes do `})`):

```ts
  REDIS_URL: Joi.string().uri().required(),

  BILLING_PROVIDER: Joi.string().valid('console', 'mercadopago').default('console'),
  BILLING_TRIAL_DAYS: Joi.number().integer().min(0).max(60).default(14),
  BILLING_PAST_DUE_GRACE_DAYS: Joi.number().integer().min(0).max(60).default(7),
  BILLING_SYNC_CRON: Joi.string().default('0 6,18 * * *'),
  BILLING_TRIAL_CHECK_CRON: Joi.string().default('15 6 * * *'),

  MP_ACCESS_TOKEN: Joi.string().when('BILLING_PROVIDER', {
    is: 'mercadopago',
    then: Joi.required(),
    otherwise: Joi.optional().allow(''),
  }),
  MP_PLAN_AMOUNT_CENTS: Joi.number().integer().min(100).when('BILLING_PROVIDER', {
    is: 'mercadopago',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  MP_BILLING_FREQUENCY: Joi.string().valid('months').default('months'),
  MP_RETURN_URL: Joi.string().uri().when('BILLING_PROVIDER', {
    is: 'mercadopago',
    then: Joi.required(),
    otherwise: Joi.optional().allow(''),
  }),
  MP_API_BASE_URL: Joi.string().uri().default('https://api.mercadopago.com'),

  BILLING_NOW_OVERRIDE_MS: Joi.number().integer().optional(),
```

E estenda o tipo `AppEnv` com:

```ts
  REDIS_URL: string;
  BILLING_PROVIDER: 'console' | 'mercadopago';
  BILLING_TRIAL_DAYS: number;
  BILLING_PAST_DUE_GRACE_DAYS: number;
  BILLING_SYNC_CRON: string;
  BILLING_TRIAL_CHECK_CRON: string;
  MP_ACCESS_TOKEN?: string;
  MP_PLAN_AMOUNT_CENTS?: number;
  MP_BILLING_FREQUENCY: 'months';
  MP_RETURN_URL?: string;
  MP_API_BASE_URL: string;
  BILLING_NOW_OVERRIDE_MS?: number;
```

- [ ] **Step 2.2: Atualizar `.env.example`**

Acrescente ao final de `.env.example`:

```
# Redis
REDIS_URL=redis://localhost:6379

# Billing
BILLING_PROVIDER=console
BILLING_TRIAL_DAYS=14
BILLING_PAST_DUE_GRACE_DAYS=7
BILLING_SYNC_CRON=0 6,18 * * *
BILLING_TRIAL_CHECK_CRON=15 6 * * *

# Mercado Pago (only when BILLING_PROVIDER=mercadopago)
MP_ACCESS_TOKEN=
MP_PLAN_AMOUNT_CENTS=4990
MP_BILLING_FREQUENCY=months
MP_RETURN_URL=http://localhost:3001/admin/billing/return
MP_API_BASE_URL=https://api.mercadopago.com
```

- [ ] **Step 2.3: Verificar boot**

Run:
```bash
npm run build && REDIS_URL=redis://localhost:6379 BILLING_PROVIDER=console node -e "require('./dist/config/env.validation.js')"
```
Expected: sem erro de validação Joi.

- [ ] **Step 2.4: Commit**

```bash
git add src/config/env.validation.ts .env.example
git commit -m "feat(config): add billing and redis env vars"
```

---

## Task 3: `RedisModule` — cliente compartilhado

**Files:**
- Create: `src/infra/redis/redis.tokens.ts`
- Create: `src/infra/redis/redis.module.ts`

- [ ] **Step 3.1: Definir token DI**

Crie `src/infra/redis/redis.tokens.ts`:

```ts
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
```

- [ ] **Step 3.2: Criar o módulo `@Global()`**

Crie `src/infra/redis/redis.module.ts`:

```ts
import { Global, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import { REDIS_CLIENT } from './redis.tokens';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (cfg: ConfigService) => {
        const url = cfg.get<string>('REDIS_URL');
        if (!url) throw new Error('REDIS_URL is required');
        return new IORedis(url, { maxRetriesPerRequest: null, enableReadyCheck: false });
      },
      inject: [ConfigService],
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor() {}

  async onApplicationShutdown() {
    // ioredis fecha sozinho no SIGTERM via app.enableShutdownHooks(),
    // mas mantemos a interface explícita para futura quiesce de filas.
  }
}
```

> **Por que `maxRetriesPerRequest: null` e `enableReadyCheck: false`**: requisito do BullMQ. O cliente do `RedisModule` é o conexão "base" reutilizada pelos workers; flags erradas causam `Error: BullMQ requires maxRetriesPerRequest=null`.

- [ ] **Step 3.3: Registrar no `app.module.ts`**

Em `src/app.module.ts`, adicione import de `RedisModule` e inclua em `imports` logo após `PrismaModule`:

```ts
import { RedisModule } from './infra/redis/redis.module';
// ...
imports: [
  ConfigModule,
  LoggerModule.forRootAsync({ /* ... */ }),
  ThrottlerModule.forRoot([/* ... */]),
  PrismaModule,
  RedisModule,
  // resto igual
],
```

- [ ] **Step 3.4: Verificar build**

Run: `npm run build`
Expected: sem erro.

- [ ] **Step 3.5: Commit**

```bash
git add src/infra/redis src/app.module.ts
git commit -m "feat(infra): add RedisModule with shared ioredis client"
```

---

## Task 4: `QueuesModule` — registra fila `billing` via `@nestjs/bullmq`

**Files:**
- Create: `src/infra/queues/queue-names.ts`
- Create: `src/infra/queues/queues.module.ts`

- [ ] **Step 4.1: Constantes de nome de fila**

Crie `src/infra/queues/queue-names.ts`:

```ts
export const QUEUE_BILLING = 'billing';

export const JOB_BILLING_SYNC = 'billing-sync';
export const JOB_TRIAL_CHECK = 'trial-check';
```

- [ ] **Step 4.2: Módulo de filas**

Crie `src/infra/queues/queues.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { QUEUE_BILLING } from './queue-names';

@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: (cfg: ConfigService) => ({
        connection: { url: cfg.get<string>('REDIS_URL') },
      }),
      inject: [ConfigService],
    }),
    BullModule.registerQueue({ name: QUEUE_BILLING }),
  ],
  exports: [BullModule],
})
export class QueuesModule {}
```

- [ ] **Step 4.3: Registrar em `app.module.ts`**

```ts
import { QueuesModule } from './infra/queues/queues.module';
// imports: [ ..., RedisModule, QueuesModule, ... ]
```

- [ ] **Step 4.4: Verificar boot**

Run: `npm run build`
Expected: sem erro.

- [ ] **Step 4.5: Commit**

```bash
git add src/infra/queues src/app.module.ts
git commit -m "feat(infra): add QueuesModule with billing queue"
```

---

## Task 5: Códigos de erro da Fase 4

**Files:**
- Modify: `src/common/exceptions/error-codes.ts`

- [ ] **Step 5.1: Acrescentar os códigos**

Em `src/common/exceptions/error-codes.ts`, antes do `} as const;`, adicione um bloco:

```ts
  // Phase 4 — billing
  SUBSCRIPTION_INACTIVE: 'SUBSCRIPTION_INACTIVE',
  SUBSCRIPTION_ALREADY_ACTIVE: 'SUBSCRIPTION_ALREADY_ACTIVE',
  SUBSCRIPTION_NOT_FOUND: 'SUBSCRIPTION_NOT_FOUND',
  BILLING_PROVIDER_ERROR: 'BILLING_PROVIDER_ERROR',
  BILLING_PROVIDER_UNAUTHORIZED: 'BILLING_PROVIDER_UNAUTHORIZED',
  BILLING_CHECKOUT_FAILED: 'BILLING_CHECKOUT_FAILED',
```

- [ ] **Step 5.2: Lint + build**

Run: `npm run lint && npm run build`
Expected: passa.

- [ ] **Step 5.3: Commit**

```bash
git add src/common/exceptions/error-codes.ts
git commit -m "feat(errors): add billing error codes for phase 4"
```

---

## Task 6: Interface `BillingProvider` + tipos + token DI

**Files:**
- Create: `src/modules/billing/providers/billing.provider.ts`

- [ ] **Step 6.1: Escrever a interface e tipos**

Crie `src/modules/billing/providers/billing.provider.ts`:

```ts
export const BILLING_PROVIDER = Symbol('BILLING_PROVIDER');

export type RemoteSubscriptionStatus = 'pending' | 'authorized' | 'paused' | 'cancelled';

export interface CreatePreapprovalInput {
  tenantId: string;
  tenantSlug: string;
  payerEmail: string;
  reason: string;        // título visível pro payer ("Assinatura KairoBarber - {slug}")
  amountCents: number;
  frequency: 'months';
}

export interface CreatePreapprovalResult {
  preapprovalId: string;
  initPoint: string;     // URL pra redirecionar o usuário
}

export interface RemoteSubscription {
  preapprovalId: string;
  status: RemoteSubscriptionStatus;
  nextPaymentDate: Date | null;
}

export interface RemotePayment {
  id: string;
  amountCents: number;
  status: 'approved' | 'rejected' | 'pending' | 'refunded';
  paidAt: Date | null;
  dueAt: Date | null;
}

export interface ListPaymentsQuery {
  page: number;        // 1-based
  pageSize: number;    // 1..50
}

export interface BillingProvider {
  createPreapproval(input: CreatePreapprovalInput): Promise<CreatePreapprovalResult>;
  fetchPreapproval(preapprovalId: string): Promise<RemoteSubscription>;
  cancelPreapproval(preapprovalId: string): Promise<void>;
  listPayments(preapprovalId: string, q: ListPaymentsQuery): Promise<RemotePayment[]>;
  healthCheck(): Promise<{ ok: boolean }>;
}
```

- [ ] **Step 6.2: Lint + build**

Run: `npm run lint && npm run build`
Expected: passa.

- [ ] **Step 6.3: Commit**

```bash
git add src/modules/billing/providers/billing.provider.ts
git commit -m "feat(billing): define BillingProvider interface and DTOs"
```

---

## Task 7: `MercadopagoBillingProvider` — teste primeiro

**Files:**
- Create: `src/modules/billing/providers/mercadopago.billing-provider.spec.ts`
- Create: `src/modules/billing/providers/mercadopago.billing-provider.ts`

- [ ] **Step 7.1: Escrever os testes do provider**

Crie `src/modules/billing/providers/mercadopago.billing-provider.spec.ts`:

```ts
import { MercadopagoBillingProvider } from './mercadopago.billing-provider';

type FetchFn = jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;

function mkFetch(): FetchFn {
  return jest.fn();
}

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('MercadopagoBillingProvider', () => {
  const baseUrl = 'https://api.mercadopago.test';
  const token = 'TEST-TOKEN';
  let fetchMock: FetchFn;
  let provider: MercadopagoBillingProvider;

  beforeEach(() => {
    fetchMock = mkFetch();
    provider = new MercadopagoBillingProvider({
      accessToken: token,
      apiBaseUrl: baseUrl,
      returnUrl: 'https://kairobarber.test/admin/billing/return',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
  });

  describe('createPreapproval', () => {
    it('POST /preapproval e mapeia resposta para { preapprovalId, initPoint }', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonRes(201, { id: 'PRE-123', init_point: 'https://mp.test/pay/PRE-123' }),
      );

      const result = await provider.createPreapproval({
        tenantId: 't1',
        tenantSlug: 'demo',
        payerEmail: 'owner@x.com',
        reason: 'Assinatura KairoBarber - demo',
        amountCents: 4990,
        frequency: 'months',
      });

      expect(result).toEqual({ preapprovalId: 'PRE-123', initPoint: 'https://mp.test/pay/PRE-123' });

      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe(`${baseUrl}/preapproval`);
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      expect(headers['Authorization']).toBe(`Bearer ${token}`);
      expect(headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(String(init?.body));
      expect(body.reason).toBe('Assinatura KairoBarber - demo');
      expect(body.auto_recurring.transaction_amount).toBe(49.9);
      expect(body.auto_recurring.frequency).toBe(1);
      expect(body.auto_recurring.frequency_type).toBe('months');
      expect(body.payer_email).toBe('owner@x.com');
      expect(body.external_reference).toBe('t1');
      expect(body.back_url).toBe('https://kairobarber.test/admin/billing/return');
    });

    it('401 do MP vira BILLING_PROVIDER_UNAUTHORIZED', async () => {
      fetchMock.mockResolvedValueOnce(jsonRes(401, { message: 'invalid token' }));
      await expect(
        provider.createPreapproval({
          tenantId: 't1', tenantSlug: 'd', payerEmail: 'x@x.com',
          reason: 'r', amountCents: 4990, frequency: 'months',
        }),
      ).rejects.toMatchObject({ opts: { code: 'BILLING_PROVIDER_UNAUTHORIZED' } });
    });

    it('5xx do MP vira BILLING_PROVIDER_ERROR', async () => {
      fetchMock.mockResolvedValueOnce(jsonRes(503, { message: 'busy' }));
      await expect(
        provider.createPreapproval({
          tenantId: 't1', tenantSlug: 'd', payerEmail: 'x@x.com',
          reason: 'r', amountCents: 4990, frequency: 'months',
        }),
      ).rejects.toMatchObject({ opts: { code: 'BILLING_PROVIDER_ERROR' } });
    });
  });

  describe('fetchPreapproval', () => {
    it('GET /preapproval/{id} e mapeia status authorized → authorized', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonRes(200, {
          id: 'PRE-1',
          status: 'authorized',
          next_payment_date: '2026-06-12T03:00:00.000Z',
        }),
      );
      const res = await provider.fetchPreapproval('PRE-1');
      expect(res).toEqual({
        preapprovalId: 'PRE-1',
        status: 'authorized',
        nextPaymentDate: new Date('2026-06-12T03:00:00.000Z'),
      });
    });

    it('next_payment_date ausente vira null', async () => {
      fetchMock.mockResolvedValueOnce(jsonRes(200, { id: 'PRE-2', status: 'pending' }));
      const res = await provider.fetchPreapproval('PRE-2');
      expect(res.nextPaymentDate).toBeNull();
    });
  });

  describe('cancelPreapproval', () => {
    it('PUT /preapproval/{id} com status:cancelled', async () => {
      fetchMock.mockResolvedValueOnce(jsonRes(200, { id: 'PRE-1', status: 'cancelled' }));
      await provider.cancelPreapproval('PRE-1');
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe(`${baseUrl}/preapproval/PRE-1`);
      expect(init?.method).toBe('PUT');
      expect(JSON.parse(String(init?.body))).toEqual({ status: 'cancelled' });
    });

    it('404 do MP é idempotente (não lança)', async () => {
      fetchMock.mockResolvedValueOnce(jsonRes(404, { message: 'not found' }));
      await expect(provider.cancelPreapproval('PRE-1')).resolves.toBeUndefined();
    });
  });

  describe('listPayments', () => {
    it('GET /authorized_payments/search e mapeia centavos', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonRes(200, {
          results: [
            {
              id: 'P-1',
              transaction_amount: 49.9,
              status: 'approved',
              payment_date: '2026-04-12T10:00:00.000Z',
              date_created: '2026-04-12T09:00:00.000Z',
            },
          ],
        }),
      );
      const res = await provider.listPayments('PRE-1', { page: 1, pageSize: 20 });
      expect(res).toEqual([
        {
          id: 'P-1',
          amountCents: 4990,
          status: 'approved',
          paidAt: new Date('2026-04-12T10:00:00.000Z'),
          dueAt: new Date('2026-04-12T09:00:00.000Z'),
        },
      ]);
      const [url] = fetchMock.mock.calls[0];
      const u = new URL(String(url));
      expect(u.searchParams.get('preapproval_id')).toBe('PRE-1');
      expect(u.searchParams.get('offset')).toBe('0');
      expect(u.searchParams.get('limit')).toBe('20');
    });
  });
});
```

- [ ] **Step 7.2: Rodar — espera falhar**

Run: `npm test -- mercadopago.billing-provider`
Expected: FAIL (provider ainda não existe).

- [ ] **Step 7.3: Implementar o provider**

Crie `src/modules/billing/providers/mercadopago.billing-provider.ts`:

```ts
import { HttpStatus } from '@nestjs/common';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import {
  BillingProvider,
  CreatePreapprovalInput,
  CreatePreapprovalResult,
  ListPaymentsQuery,
  RemotePayment,
  RemoteSubscription,
  RemoteSubscriptionStatus,
} from './billing.provider';

export interface MercadopagoBillingProviderOptions {
  accessToken: string;
  apiBaseUrl: string;
  returnUrl: string;
  fetchImpl?: typeof fetch;
}

const VALID_REMOTE_STATUSES: ReadonlySet<RemoteSubscriptionStatus> = new Set([
  'pending',
  'authorized',
  'paused',
  'cancelled',
]);

export class MercadopagoBillingProvider implements BillingProvider {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: MercadopagoBillingProviderOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async createPreapproval(input: CreatePreapprovalInput): Promise<CreatePreapprovalResult> {
    const body = {
      reason: input.reason,
      external_reference: input.tenantId,
      payer_email: input.payerEmail,
      back_url: this.opts.returnUrl,
      auto_recurring: {
        frequency: 1,
        frequency_type: input.frequency,
        transaction_amount: input.amountCents / 100,
        currency_id: 'BRL',
      },
    };
    const res = await this.request('POST', '/preapproval', body);
    const json = (await res.json()) as { id: string; init_point: string };
    return { preapprovalId: json.id, initPoint: json.init_point };
  }

  async fetchPreapproval(preapprovalId: string): Promise<RemoteSubscription> {
    const res = await this.request('GET', `/preapproval/${encodeURIComponent(preapprovalId)}`);
    const json = (await res.json()) as { id: string; status: string; next_payment_date?: string };
    const status: RemoteSubscriptionStatus = VALID_REMOTE_STATUSES.has(
      json.status as RemoteSubscriptionStatus,
    )
      ? (json.status as RemoteSubscriptionStatus)
      : 'pending';
    return {
      preapprovalId: json.id,
      status,
      nextPaymentDate: json.next_payment_date ? new Date(json.next_payment_date) : null,
    };
  }

  async cancelPreapproval(preapprovalId: string): Promise<void> {
    try {
      await this.request(
        'PUT',
        `/preapproval/${encodeURIComponent(preapprovalId)}`,
        { status: 'cancelled' },
      );
    } catch (err) {
      if (err instanceof DomainException && err.opts.details?.statusCode === 404) {
        return; // idempotente
      }
      throw err;
    }
  }

  async listPayments(
    preapprovalId: string,
    q: ListPaymentsQuery,
  ): Promise<RemotePayment[]> {
    const offset = (q.page - 1) * q.pageSize;
    const url = `/authorized_payments/search?preapproval_id=${encodeURIComponent(
      preapprovalId,
    )}&offset=${offset}&limit=${q.pageSize}`;
    const res = await this.request('GET', url);
    const json = (await res.json()) as {
      results: Array<{
        id: string;
        transaction_amount: number;
        status: 'approved' | 'rejected' | 'pending' | 'refunded';
        payment_date?: string;
        date_created?: string;
      }>;
    };
    return json.results.map((p) => ({
      id: p.id,
      amountCents: Math.round(p.transaction_amount * 100),
      status: p.status,
      paidAt: p.payment_date ? new Date(p.payment_date) : null,
      dueAt: p.date_created ? new Date(p.date_created) : null,
    }));
  }

  async healthCheck(): Promise<{ ok: boolean }> {
    try {
      await this.request('GET', '/preapproval/search?limit=1');
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  private async request(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) {
    const res = await this.fetchImpl(`${this.opts.apiBaseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.opts.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.ok) return res;

    const errBody = await safeJson(res);
    if (res.status === 401 || res.status === 403) {
      throw new DomainException({
        code: ErrorCodes.BILLING_PROVIDER_UNAUTHORIZED,
        message: 'Provedor de pagamento rejeitou as credenciais.',
        status: HttpStatus.BAD_GATEWAY,
        details: { statusCode: res.status, providerMessage: errBody?.message },
      });
    }
    throw new DomainException({
      code: ErrorCodes.BILLING_PROVIDER_ERROR,
      message: 'Falha ao falar com o provedor de pagamento.',
      status: HttpStatus.BAD_GATEWAY,
      details: { statusCode: res.status, providerMessage: errBody?.message },
    });
  }
}

async function safeJson(res: Response): Promise<{ message?: string } | null> {
  try {
    return (await res.json()) as { message?: string };
  } catch {
    return null;
  }
}
```

- [ ] **Step 7.4: Rodar — espera passar**

Run: `npm test -- mercadopago.billing-provider`
Expected: PASS (todas as descrições do spec).

- [ ] **Step 7.5: Commit**

```bash
git add src/modules/billing/providers/mercadopago.billing-provider.ts src/modules/billing/providers/mercadopago.billing-provider.spec.ts
git commit -m "feat(billing): MercadopagoBillingProvider via fetch with status mapping"
```

---

## Task 8: `ConsoleBillingProvider` — implementação de dev/teste

**Files:**
- Create: `src/modules/billing/providers/console.billing-provider.spec.ts`
- Create: `src/modules/billing/providers/console.billing-provider.ts`

- [ ] **Step 8.1: Escrever os testes**

Crie `src/modules/billing/providers/console.billing-provider.spec.ts`:

```ts
import { ConsoleBillingProvider } from './console.billing-provider';

describe('ConsoleBillingProvider', () => {
  let provider: ConsoleBillingProvider;

  beforeEach(() => {
    provider = new ConsoleBillingProvider({ returnUrl: 'https://k.test/return' });
  });

  it('createPreapproval gera id determinístico baseado em tenantId + counter e devolve initPoint', async () => {
    const a = await provider.createPreapproval({
      tenantId: 't1', tenantSlug: 's1', payerEmail: 'a@x.com',
      reason: 'r', amountCents: 4990, frequency: 'months',
    });
    const b = await provider.createPreapproval({
      tenantId: 't1', tenantSlug: 's1', payerEmail: 'a@x.com',
      reason: 'r', amountCents: 4990, frequency: 'months',
    });
    expect(a.preapprovalId).not.toBe(b.preapprovalId);
    expect(a.initPoint).toContain(a.preapprovalId);
  });

  it('fetchPreapproval devolve status corrente do store em memória; default pending', async () => {
    const { preapprovalId } = await provider.createPreapproval({
      tenantId: 't1', tenantSlug: 's1', payerEmail: 'a@x.com',
      reason: 'r', amountCents: 4990, frequency: 'months',
    });
    expect((await provider.fetchPreapproval(preapprovalId)).status).toBe('pending');
  });

  it('__test_advance força transição visível pra fetchPreapproval', async () => {
    const { preapprovalId } = await provider.createPreapproval({
      tenantId: 't1', tenantSlug: 's1', payerEmail: 'a@x.com',
      reason: 'r', amountCents: 4990, frequency: 'months',
    });
    provider.__test_advance(preapprovalId, 'authorized', new Date('2026-06-01T00:00:00Z'));
    const after = await provider.fetchPreapproval(preapprovalId);
    expect(after.status).toBe('authorized');
    expect(after.nextPaymentDate).toEqual(new Date('2026-06-01T00:00:00Z'));
  });

  it('cancelPreapproval marca cancelled mesmo se preapproval desconhecido', async () => {
    await expect(provider.cancelPreapproval('PRE-NA')).resolves.toBeUndefined();
    const { preapprovalId } = await provider.createPreapproval({
      tenantId: 't1', tenantSlug: 's1', payerEmail: 'a@x.com',
      reason: 'r', amountCents: 4990, frequency: 'months',
    });
    await provider.cancelPreapproval(preapprovalId);
    expect((await provider.fetchPreapproval(preapprovalId)).status).toBe('cancelled');
  });

  it('listPayments respeita page/pageSize sobre o array adicionado via __test_addPayment', async () => {
    const { preapprovalId } = await provider.createPreapproval({
      tenantId: 't1', tenantSlug: 's1', payerEmail: 'a@x.com',
      reason: 'r', amountCents: 4990, frequency: 'months',
    });
    for (let i = 0; i < 5; i++) {
      provider.__test_addPayment(preapprovalId, {
        id: `P-${i}`, amountCents: 4990, status: 'approved',
        paidAt: new Date(`2026-0${i + 1}-01T00:00:00Z`),
        dueAt: new Date(`2026-0${i + 1}-01T00:00:00Z`),
      });
    }
    const page1 = await provider.listPayments(preapprovalId, { page: 1, pageSize: 2 });
    const page2 = await provider.listPayments(preapprovalId, { page: 2, pageSize: 2 });
    expect(page1.map((p) => p.id)).toEqual(['P-0', 'P-1']);
    expect(page2.map((p) => p.id)).toEqual(['P-2', 'P-3']);
  });
});
```

- [ ] **Step 8.2: Rodar — espera falhar**

Run: `npm test -- console.billing-provider`
Expected: FAIL.

- [ ] **Step 8.3: Implementar**

Crie `src/modules/billing/providers/console.billing-provider.ts`:

```ts
import {
  BillingProvider,
  CreatePreapprovalInput,
  CreatePreapprovalResult,
  ListPaymentsQuery,
  RemotePayment,
  RemoteSubscription,
  RemoteSubscriptionStatus,
} from './billing.provider';

export interface ConsoleBillingProviderOptions {
  returnUrl: string;
}

interface ConsoleSubscriptionState {
  status: RemoteSubscriptionStatus;
  nextPaymentDate: Date | null;
  payments: RemotePayment[];
}

export class ConsoleBillingProvider implements BillingProvider {
  private counter = 0;
  private store = new Map<string, ConsoleSubscriptionState>();

  constructor(private readonly opts: ConsoleBillingProviderOptions) {}

  async createPreapproval(input: CreatePreapprovalInput): Promise<CreatePreapprovalResult> {
    this.counter += 1;
    const id = `CONSOLE-PRE-${input.tenantId}-${this.counter}`;
    this.store.set(id, { status: 'pending', nextPaymentDate: null, payments: [] });
    return { preapprovalId: id, initPoint: `${this.opts.returnUrl}?ok=1&preapproval_id=${id}` };
  }

  async fetchPreapproval(preapprovalId: string): Promise<RemoteSubscription> {
    const s = this.store.get(preapprovalId);
    if (!s) {
      return { preapprovalId, status: 'pending', nextPaymentDate: null };
    }
    return { preapprovalId, status: s.status, nextPaymentDate: s.nextPaymentDate };
  }

  async cancelPreapproval(preapprovalId: string): Promise<void> {
    const s = this.store.get(preapprovalId);
    if (s) {
      s.status = 'cancelled';
      s.nextPaymentDate = null;
    }
  }

  async listPayments(
    preapprovalId: string,
    q: ListPaymentsQuery,
  ): Promise<RemotePayment[]> {
    const s = this.store.get(preapprovalId);
    if (!s) return [];
    const start = (q.page - 1) * q.pageSize;
    return s.payments.slice(start, start + q.pageSize);
  }

  async healthCheck(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  // ---- test hooks (não fazem parte da interface) ----
  __test_advance(
    preapprovalId: string,
    status: RemoteSubscriptionStatus,
    nextPaymentDate: Date | null,
  ): void {
    const s = this.store.get(preapprovalId);
    if (!s) throw new Error(`Unknown preapproval ${preapprovalId}`);
    s.status = status;
    s.nextPaymentDate = nextPaymentDate;
  }

  __test_addPayment(preapprovalId: string, payment: RemotePayment): void {
    const s = this.store.get(preapprovalId);
    if (!s) throw new Error(`Unknown preapproval ${preapprovalId}`);
    s.payments.push(payment);
  }

  __test_reset(): void {
    this.counter = 0;
    this.store.clear();
  }
}
```

- [ ] **Step 8.4: Rodar — espera passar**

Run: `npm test -- console.billing-provider`
Expected: PASS.

- [ ] **Step 8.5: Commit**

```bash
git add src/modules/billing/providers/console.billing-provider.ts src/modules/billing/providers/console.billing-provider.spec.ts
git commit -m "feat(billing): ConsoleBillingProvider with in-memory test hooks"
```

---

## Task 9: `SubscriptionRepository`

**Files:**
- Create: `src/modules/billing/repositories/subscription.repository.ts`

- [ ] **Step 9.1: Implementar o repositório**

Crie `src/modules/billing/repositories/subscription.repository.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { Prisma, Subscription, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class SubscriptionRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByTenantId(tenantId: string): Promise<Subscription | null> {
    return this.prisma.subscription.findUnique({ where: { tenantId } });
  }

  findByPreapprovalId(preapprovalId: string): Promise<Subscription | null> {
    return this.prisma.subscription.findUnique({ where: { mpPreapprovalId: preapprovalId } });
  }

  create(data: {
    tenantId: string;
    status: SubscriptionStatus;
    trialEndsAt?: Date | null;
    tx?: Prisma.TransactionClient;
  }): Promise<Subscription> {
    const client = data.tx ?? this.prisma;
    return client.subscription.create({
      data: {
        tenantId: data.tenantId,
        status: data.status,
        trialEndsAt: data.trialEndsAt ?? null,
      },
    });
  }

  update(
    tenantId: string,
    patch: Partial<{
      status: SubscriptionStatus;
      trialEndsAt: Date | null;
      currentPeriodEnd: Date | null;
      mpPreapprovalId: string | null;
      lastSyncedAt: Date | null;
      nextSyncAt: Date | null;
    }>,
  ): Promise<Subscription> {
    return this.prisma.subscription.update({ where: { tenantId }, data: patch });
  }

  findDueForSync(now: Date, limit: number): Promise<Subscription[]> {
    return this.prisma.subscription.findMany({
      where: {
        mpPreapprovalId: { not: null },
        OR: [{ nextSyncAt: null }, { nextSyncAt: { lte: now } }],
        status: { in: ['trialing', 'active', 'past_due'] },
      },
      orderBy: { nextSyncAt: { sort: 'asc', nulls: 'first' } },
      take: limit,
    });
  }

  findExpiredTrials(now: Date): Promise<Subscription[]> {
    return this.prisma.subscription.findMany({
      where: { status: 'trialing', trialEndsAt: { lt: now } },
    });
  }

  findPastDueOverGrace(cutoff: Date): Promise<Subscription[]> {
    return this.prisma.subscription.findMany({
      where: { status: 'past_due', updatedAt: { lt: cutoff } },
    });
  }
}
```

- [ ] **Step 9.2: Lint + build**

Run: `npm run lint && npm run build`
Expected: passa.

- [ ] **Step 9.3: Commit**

```bash
git add src/modules/billing/repositories
git commit -m "feat(billing): SubscriptionRepository queries for sync and crons"
```

---

## Task 10: Constantes do módulo billing

**Files:**
- Create: `src/modules/billing/billing.constants.ts`

- [ ] **Step 10.1: Definir constantes**

Crie `src/modules/billing/billing.constants.ts`:

```ts
export const ALLOW_INACTIVE_SUBSCRIPTION_KEY = 'kairo:allow-inactive-subscription';

export const SYNC_INTERVAL_BY_STATUS: Record<
  'trialing' | 'active' | 'past_due',
  number /* ms */
> = {
  trialing: 24 * 60 * 60 * 1000,
  active: 24 * 60 * 60 * 1000,
  past_due: 2 * 60 * 60 * 1000,
};

export const SYNC_RETRY_BACKOFF_MS = 15 * 60 * 1000;

export const SYNC_BATCH_SIZE = 50;

export const BILLING_SYNC_JOB_KEY = 'billing-sync-cron';
export const TRIAL_CHECK_JOB_KEY = 'trial-check-cron';
```

- [ ] **Step 10.2: Commit**

```bash
git add src/modules/billing/billing.constants.ts
git commit -m "feat(billing): module constants for sync cadence and job keys"
```

---

## Task 11: `BillingService` — teste primeiro (núcleo)

**Files:**
- Create: `src/modules/billing/billing.service.spec.ts`
- Create: `src/modules/billing/billing.service.ts`

> **Escopo deste TDD**: cobre `startTrial`, `getSubscription`, `applyRemoteState`, `cancelSubscription`. `createCheckout`, `syncSubscription` e os métodos chamados pelo cron entram nas Tasks 12 e 14 com testes próprios — separados por arquivo de spec para manter os blocos curtos.

- [ ] **Step 11.1: Escrever os testes**

Crie `src/modules/billing/billing.service.spec.ts`:

```ts
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';
import { BillingService } from './billing.service';
import { SubscriptionRepository } from './repositories/subscription.repository';
import {
  BillingProvider,
  RemoteSubscription,
} from './providers/billing.provider';

type Mocked<T> = { [K in keyof T]: jest.Mock };

function mkRepo(): Mocked<SubscriptionRepository> {
  return {
    findByTenantId: jest.fn(),
    findByPreapprovalId: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    findDueForSync: jest.fn(),
    findExpiredTrials: jest.fn(),
    findPastDueOverGrace: jest.fn(),
  } as unknown as Mocked<SubscriptionRepository>;
}

function mkProvider(): Mocked<BillingProvider> {
  return {
    createPreapproval: jest.fn(),
    fetchPreapproval: jest.fn(),
    cancelPreapproval: jest.fn(),
    listPayments: jest.fn(),
    healthCheck: jest.fn(),
  } as unknown as Mocked<BillingProvider>;
}

function mkConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const map: Record<string, unknown> = {
    BILLING_TRIAL_DAYS: 14,
    BILLING_PAST_DUE_GRACE_DAYS: 7,
    MP_PLAN_AMOUNT_CENTS: 4990,
    MP_BILLING_FREQUENCY: 'months',
    ...overrides,
  };
  return { get: (k: string) => map[k] } as ConfigService;
}

describe('BillingService — core', () => {
  let repo: Mocked<SubscriptionRepository>;
  let provider: Mocked<BillingProvider>;
  let svc: BillingService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-12T12:00:00Z'));
    repo = mkRepo();
    provider = mkProvider();
    svc = new BillingService(repo as unknown as SubscriptionRepository, provider, mkConfig(), new Logger('test'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('startTrial', () => {
    it('cria Subscription{trialing, trialEndsAt:now+14d}', async () => {
      repo.create.mockResolvedValue({} as never);
      await svc.startTrial({ tenantId: 't1' });
      expect(repo.create).toHaveBeenCalledWith({
        tenantId: 't1',
        status: SubscriptionStatus.trialing,
        trialEndsAt: new Date('2026-05-26T12:00:00Z'),
        tx: undefined,
      });
    });

    it('aceita transação externa via tx', async () => {
      repo.create.mockResolvedValue({} as never);
      const tx = {} as never;
      await svc.startTrial({ tenantId: 't1', tx });
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ tx }));
    });
  });

  describe('getSubscription', () => {
    it('404 quando tenant não tem subscription', async () => {
      repo.findByTenantId.mockResolvedValue(null);
      await expect(svc.getSubscription('t1')).rejects.toMatchObject({
        opts: { code: 'SUBSCRIPTION_NOT_FOUND' },
      });
    });

    it('retorna view sanitizado (sem mpPreapprovalId interno)', async () => {
      repo.findByTenantId.mockResolvedValue({
        id: 'sub1', tenantId: 't1', status: 'trialing',
        trialEndsAt: new Date('2026-05-26T12:00:00Z'),
        currentPeriodEnd: null, mpPreapprovalId: 'PRE-1',
        lastSyncedAt: null, nextSyncAt: null,
        aiQuotaUsedThisMonth: 0,
        createdAt: new Date(), updatedAt: new Date(),
      } as never);
      const view = await svc.getSubscription('t1');
      expect(view).toEqual({
        status: 'trialing',
        trialEndsAt: new Date('2026-05-26T12:00:00Z'),
        currentPeriodEnd: null,
        hasCheckout: true,
        lastSyncedAt: null,
      });
    });
  });

  describe('applyRemoteState', () => {
    const baseSub = {
      id: 'sub1', tenantId: 't1',
      status: 'trialing' as SubscriptionStatus,
      trialEndsAt: new Date('2026-05-26T12:00:00Z'),
      currentPeriodEnd: null,
      mpPreapprovalId: 'PRE-1',
      lastSyncedAt: null, nextSyncAt: null,
      aiQuotaUsedThisMonth: 0,
      createdAt: new Date(), updatedAt: new Date(),
    };

    it('authorized → active e seta currentPeriodEnd + nextSyncAt = now+24h', async () => {
      const remote: RemoteSubscription = {
        preapprovalId: 'PRE-1',
        status: 'authorized',
        nextPaymentDate: new Date('2026-06-12T12:00:00Z'),
      };
      repo.update.mockResolvedValue({ ...baseSub, status: 'active' } as never);
      await svc.applyRemoteState(baseSub as never, remote);
      expect(repo.update).toHaveBeenCalledWith('t1', expect.objectContaining({
        status: 'active',
        currentPeriodEnd: new Date('2026-06-12T12:00:00Z'),
        lastSyncedAt: new Date('2026-05-12T12:00:00Z'),
        nextSyncAt: new Date('2026-05-13T12:00:00Z'),
      }));
    });

    it('paused → past_due', async () => {
      repo.update.mockResolvedValue({} as never);
      await svc.applyRemoteState(
        { ...baseSub, status: 'active' } as never,
        { preapprovalId: 'PRE-1', status: 'paused', nextPaymentDate: null },
      );
      expect(repo.update).toHaveBeenCalledWith('t1', expect.objectContaining({
        status: 'past_due',
        nextSyncAt: new Date('2026-05-12T14:00:00Z'), // +2h
      }));
    });

    it('cancelled remoto → cancelled local e nextSyncAt=null', async () => {
      repo.update.mockResolvedValue({} as never);
      await svc.applyRemoteState(
        baseSub as never,
        { preapprovalId: 'PRE-1', status: 'cancelled', nextPaymentDate: null },
      );
      expect(repo.update).toHaveBeenCalledWith('t1', expect.objectContaining({
        status: 'cancelled',
        nextSyncAt: null,
      }));
    });

    it('pending remoto não muda status local', async () => {
      await svc.applyRemoteState(
        baseSub as never,
        { preapprovalId: 'PRE-1', status: 'pending', nextPaymentDate: null },
      );
      expect(repo.update).toHaveBeenCalledWith('t1', expect.objectContaining({
        status: 'trialing',
      }));
    });

    it('nunca regride de cancelled', async () => {
      await svc.applyRemoteState(
        { ...baseSub, status: 'cancelled' } as never,
        { preapprovalId: 'PRE-1', status: 'authorized', nextPaymentDate: new Date() },
      );
      expect(repo.update).toHaveBeenCalledWith('t1', expect.objectContaining({
        status: 'cancelled',
      }));
    });
  });

  describe('cancelSubscription', () => {
    it('chama provider.cancelPreapproval e marca cancelled local', async () => {
      repo.findByTenantId.mockResolvedValue({
        tenantId: 't1', status: 'active', mpPreapprovalId: 'PRE-1',
      } as never);
      repo.update.mockResolvedValue({} as never);
      await svc.cancelSubscription('t1');
      expect(provider.cancelPreapproval).toHaveBeenCalledWith('PRE-1');
      expect(repo.update).toHaveBeenCalledWith('t1', expect.objectContaining({
        status: 'cancelled',
        nextSyncAt: null,
      }));
    });

    it('idempotente quando já cancelada', async () => {
      repo.findByTenantId.mockResolvedValue({
        tenantId: 't1', status: 'cancelled', mpPreapprovalId: 'PRE-1',
      } as never);
      repo.update.mockResolvedValue({} as never);
      await svc.cancelSubscription('t1');
      expect(repo.update).toHaveBeenCalled();
    });

    it('sem mpPreapprovalId só marca local (não chama provider)', async () => {
      repo.findByTenantId.mockResolvedValue({
        tenantId: 't1', status: 'trialing', mpPreapprovalId: null,
      } as never);
      repo.update.mockResolvedValue({} as never);
      await svc.cancelSubscription('t1');
      expect(provider.cancelPreapproval).not.toHaveBeenCalled();
      expect(repo.update).toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 11.2: Rodar — espera falhar**

Run: `npm test -- billing.service`
Expected: FAIL.

- [ ] **Step 11.3: Implementar o service (núcleo)**

Crie `src/modules/billing/billing.service.ts`:

```ts
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, Subscription, SubscriptionStatus } from '@prisma/client';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import {
  BILLING_PROVIDER,
  BillingProvider,
  RemoteSubscription,
} from './providers/billing.provider';
import { SubscriptionRepository } from './repositories/subscription.repository';
import { SYNC_INTERVAL_BY_STATUS } from './billing.constants';

export interface SubscriptionView {
  status: SubscriptionStatus;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  hasCheckout: boolean;
  lastSyncedAt: Date | null;
}

@Injectable()
export class BillingService {
  constructor(
    private readonly repo: SubscriptionRepository,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    private readonly config: ConfigService,
    private readonly logger: Logger,
  ) {}

  now(): Date {
    const override = this.config.get<number>('BILLING_NOW_OVERRIDE_MS');
    return override ? new Date(Number(override)) : new Date();
  }

  async startTrial(input: { tenantId: string; tx?: Prisma.TransactionClient }) {
    const trialDays = this.config.get<number>('BILLING_TRIAL_DAYS') ?? 14;
    const trialEndsAt = new Date(this.now().getTime() + trialDays * 24 * 60 * 60 * 1000);
    return this.repo.create({
      tenantId: input.tenantId,
      status: SubscriptionStatus.trialing,
      trialEndsAt,
      tx: input.tx,
    });
  }

  async getSubscription(tenantId: string): Promise<SubscriptionView> {
    const sub = await this.repo.findByTenantId(tenantId);
    if (!sub) {
      throw new DomainException({
        code: ErrorCodes.SUBSCRIPTION_NOT_FOUND,
        message: 'Assinatura não encontrada para o tenant.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    return {
      status: sub.status,
      trialEndsAt: sub.trialEndsAt,
      currentPeriodEnd: sub.currentPeriodEnd,
      hasCheckout: Boolean(sub.mpPreapprovalId),
      lastSyncedAt: sub.lastSyncedAt,
    };
  }

  async applyRemoteState(local: Subscription, remote: RemoteSubscription): Promise<void> {
    if (local.status === SubscriptionStatus.cancelled) {
      // Defesa: nunca regredir de cancelled.
      await this.repo.update(local.tenantId, {
        status: SubscriptionStatus.cancelled,
        nextSyncAt: null,
        lastSyncedAt: this.now(),
      });
      return;
    }

    const mappedStatus = mapRemoteStatus(remote.status, local.status);
    const nextSyncAt = computeNextSyncAt(mappedStatus, this.now());

    await this.repo.update(local.tenantId, {
      status: mappedStatus,
      currentPeriodEnd: remote.nextPaymentDate ?? local.currentPeriodEnd,
      lastSyncedAt: this.now(),
      nextSyncAt,
    });

    if (mappedStatus !== local.status) {
      this.logger.log({
        event: `subscription.${mappedStatus}`,
        tenantId: local.tenantId,
        fromStatus: local.status,
        toStatus: mappedStatus,
        mpPreapprovalId: local.mpPreapprovalId,
      });
    }
  }

  async cancelSubscription(tenantId: string): Promise<void> {
    const sub = await this.repo.findByTenantId(tenantId);
    if (!sub) {
      throw new DomainException({
        code: ErrorCodes.SUBSCRIPTION_NOT_FOUND,
        message: 'Assinatura não encontrada.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    if (sub.mpPreapprovalId) {
      await this.provider.cancelPreapproval(sub.mpPreapprovalId);
    }
    await this.repo.update(tenantId, {
      status: SubscriptionStatus.cancelled,
      nextSyncAt: null,
      lastSyncedAt: this.now(),
    });
    this.logger.log({
      event: 'subscription.cancelled',
      tenantId,
      fromStatus: sub.status,
      toStatus: 'cancelled',
      mpPreapprovalId: sub.mpPreapprovalId,
    });
  }
}

function mapRemoteStatus(
  remote: RemoteSubscription['status'],
  local: SubscriptionStatus,
): SubscriptionStatus {
  switch (remote) {
    case 'authorized':
      return SubscriptionStatus.active;
    case 'paused':
      return SubscriptionStatus.past_due;
    case 'cancelled':
      return SubscriptionStatus.cancelled;
    case 'pending':
    default:
      return local;
  }
}

function computeNextSyncAt(status: SubscriptionStatus, now: Date): Date | null {
  if (status === SubscriptionStatus.cancelled) return null;
  const interval = SYNC_INTERVAL_BY_STATUS[status as 'trialing' | 'active' | 'past_due'];
  return new Date(now.getTime() + interval);
}
```

- [ ] **Step 11.4: Rodar — espera passar**

Run: `npm test -- billing.service`
Expected: PASS.

- [ ] **Step 11.5: Commit**

```bash
git add src/modules/billing/billing.service.ts src/modules/billing/billing.service.spec.ts
git commit -m "feat(billing): BillingService core (startTrial, getSubscription, applyRemoteState, cancel)"
```

---

## Task 12: `BillingService` — checkout + sync on-demand (TDD continua)

**Files:**
- Create: `src/modules/billing/billing.checkout.spec.ts`
- Modify: `src/modules/billing/billing.service.ts`

- [ ] **Step 12.1: Escrever os testes do checkout/sync**

Crie `src/modules/billing/billing.checkout.spec.ts`:

```ts
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { BillingService } from './billing.service';
import { SubscriptionRepository } from './repositories/subscription.repository';
import { BillingProvider } from './providers/billing.provider';

function mkRepo() {
  return {
    findByTenantId: jest.fn(),
    findByPreapprovalId: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    findDueForSync: jest.fn(),
    findExpiredTrials: jest.fn(),
    findPastDueOverGrace: jest.fn(),
  };
}
function mkProvider() {
  return {
    createPreapproval: jest.fn(),
    fetchPreapproval: jest.fn(),
    cancelPreapproval: jest.fn(),
    listPayments: jest.fn(),
    healthCheck: jest.fn(),
  };
}
function mkConfig(): ConfigService {
  const map: Record<string, unknown> = {
    BILLING_TRIAL_DAYS: 14,
    MP_PLAN_AMOUNT_CENTS: 4990,
    MP_BILLING_FREQUENCY: 'months',
  };
  return { get: (k: string) => map[k] } as ConfigService;
}

describe('BillingService — checkout/sync', () => {
  let repo: ReturnType<typeof mkRepo>;
  let provider: ReturnType<typeof mkProvider>;
  let svc: BillingService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-12T12:00:00Z'));
    repo = mkRepo();
    provider = mkProvider();
    svc = new BillingService(repo as never, provider as never, mkConfig(), new Logger('test'));
  });
  afterEach(() => jest.useRealTimers());

  describe('createCheckout', () => {
    it('SUBSCRIPTION_ALREADY_ACTIVE se status=active', async () => {
      repo.findByTenantId.mockResolvedValue({
        tenantId: 't1', status: 'active', mpPreapprovalId: 'PRE-1',
      });
      await expect(
        svc.createCheckout({ tenantId: 't1', tenantSlug: 's', ownerEmail: 'a@x.com' }),
      ).rejects.toMatchObject({ opts: { code: 'SUBSCRIPTION_ALREADY_ACTIVE' } });
    });

    it('trialing sem preapproval → cria preapproval e salva id', async () => {
      repo.findByTenantId.mockResolvedValue({
        tenantId: 't1', status: 'trialing', mpPreapprovalId: null,
      });
      provider.createPreapproval.mockResolvedValue({
        preapprovalId: 'PRE-NEW', initPoint: 'https://mp/x',
      });
      repo.update.mockResolvedValue({} as never);
      const out = await svc.createCheckout({
        tenantId: 't1', tenantSlug: 'demo', ownerEmail: 'a@x.com',
      });
      expect(out).toEqual({ initPoint: 'https://mp/x' });
      expect(provider.createPreapproval).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: 't1', tenantSlug: 'demo', payerEmail: 'a@x.com',
        amountCents: 4990, frequency: 'months',
        reason: 'Assinatura KairoBarber - demo',
      }));
      expect(repo.update).toHaveBeenCalledWith('t1', expect.objectContaining({
        mpPreapprovalId: 'PRE-NEW',
        nextSyncAt: new Date('2026-05-12T13:00:00Z'), // +1h sondagem agressiva pós-checkout
      }));
    });

    it('past_due ou cancelled → cria preapproval novo (substitui)', async () => {
      repo.findByTenantId.mockResolvedValue({
        tenantId: 't1', status: 'past_due', mpPreapprovalId: 'PRE-OLD',
      });
      provider.createPreapproval.mockResolvedValue({
        preapprovalId: 'PRE-NEW2', initPoint: 'https://mp/y',
      });
      repo.update.mockResolvedValue({} as never);
      const out = await svc.createCheckout({
        tenantId: 't1', tenantSlug: 'd', ownerEmail: 'a@x.com',
      });
      expect(out).toEqual({ initPoint: 'https://mp/y' });
      expect(repo.update).toHaveBeenCalledWith('t1', expect.objectContaining({
        mpPreapprovalId: 'PRE-NEW2',
        status: 'trialing', // retorna pro fluxo trial enquanto MP confirma
      }));
    });

    it('SUBSCRIPTION_NOT_FOUND se tenant não tem subscription', async () => {
      repo.findByTenantId.mockResolvedValue(null);
      await expect(
        svc.createCheckout({ tenantId: 't1', tenantSlug: 's', ownerEmail: 'a@x.com' }),
      ).rejects.toMatchObject({ opts: { code: 'SUBSCRIPTION_NOT_FOUND' } });
    });
  });

  describe('syncSubscription (on-demand)', () => {
    it('busca remoto e aplica via applyRemoteState', async () => {
      repo.findByTenantId.mockResolvedValue({
        tenantId: 't1', status: 'trialing', mpPreapprovalId: 'PRE-1',
        currentPeriodEnd: null, trialEndsAt: null,
      });
      provider.fetchPreapproval.mockResolvedValue({
        preapprovalId: 'PRE-1', status: 'authorized',
        nextPaymentDate: new Date('2026-06-12T12:00:00Z'),
      });
      repo.update.mockResolvedValue({} as never);
      await svc.syncSubscription('t1');
      expect(provider.fetchPreapproval).toHaveBeenCalledWith('PRE-1');
      expect(repo.update).toHaveBeenCalledWith('t1', expect.objectContaining({
        status: 'active',
        currentPeriodEnd: new Date('2026-06-12T12:00:00Z'),
      }));
    });

    it('sem mpPreapprovalId → no-op', async () => {
      repo.findByTenantId.mockResolvedValue({
        tenantId: 't1', status: 'trialing', mpPreapprovalId: null,
      });
      await svc.syncSubscription('t1');
      expect(provider.fetchPreapproval).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
    });
  });

  describe('listInvoices', () => {
    it('proxia provider.listPayments e mapeia para DTO', async () => {
      repo.findByTenantId.mockResolvedValue({
        tenantId: 't1', mpPreapprovalId: 'PRE-1',
      });
      provider.listPayments.mockResolvedValue([
        { id: 'P-1', amountCents: 4990, status: 'approved',
          paidAt: new Date('2026-04-12T10:00:00Z'),
          dueAt: new Date('2026-04-12T09:00:00Z') },
      ]);
      const out = await svc.listInvoices('t1', { page: 1, pageSize: 20 });
      expect(out).toEqual([
        { id: 'P-1', amountCents: 4990, status: 'approved',
          paidAt: new Date('2026-04-12T10:00:00Z'),
          dueAt: new Date('2026-04-12T09:00:00Z') },
      ]);
    });

    it('sem preapproval → lista vazia (sem chamar provider)', async () => {
      repo.findByTenantId.mockResolvedValue({ tenantId: 't1', mpPreapprovalId: null });
      const out = await svc.listInvoices('t1', { page: 1, pageSize: 20 });
      expect(out).toEqual([]);
      expect(provider.listPayments).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 12.2: Rodar — espera falhar**

Run: `npm test -- billing.checkout`
Expected: FAIL (métodos novos não existem).

- [ ] **Step 12.3: Estender `BillingService` com os métodos**

Em `src/modules/billing/billing.service.ts`, **acrescente dentro da classe** (antes do último `}`):

```ts
  async createCheckout(input: {
    tenantId: string;
    tenantSlug: string;
    ownerEmail: string;
  }): Promise<{ initPoint: string }> {
    const sub = await this.repo.findByTenantId(input.tenantId);
    if (!sub) {
      throw new DomainException({
        code: ErrorCodes.SUBSCRIPTION_NOT_FOUND,
        message: 'Assinatura não encontrada.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    if (sub.status === SubscriptionStatus.active) {
      throw new DomainException({
        code: ErrorCodes.SUBSCRIPTION_ALREADY_ACTIVE,
        message: 'Assinatura já está ativa.',
        status: HttpStatus.CONFLICT,
      });
    }

    const amountCents = this.config.get<number>('MP_PLAN_AMOUNT_CENTS') ?? 4990;
    const created = await this.provider.createPreapproval({
      tenantId: input.tenantId,
      tenantSlug: input.tenantSlug,
      payerEmail: input.ownerEmail,
      reason: `Assinatura KairoBarber - ${input.tenantSlug}`,
      amountCents,
      frequency: 'months',
    });

    const nextSyncAt = new Date(this.now().getTime() + 60 * 60 * 1000); // sondagem pós-checkout em 1h
    await this.repo.update(input.tenantId, {
      mpPreapprovalId: created.preapprovalId,
      status: SubscriptionStatus.trialing,
      nextSyncAt,
    });

    this.logger.log({
      event: 'subscription.checkout_created',
      tenantId: input.tenantId,
      mpPreapprovalId: created.preapprovalId,
    });

    return { initPoint: created.initPoint };
  }

  async syncSubscription(tenantId: string): Promise<void> {
    const sub = await this.repo.findByTenantId(tenantId);
    if (!sub || !sub.mpPreapprovalId) return;
    const remote = await this.provider.fetchPreapproval(sub.mpPreapprovalId);
    await this.applyRemoteState(sub, remote);
  }

  async listInvoices(
    tenantId: string,
    q: { page: number; pageSize: number },
  ): Promise<Array<{
    id: string;
    amountCents: number;
    status: 'approved' | 'rejected' | 'pending' | 'refunded';
    paidAt: Date | null;
    dueAt: Date | null;
  }>> {
    const sub = await this.repo.findByTenantId(tenantId);
    if (!sub?.mpPreapprovalId) return [];
    return this.provider.listPayments(sub.mpPreapprovalId, q);
  }
```

- [ ] **Step 12.4: Rodar — espera passar**

Run: `npm test -- billing.checkout && npm test -- billing.service`
Expected: PASS em ambos.

- [ ] **Step 12.5: Commit**

```bash
git add src/modules/billing/billing.service.ts src/modules/billing/billing.checkout.spec.ts
git commit -m "feat(billing): createCheckout, syncSubscription, listInvoices"
```

---

## Task 13: DTOs do controller

**Files:**
- Create: `src/modules/billing/dto/create-checkout.dto.ts`
- Create: `src/modules/billing/dto/cancel-subscription.dto.ts`
- Create: `src/modules/billing/dto/subscription-view.dto.ts`
- Create: `src/modules/billing/dto/list-invoices-query.dto.ts`

- [ ] **Step 13.1: `create-checkout.dto.ts`**

```ts
// Sem campos no corpo — endpoint deriva tudo do tenant autenticado. Mantemos a classe vazia
// para permitir `class-validator` validar `forbidNonWhitelisted` no payload.
export class CreateCheckoutDto {}
```

- [ ] **Step 13.2: `cancel-subscription.dto.ts`**

```ts
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CancelSubscriptionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
```

- [ ] **Step 13.3: `subscription-view.dto.ts`**

```ts
import { SubscriptionStatus } from '@prisma/client';

export class SubscriptionViewDto {
  status!: SubscriptionStatus;
  trialEndsAt!: string | null;
  currentPeriodEnd!: string | null;
  hasCheckout!: boolean;
  lastSyncedAt!: string | null;
}
```

- [ ] **Step 13.4: `list-invoices-query.dto.ts`**

```ts
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class ListInvoicesQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page: number = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50)
  pageSize: number = 20;
}
```

- [ ] **Step 13.5: Commit**

```bash
git add src/modules/billing/dto
git commit -m "feat(billing): DTOs for checkout, cancel, subscription view, invoices"
```

---

## Task 14: Decorator `@AllowInactiveSubscription` + `SubscriptionActiveGuard`

**Files:**
- Create: `src/common/decorators/allow-inactive-subscription.decorator.ts`
- Create: `src/common/guards/subscription-active.guard.spec.ts`
- Create: `src/common/guards/subscription-active.guard.ts`

- [ ] **Step 14.1: Decorator**

Crie `src/common/decorators/allow-inactive-subscription.decorator.ts`:

```ts
import { SetMetadata } from '@nestjs/common';
import { ALLOW_INACTIVE_SUBSCRIPTION_KEY } from 'src/modules/billing/billing.constants';

export const AllowInactiveSubscription = () =>
  SetMetadata(ALLOW_INACTIVE_SUBSCRIPTION_KEY, true);
```

- [ ] **Step 14.2: Spec do guard**

Crie `src/common/guards/subscription-active.guard.spec.ts`:

```ts
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
    await expect(
      guard.canActivate(mkContext({ user: { tenantId: 't1' } })),
    ).rejects.toMatchObject({ opts: { code: 'SUBSCRIPTION_INACTIVE', status: 402 } });
  });

  it('SUBSCRIPTION_NOT_FOUND (404) quando subscription ausente', async () => {
    repo.findByTenantId.mockResolvedValue(null);
    await expect(
      guard.canActivate(mkContext({ user: { tenantId: 't1' } })),
    ).rejects.toMatchObject({ opts: { code: 'SUBSCRIPTION_NOT_FOUND' } });
  });
});
```

- [ ] **Step 14.3: Rodar — espera falhar**

Run: `npm test -- subscription-active.guard`
Expected: FAIL.

- [ ] **Step 14.4: Implementar o guard**

Crie `src/common/guards/subscription-active.guard.ts`:

```ts
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
```

- [ ] **Step 14.5: Rodar — espera passar**

Run: `npm test -- subscription-active.guard`
Expected: PASS.

- [ ] **Step 14.6: Commit**

```bash
git add src/common/decorators/allow-inactive-subscription.decorator.ts src/common/guards/subscription-active.guard.ts src/common/guards/subscription-active.guard.spec.ts
git commit -m "feat(billing): SubscriptionActiveGuard + AllowInactiveSubscription decorator"
```

---

## Task 15: `BillingController` — endpoints `/admin/billing/*`

**Files:**
- Create: `src/modules/billing/billing.controller.ts`

- [ ] **Step 15.1: Implementar o controller**

Crie `src/modules/billing/billing.controller.ts`:

```ts
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentTenant } from 'src/common/decorators/current-tenant.decorator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { Roles } from 'src/common/decorators/roles.decorator';
import { AllowInactiveSubscription } from 'src/common/decorators/allow-inactive-subscription.decorator';
import { UserRole } from '@prisma/client';
import { BillingService } from './billing.service';
import { CancelSubscriptionDto } from './dto/cancel-subscription.dto';
import { ListInvoicesQueryDto } from './dto/list-invoices-query.dto';
import { CreateCheckoutDto } from './dto/create-checkout.dto';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Controller('admin/billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('subscription')
  @AllowInactiveSubscription()
  async getSubscription(@CurrentTenant() tenantId: string) {
    return this.billing.getSubscription(tenantId);
  }

  @Post('checkout')
  @AllowInactiveSubscription()
  @Roles(UserRole.tenant_owner)
  @HttpCode(HttpStatus.OK)
  async checkout(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { id: string; email: string },
    @Body() _dto: CreateCheckoutDto,
  ) {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { slug: true },
    });
    return this.billing.createCheckout({
      tenantId,
      tenantSlug: tenant.slug,
      ownerEmail: user.email,
    });
  }

  @Post('sync')
  @AllowInactiveSubscription()
  @HttpCode(HttpStatus.OK)
  async sync(@CurrentTenant() tenantId: string) {
    await this.billing.syncSubscription(tenantId);
    return this.billing.getSubscription(tenantId);
  }

  @Post('cancel')
  @Roles(UserRole.tenant_owner)
  @HttpCode(HttpStatus.OK)
  async cancel(
    @CurrentTenant() tenantId: string,
    @Body() _dto: CancelSubscriptionDto,
  ) {
    await this.billing.cancelSubscription(tenantId);
    return { ok: true };
  }

  @Get('invoices')
  async invoices(
    @CurrentTenant() tenantId: string,
    @Query() q: ListInvoicesQueryDto,
  ) {
    return this.billing.listInvoices(tenantId, q);
  }
}
```

- [ ] **Step 15.2: Lint + build**

Run: `npm run lint && npm run build`
Expected: passa.

- [ ] **Step 15.3: Commit**

```bash
git add src/modules/billing/billing.controller.ts
git commit -m "feat(billing): /admin/billing controller (subscription, checkout, sync, cancel, invoices)"
```

---

## Task 16: `BillingService` — crons (`runBillingSync` e `runTrialCheck`)

**Files:**
- Create: `src/modules/billing/billing.cron.spec.ts`
- Modify: `src/modules/billing/billing.service.ts`

- [ ] **Step 16.1: Escrever os testes**

Crie `src/modules/billing/billing.cron.spec.ts`:

```ts
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { BillingService } from './billing.service';

function mkRepo() {
  return {
    findByTenantId: jest.fn(),
    findByPreapprovalId: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    findDueForSync: jest.fn(),
    findExpiredTrials: jest.fn(),
    findPastDueOverGrace: jest.fn(),
  };
}
function mkProvider() {
  return {
    createPreapproval: jest.fn(),
    fetchPreapproval: jest.fn(),
    cancelPreapproval: jest.fn(),
    listPayments: jest.fn(),
    healthCheck: jest.fn(),
  };
}
function mkConfig(): ConfigService {
  const map: Record<string, unknown> = {
    BILLING_TRIAL_DAYS: 14,
    BILLING_PAST_DUE_GRACE_DAYS: 7,
  };
  return { get: (k: string) => map[k] } as ConfigService;
}

describe('BillingService — crons', () => {
  let repo: ReturnType<typeof mkRepo>;
  let provider: ReturnType<typeof mkProvider>;
  let svc: BillingService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-12T12:00:00Z'));
    repo = mkRepo();
    provider = mkProvider();
    svc = new BillingService(repo as never, provider as never, mkConfig(), new Logger('test'));
  });
  afterEach(() => jest.useRealTimers());

  describe('runBillingSync', () => {
    it('processa cada subscription elegível e aplica remoteState', async () => {
      repo.findDueForSync.mockResolvedValue([
        { tenantId: 't1', status: 'trialing', mpPreapprovalId: 'PRE-1' },
        { tenantId: 't2', status: 'active', mpPreapprovalId: 'PRE-2' },
      ]);
      provider.fetchPreapproval
        .mockResolvedValueOnce({ preapprovalId: 'PRE-1', status: 'authorized', nextPaymentDate: new Date('2026-06-12T12:00:00Z') })
        .mockResolvedValueOnce({ preapprovalId: 'PRE-2', status: 'paused', nextPaymentDate: null });
      repo.update.mockResolvedValue({} as never);

      const stats = await svc.runBillingSync();

      expect(stats).toEqual({ processed: 2, failed: 0 });
      expect(provider.fetchPreapproval).toHaveBeenNthCalledWith(1, 'PRE-1');
      expect(provider.fetchPreapproval).toHaveBeenNthCalledWith(2, 'PRE-2');
      expect(repo.update).toHaveBeenNthCalledWith(1, 't1', expect.objectContaining({ status: 'active' }));
      expect(repo.update).toHaveBeenNthCalledWith(2, 't2', expect.objectContaining({ status: 'past_due' }));
    });

    it('falha individual recua nextSyncAt em 15 min, segue para o próximo', async () => {
      repo.findDueForSync.mockResolvedValue([
        { tenantId: 't1', status: 'active', mpPreapprovalId: 'PRE-1' },
        { tenantId: 't2', status: 'active', mpPreapprovalId: 'PRE-2' },
      ]);
      provider.fetchPreapproval
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({ preapprovalId: 'PRE-2', status: 'authorized', nextPaymentDate: new Date('2026-06-12T12:00:00Z') });
      repo.update.mockResolvedValue({} as never);

      const stats = await svc.runBillingSync();

      expect(stats).toEqual({ processed: 1, failed: 1 });
      expect(repo.update).toHaveBeenNthCalledWith(1, 't1', expect.objectContaining({
        nextSyncAt: new Date('2026-05-12T12:15:00Z'),
      }));
      expect(repo.update).toHaveBeenNthCalledWith(2, 't2', expect.objectContaining({ status: 'active' }));
    });
  });

  describe('runTrialCheck', () => {
    it('trial expirado → past_due', async () => {
      repo.findExpiredTrials.mockResolvedValue([
        { tenantId: 't1', status: 'trialing', mpPreapprovalId: null,
          trialEndsAt: new Date('2026-05-11T00:00:00Z'), updatedAt: new Date('2026-04-28T00:00:00Z') },
      ]);
      repo.findPastDueOverGrace.mockResolvedValue([]);
      repo.update.mockResolvedValue({} as never);

      const stats = await svc.runTrialCheck();

      expect(stats).toEqual({ trialExpired: 1, graceExpired: 0 });
      expect(repo.update).toHaveBeenCalledWith('t1', expect.objectContaining({
        status: 'past_due',
      }));
    });

    it('past_due > graça (default 7d) → cancelled, cutoff = now - 7d', async () => {
      repo.findExpiredTrials.mockResolvedValue([]);
      repo.findPastDueOverGrace.mockImplementation(async (cutoff: Date) => {
        expect(cutoff).toEqual(new Date('2026-05-05T12:00:00Z'));
        return [{ tenantId: 't2', status: 'past_due', mpPreapprovalId: 'PRE-2' }];
      });
      repo.update.mockResolvedValue({} as never);

      const stats = await svc.runTrialCheck();

      expect(stats).toEqual({ trialExpired: 0, graceExpired: 1 });
      expect(repo.update).toHaveBeenCalledWith('t2', expect.objectContaining({
        status: 'cancelled',
        nextSyncAt: null,
      }));
    });
  });
});
```

- [ ] **Step 16.2: Rodar — espera falhar**

Run: `npm test -- billing.cron`
Expected: FAIL.

- [ ] **Step 16.3: Implementar os métodos no service**

Em `src/modules/billing/billing.service.ts`, **acrescente os imports e os métodos** ao final da classe:

```ts
import { SubscriptionStatus } from '@prisma/client';
import { SYNC_BATCH_SIZE, SYNC_RETRY_BACKOFF_MS } from './billing.constants';
```

(Se já existirem, não duplique.)

Métodos:

```ts
  async runBillingSync(): Promise<{ processed: number; failed: number }> {
    const now = this.now();
    const subs = await this.repo.findDueForSync(now, SYNC_BATCH_SIZE);
    let processed = 0;
    let failed = 0;
    for (const sub of subs) {
      try {
        const remote = await this.provider.fetchPreapproval(sub.mpPreapprovalId!);
        await this.applyRemoteState(sub, remote);
        processed += 1;
      } catch (err) {
        failed += 1;
        this.logger.warn({
          event: 'subscription.sync_failed',
          tenantId: sub.tenantId,
          mpPreapprovalId: sub.mpPreapprovalId,
          error: (err as Error).message,
        });
        await this.repo.update(sub.tenantId, {
          nextSyncAt: new Date(now.getTime() + SYNC_RETRY_BACKOFF_MS),
        });
      }
    }
    this.logger.log({ event: 'billing.sync_cycle', processed, failed });
    return { processed, failed };
  }

  async runTrialCheck(): Promise<{ trialExpired: number; graceExpired: number }> {
    const now = this.now();
    const trialEnded = await this.repo.findExpiredTrials(now);
    for (const sub of trialEnded) {
      await this.repo.update(sub.tenantId, {
        status: SubscriptionStatus.past_due,
        nextSyncAt: sub.mpPreapprovalId ? new Date(now.getTime() + 2 * 60 * 60 * 1000) : null,
      });
      this.logger.log({
        event: 'subscription.trial_expired',
        tenantId: sub.tenantId,
        fromStatus: 'trialing',
        toStatus: 'past_due',
      });
    }

    const graceDays = this.config.get<number>('BILLING_PAST_DUE_GRACE_DAYS') ?? 7;
    const cutoff = new Date(now.getTime() - graceDays * 24 * 60 * 60 * 1000);
    const overGrace = await this.repo.findPastDueOverGrace(cutoff);
    for (const sub of overGrace) {
      await this.repo.update(sub.tenantId, {
        status: SubscriptionStatus.cancelled,
        nextSyncAt: null,
      });
      this.logger.log({
        event: 'subscription.grace_period_expired',
        tenantId: sub.tenantId,
        fromStatus: 'past_due',
        toStatus: 'cancelled',
        mpPreapprovalId: sub.mpPreapprovalId,
      });
    }

    return { trialExpired: trialEnded.length, graceExpired: overGrace.length };
  }
```

- [ ] **Step 16.4: Rodar — espera passar**

Run: `npm test -- billing.cron && npm test -- billing.service && npm test -- billing.checkout`
Expected: PASS em todos.

- [ ] **Step 16.5: Commit**

```bash
git add src/modules/billing/billing.service.ts src/modules/billing/billing.cron.spec.ts
git commit -m "feat(billing): runBillingSync and runTrialCheck cron entry points"
```

---

## Task 17: `BillingProcessor` — worker BullMQ

**Files:**
- Create: `src/modules/billing/billing.processor.spec.ts`
- Create: `src/modules/billing/billing.processor.ts`

- [ ] **Step 17.1: Escrever os testes**

Crie `src/modules/billing/billing.processor.spec.ts`:

```ts
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { BillingProcessor } from './billing.processor';
import { BillingService } from './billing.service';
import { JOB_BILLING_SYNC, JOB_TRIAL_CHECK } from 'src/infra/queues/queue-names';

function mkJob(name: string): Job {
  return { name, data: {} } as unknown as Job;
}

describe('BillingProcessor', () => {
  let svc: { runBillingSync: jest.Mock; runTrialCheck: jest.Mock };
  let processor: BillingProcessor;

  beforeEach(() => {
    svc = {
      runBillingSync: jest.fn().mockResolvedValue({ processed: 3, failed: 0 }),
      runTrialCheck: jest.fn().mockResolvedValue({ trialExpired: 1, graceExpired: 0 }),
    };
    processor = new BillingProcessor(svc as never as BillingService, new Logger('test'));
  });

  it('dispara runBillingSync no job billing-sync', async () => {
    const res = await processor.process(mkJob(JOB_BILLING_SYNC));
    expect(svc.runBillingSync).toHaveBeenCalled();
    expect(res).toEqual({ processed: 3, failed: 0 });
  });

  it('dispara runTrialCheck no job trial-check', async () => {
    const res = await processor.process(mkJob(JOB_TRIAL_CHECK));
    expect(svc.runTrialCheck).toHaveBeenCalled();
    expect(res).toEqual({ trialExpired: 1, graceExpired: 0 });
  });

  it('job name desconhecido lança', async () => {
    await expect(processor.process(mkJob('outro'))).rejects.toThrow(/unknown job/i);
  });
});
```

- [ ] **Step 17.2: Rodar — espera falhar**

Run: `npm test -- billing.processor`
Expected: FAIL.

- [ ] **Step 17.3: Implementar**

Crie `src/modules/billing/billing.processor.ts`:

```ts
import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUE_BILLING, JOB_BILLING_SYNC, JOB_TRIAL_CHECK } from 'src/infra/queues/queue-names';
import { BillingService } from './billing.service';

@Processor(QUEUE_BILLING)
export class BillingProcessor extends WorkerHost {
  constructor(
    private readonly billing: BillingService,
    private readonly logger: Logger,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    this.logger.log({ event: 'billing.job_started', name: job.name });
    if (job.name === JOB_BILLING_SYNC) {
      return this.billing.runBillingSync();
    }
    if (job.name === JOB_TRIAL_CHECK) {
      return this.billing.runTrialCheck();
    }
    throw new Error(`unknown job: ${job.name}`);
  }
}
```

- [ ] **Step 17.4: Rodar — espera passar**

Run: `npm test -- billing.processor`
Expected: PASS.

- [ ] **Step 17.5: Commit**

```bash
git add src/modules/billing/billing.processor.ts src/modules/billing/billing.processor.spec.ts
git commit -m "feat(billing): BullMQ processor dispatching billing-sync and trial-check"
```

---

## Task 18: `BillingSchedules` — registra repeatable jobs no bootstrap

**Files:**
- Create: `src/modules/billing/billing.schedules.ts`

- [ ] **Step 18.1: Implementar**

Crie `src/modules/billing/billing.schedules.ts`:

```ts
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import {
  JOB_BILLING_SYNC,
  JOB_TRIAL_CHECK,
  QUEUE_BILLING,
} from 'src/infra/queues/queue-names';
import { BILLING_SYNC_JOB_KEY, TRIAL_CHECK_JOB_KEY } from './billing.constants';

@Injectable()
export class BillingSchedules implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(BillingSchedules.name);

  constructor(
    @InjectQueue(QUEUE_BILLING) private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.get<string>('NODE_ENV') === 'test') {
      this.logger.log({ event: 'billing.schedules_skipped', reason: 'NODE_ENV=test' });
      return;
    }
    const syncCron = this.config.get<string>('BILLING_SYNC_CRON') ?? '0 6,18 * * *';
    const trialCron = this.config.get<string>('BILLING_TRIAL_CHECK_CRON') ?? '15 6 * * *';

    await this.queue.upsertJobScheduler(
      BILLING_SYNC_JOB_KEY,
      { pattern: syncCron, tz: 'UTC' },
      { name: JOB_BILLING_SYNC, data: {} },
    );
    await this.queue.upsertJobScheduler(
      TRIAL_CHECK_JOB_KEY,
      { pattern: trialCron, tz: 'UTC' },
      { name: JOB_TRIAL_CHECK, data: {} },
    );

    this.logger.log({
      event: 'billing.schedules_registered',
      syncCron, trialCron,
    });
  }

  async onApplicationShutdown(): Promise<void> {
    // Não removemos os schedulers — eles vivem no Redis e devem persistir entre deploys.
  }
}
```

- [ ] **Step 18.2: Lint + build**

Run: `npm run lint && npm run build`
Expected: passa.

- [ ] **Step 18.3: Commit**

```bash
git add src/modules/billing/billing.schedules.ts
git commit -m "feat(billing): register repeatable schedulers for sync and trial-check"
```

---

## Task 19: `BillingModule` — fiação

**Files:**
- Create: `src/modules/billing/billing.module.ts`

- [ ] **Step 19.1: Implementar**

Crie `src/modules/billing/billing.module.ts`:

```ts
import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { QUEUE_BILLING } from 'src/infra/queues/queue-names';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { RedisModule } from 'src/infra/redis/redis.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { BillingProcessor } from './billing.processor';
import { BillingSchedules } from './billing.schedules';
import { SubscriptionRepository } from './repositories/subscription.repository';
import {
  BILLING_PROVIDER,
  BillingProvider,
} from './providers/billing.provider';
import { MercadopagoBillingProvider } from './providers/mercadopago.billing-provider';
import { ConsoleBillingProvider } from './providers/console.billing-provider';

@Module({
  imports: [
    PrismaModule,
    RedisModule,
    BullModule.registerQueue({ name: QUEUE_BILLING }),
  ],
  controllers: [BillingController],
  providers: [
    BillingService,
    SubscriptionRepository,
    BillingProcessor,
    BillingSchedules,
    Logger,
    {
      provide: BILLING_PROVIDER,
      useFactory: (cfg: ConfigService): BillingProvider => {
        const provider = cfg.get<string>('BILLING_PROVIDER');
        if (provider === 'console') {
          return new ConsoleBillingProvider({
            returnUrl: cfg.get<string>('MP_RETURN_URL') ?? 'http://localhost:3001/admin/billing/return',
          });
        }
        if (provider === 'mercadopago') {
          const accessToken = cfg.get<string>('MP_ACCESS_TOKEN');
          const apiBaseUrl = cfg.get<string>('MP_API_BASE_URL');
          const returnUrl = cfg.get<string>('MP_RETURN_URL');
          if (!accessToken || !apiBaseUrl || !returnUrl) {
            throw new Error(
              'MP_ACCESS_TOKEN, MP_API_BASE_URL and MP_RETURN_URL are required when BILLING_PROVIDER=mercadopago',
            );
          }
          return new MercadopagoBillingProvider({ accessToken, apiBaseUrl, returnUrl });
        }
        throw new Error(`Unsupported BILLING_PROVIDER: ${provider}`);
      },
      inject: [ConfigService],
    },
  ],
  exports: [BillingService, SubscriptionRepository],
})
export class BillingModule {}
```

- [ ] **Step 19.2: Lint + build**

Run: `npm run lint && npm run build`
Expected: passa.

- [ ] **Step 19.3: Commit**

```bash
git add src/modules/billing/billing.module.ts
git commit -m "feat(billing): BillingModule with provider factory and queue wiring"
```

---

## Task 20: Integrar `BillingModule` + `SubscriptionActiveGuard` no `AppModule`

**Files:**
- Modify: `src/app.module.ts`

- [ ] **Step 20.1: Registrar tudo**

Em `src/app.module.ts`, adicione os imports e o guard global:

```ts
import { APP_GUARD } from '@nestjs/core';
import { BillingModule } from './modules/billing/billing.module';
import { SubscriptionActiveGuard } from './common/guards/subscription-active.guard';

@Module({
  imports: [
    // ... existentes ...
    RedisModule,
    QueuesModule,
    BillingModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: SubscriptionActiveGuard },
  ],
})
export class AppModule {}
```

> **Ordem dos guards globais**: Nest executa em ordem de declaração. `ThrottlerGuard` primeiro (corta DDoS antes de tocar DB), depois `SubscriptionActiveGuard`. O `JwtAuthGuard` global da Fase 1 roda antes via `APP_GUARD` declarado em `AuthModule` — não mexer.

- [ ] **Step 20.2: Boot sanity check**

Run:
```bash
docker compose up -d redis postgres
REDIS_URL=redis://localhost:6379 BILLING_PROVIDER=console NODE_ENV=development npm run build && node -e "require('./dist/app.module.js')"
```
Expected: sem erro de DI / sem erro de boot.

- [ ] **Step 20.3: Commit**

```bash
git add src/app.module.ts
git commit -m "feat(app): wire BillingModule and SubscriptionActiveGuard"
```

---

## Task 21: Refatorar `AuthService.registerOwner` para delegar `startTrial`

**Files:**
- Modify: `src/modules/auth/auth.service.ts`
- Modify: `src/modules/auth/auth.module.ts`

- [ ] **Step 21.1: Atualizar o módulo de auth para importar `BillingModule`**

Em `src/modules/auth/auth.module.ts`, adicione o import:

```ts
import { BillingModule } from 'src/modules/billing/billing.module';

@Module({
  imports: [ /* existentes */, BillingModule ],
  // ...
})
```

- [ ] **Step 21.2: Atualizar `auth.service.ts`**

Em `src/modules/auth/auth.service.ts`, injete `BillingService` no construtor:

```ts
import { BillingService } from 'src/modules/billing/billing.service';

constructor(
  // ... existentes ...
  private readonly billing: BillingService,
) {}
```

Substitua o bloco que cria a subscription dentro de `registerOwner` (linhas atuais 83-89):

```ts
await tx.subscription.create({
  data: {
    tenantId: tenant.id,
    status: SubscriptionStatus.trialing,
    trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
  },
});
```

Por:

```ts
await this.billing.startTrial({ tenantId: tenant.id, tx });
```

E remova o import direto de `SubscriptionStatus` se ficar sem uso.

- [ ] **Step 21.3: Rodar tudo**

Run: `npm run lint && npm run test && npm run test:e2e -- auth`
Expected: PASS (auth E2E continua verde — comportamento observável idêntico).

- [ ] **Step 21.4: Commit**

```bash
git add src/modules/auth/auth.service.ts src/modules/auth/auth.module.ts
git commit -m "refactor(auth): delegate Subscription.startTrial to BillingService"
```

---

## Task 22: Helpers de teste de billing

**Files:**
- Create: `test/support/billing.ts`
- Modify: `test/support/test-env.ts` (acrescentar Redis URL + `BILLING_PROVIDER=console`)
- Modify: `test/support/test-app.ts` (subir testcontainers Redis, expor `runBillingJobsNow`)

- [ ] **Step 22.1: Variáveis de teste**

Em `test/support/test-env.ts`, dentro de `setTestEnv()`, acrescente:

```ts
process.env.BILLING_PROVIDER = process.env.BILLING_PROVIDER ?? 'console';
process.env.BILLING_TRIAL_DAYS = process.env.BILLING_TRIAL_DAYS ?? '14';
process.env.BILLING_PAST_DUE_GRACE_DAYS = process.env.BILLING_PAST_DUE_GRACE_DAYS ?? '7';
// REDIS_URL é setado por startTestRedis() — não setamos default aqui pra forçar o setup explícito no E2E.
```

- [ ] **Step 22.2: Testcontainer Redis helper**

Crie `test/support/billing.ts`:

```ts
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { INestApplication } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { QUEUE_BILLING, JOB_BILLING_SYNC, JOB_TRIAL_CHECK } from 'src/infra/queues/queue-names';
import { ConsoleBillingProvider } from 'src/modules/billing/providers/console.billing-provider';
import { BILLING_PROVIDER } from 'src/modules/billing/providers/billing.provider';
import { BillingService } from 'src/modules/billing/billing.service';

export interface StartedRedis {
  container: StartedTestContainer;
  url: string;
}

export async function startTestRedis(): Promise<StartedRedis> {
  const container = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .start();
  const port = container.getMappedPort(6379);
  const url = `redis://${container.getHost()}:${port}`;
  process.env.REDIS_URL = url;
  return { container, url };
}

export async function flushTestRedis(url: string): Promise<void> {
  const r = new IORedis(url, { maxRetriesPerRequest: null, enableReadyCheck: false });
  await r.flushall();
  await r.quit();
}

export async function runBillingJobsNow(app: INestApplication): Promise<void> {
  // Em vez de esperar o cron, chamamos os métodos do service diretamente.
  // Isso é determinístico e independe do BullMQ rodando.
  const billing = app.get(BillingService);
  await billing.runBillingSync();
  await billing.runTrialCheck();
}

export function getConsoleBillingProvider(app: INestApplication): ConsoleBillingProvider {
  const provider = app.get(BILLING_PROVIDER);
  if (!(provider instanceof ConsoleBillingProvider)) {
    throw new Error('Test setup expected ConsoleBillingProvider but got another implementation');
  }
  return provider;
}

export function setBillingClock(date: Date): void {
  process.env.BILLING_NOW_OVERRIDE_MS = String(date.getTime());
}

export function resetBillingClock(): void {
  delete process.env.BILLING_NOW_OVERRIDE_MS;
}

export async function drainBillingQueue(app: INestApplication): Promise<void> {
  const queue = app.get<Queue>(`BullQueue_${QUEUE_BILLING}`);
  await queue.drain(true);
  // Garante que repeatable schedulers não disparem durante o teste — não há schedulers em test mode,
  // mas drain limpa qualquer job leftover. Mantemos referência aos nomes pra clareza.
  void JOB_BILLING_SYNC;
  void JOB_TRIAL_CHECK;
}
```

> **Atenção**: `BillingSchedules` já pula registro quando `NODE_ENV=test`. O `runBillingJobsNow` aciona os crons direto pelo service, sem depender do worker BullMQ — escolha consciente para tornar E2E determinístico.

- [ ] **Step 22.3: Subir Redis no `buildTestApp`**

Em `test/support/test-app.ts`, **não** subimos Redis automaticamente (cada E2E decide). O E2E que precisar chama `startTestRedis()` antes de `buildTestApp()`. Apenas garanta que `setTestEnv()` é chamado antes.

- [ ] **Step 22.4: Commit**

```bash
git add test/support/billing.ts test/support/test-env.ts
git commit -m "test(support): helpers for billing e2e (testcontainers redis, clock, console provider)"
```

---

## Task 23: E2E — checkout + sync → active

**Files:**
- Create: `test/e2e/billing-checkout.e2e-spec.ts`

- [ ] **Step 23.1: Spec**

Crie `test/e2e/billing-checkout.e2e-spec.ts`:

```ts
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import {
  StartedRedis,
  flushTestRedis,
  getConsoleBillingProvider,
  startTestRedis,
} from '../support/billing';

describe('Billing — checkout → sync → active (e2e)', () => {
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

  it('barbeiro registra → checkout → sync simulado → status active + currentPeriodEnd', async () => {
    const server = app.getHttpServer();

    const reg = await request(server)
      .post('/auth/register/owner')
      .send({
        email: 'owner@bill.test', password: 'StrongPass!1', name: 'Owner',
        tenantName: 'BillBarber', slug: 'bill',
      })
      .expect(201);
    const token = (reg.body as { accessToken: string }).accessToken;

    // 1) Subscription começa trialing
    const sub0 = await request(server)
      .get('/admin/billing/subscription')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect((sub0.body as { status: string }).status).toBe('trialing');
    expect((sub0.body as { hasCheckout: boolean }).hasCheckout).toBe(false);

    // 2) Checkout cria preapproval no Console provider
    const checkout = await request(server)
      .post('/admin/billing/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(200);
    const initPoint = (checkout.body as { initPoint: string }).initPoint;
    expect(initPoint).toMatch(/^http/);
    const preapprovalId = new URL(initPoint).searchParams.get('preapproval_id');
    expect(preapprovalId).toBeTruthy();

    // 3) Simula MP aprovando o pagamento
    const provider = getConsoleBillingProvider(app);
    provider.__test_advance(preapprovalId!, 'authorized', new Date('2026-06-12T12:00:00Z'));

    // 4) Front chama /sync após retorno do checkout
    const synced = await request(server)
      .post('/admin/billing/sync')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect((synced.body as { status: string }).status).toBe('active');
    expect((synced.body as { currentPeriodEnd: string | null }).currentPeriodEnd).toBe(
      '2026-06-12T12:00:00.000Z',
    );

    // 5) Re-checkout em assinatura ativa → 409
    await request(server)
      .post('/admin/billing/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(409)
      .expect(({ body }) => {
        expect((body as { code: string }).code).toBe('SUBSCRIPTION_ALREADY_ACTIVE');
      });
  });
});
```

Run: `npm run test:e2e -- billing-checkout`
Expected: PASS.

- [ ] **Step 23.2: Commit**

```bash
git add test/e2e/billing-checkout.e2e-spec.ts
git commit -m "test(e2e): billing checkout → sync → active happy path"
```

---

## Task 24: E2E — cron `billing-sync` polling pega mudança de status

**Files:**
- Create: `test/e2e/billing-cron-sync.e2e-spec.ts`

- [ ] **Step 24.1: Spec**

Crie `test/e2e/billing-cron-sync.e2e-spec.ts`:

```ts
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import {
  StartedRedis,
  flushTestRedis,
  getConsoleBillingProvider,
  runBillingJobsNow,
  startTestRedis,
} from '../support/billing';
import { PrismaService } from 'src/infra/prisma/prisma.service';

describe('Billing — cron billing-sync (e2e)', () => {
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

  it('cron sincroniza mudança remota authorized → paused → cancelled', async () => {
    const server = app.getHttpServer();
    const prisma = app.get(PrismaService);

    const reg = await request(server)
      .post('/auth/register/owner')
      .send({
        email: 'cron@bill.test', password: 'StrongPass!1', name: 'C',
        tenantName: 'Cron', slug: 'cron-bill',
      })
      .expect(201);
    const token = (reg.body as { accessToken: string }).accessToken;

    const checkout = await request(server)
      .post('/admin/billing/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(200);
    const preapprovalId = new URL(
      (checkout.body as { initPoint: string }).initPoint,
    ).searchParams.get('preapproval_id')!;

    // Forçar nextSyncAt no passado para ele ser pego pelo cron
    await prisma.subscription.updateMany({
      where: { mpPreapprovalId: preapprovalId },
      data: { nextSyncAt: new Date('2026-01-01T00:00:00Z') },
    });

    const provider = getConsoleBillingProvider(app);

    // Ciclo 1: authorized → active
    provider.__test_advance(preapprovalId, 'authorized', new Date('2026-06-12T12:00:00Z'));
    await runBillingJobsNow(app);
    expect(
      (await prisma.subscription.findUniqueOrThrow({
        where: { mpPreapprovalId: preapprovalId },
      })).status,
    ).toBe('active');

    // Avança nextSyncAt para o passado de novo
    await prisma.subscription.updateMany({
      where: { mpPreapprovalId: preapprovalId },
      data: { nextSyncAt: new Date('2026-01-01T00:00:00Z') },
    });

    // Ciclo 2: paused → past_due
    provider.__test_advance(preapprovalId, 'paused', null);
    await runBillingJobsNow(app);
    expect(
      (await prisma.subscription.findUniqueOrThrow({
        where: { mpPreapprovalId: preapprovalId },
      })).status,
    ).toBe('past_due');

    // Avança nextSyncAt
    await prisma.subscription.updateMany({
      where: { mpPreapprovalId: preapprovalId },
      data: { nextSyncAt: new Date('2026-01-01T00:00:00Z') },
    });

    // Ciclo 3: cancelled
    provider.__test_advance(preapprovalId, 'cancelled', null);
    await runBillingJobsNow(app);
    const final = await prisma.subscription.findUniqueOrThrow({
      where: { mpPreapprovalId: preapprovalId },
    });
    expect(final.status).toBe('cancelled');
    expect(final.nextSyncAt).toBeNull();
  });
});
```

Run: `npm run test:e2e -- billing-cron-sync`
Expected: PASS.

- [ ] **Step 24.2: Commit**

```bash
git add test/e2e/billing-cron-sync.e2e-spec.ts
git commit -m "test(e2e): cron billing-sync transitions across all statuses"
```

---

## Task 25: E2E — `trial-check` (expiração + grace period)

**Files:**
- Create: `test/e2e/billing-trial-check.e2e-spec.ts`

- [ ] **Step 25.1: Spec**

Crie `test/e2e/billing-trial-check.e2e-spec.ts`:

```ts
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import {
  StartedRedis,
  flushTestRedis,
  runBillingJobsNow,
  startTestRedis,
  setBillingClock,
  resetBillingClock,
} from '../support/billing';
import { PrismaService } from 'src/infra/prisma/prisma.service';

describe('Billing — trial-check (e2e)', () => {
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
    resetBillingClock();
    await app.close();
    await flushTestRedis(redis.url);
    await redis.container.stop();
    await container.stop();
  });

  afterEach(() => resetBillingClock());

  it('trial expirado → past_due e past_due > 7d → cancelled', async () => {
    const server = app.getHttpServer();
    const prisma = app.get(PrismaService);

    await request(server)
      .post('/auth/register/owner')
      .send({
        email: 't@bill.test', password: 'StrongPass!1', name: 'T',
        tenantName: 'Trial', slug: 'trial-x',
      })
      .expect(201);

    const sub = await prisma.subscription.findFirstOrThrow({
      where: { tenant: { slug: 'trial-x' } },
    });
    expect(sub.status).toBe('trialing');

    // Avança o relógio para depois do trial (15 dias depois do registro)
    setBillingClock(new Date(Date.now() + 15 * 24 * 60 * 60 * 1000));
    await runBillingJobsNow(app);

    const afterTrial = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(afterTrial.status).toBe('past_due');

    // "Esfria" o updatedAt do past_due para 8 dias atrás (relativo à data com clock avançado)
    // forçando o cutoff a pegar o registro
    const clockMs = Number(process.env.BILLING_NOW_OVERRIDE_MS);
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { updatedAt: new Date(clockMs - 8 * 24 * 60 * 60 * 1000) },
    });

    await runBillingJobsNow(app);

    const afterGrace = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(afterGrace.status).toBe('cancelled');
    expect(afterGrace.nextSyncAt).toBeNull();
  });
});
```

Run: `npm run test:e2e -- billing-trial-check`
Expected: PASS.

- [ ] **Step 25.2: Commit**

```bash
git add test/e2e/billing-trial-check.e2e-spec.ts
git commit -m "test(e2e): trial-check expires trial and enforces grace period"
```

---

## Task 26: E2E — gating de admin + storefront quando `cancelled`

**Files:**
- Create: `test/e2e/billing-admin-gating.e2e-spec.ts`

- [ ] **Step 26.1: Spec**

Crie `test/e2e/billing-admin-gating.e2e-spec.ts`:

```ts
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import {
  StartedRedis,
  flushTestRedis,
  startTestRedis,
} from '../support/billing';
import { PrismaService } from 'src/infra/prisma/prisma.service';

describe('Billing — gating admin + storefront (e2e)', () => {
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

  it('cancelled bloqueia /admin/services (402) mas libera /admin/billing/* e bloqueia storefront (404)', async () => {
    const server = app.getHttpServer();
    const prisma = app.get(PrismaService);

    const reg = await request(server)
      .post('/auth/register/owner')
      .send({
        email: 'gate@bill.test', password: 'StrongPass!1', name: 'G',
        tenantName: 'Gate', slug: 'gate-bill',
      })
      .expect(201);
    const token = (reg.body as { accessToken: string }).accessToken;

    // Cria um serviço pra ter algo na storefront
    await request(server)
      .post('/admin/services')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Corte', durationMin: 30, priceCents: 4500 })
      .expect(201);

    // Storefront responde 200 enquanto trialing
    await request(server).get('/public/gate-bill/services').expect(200);

    // Marca subscription como cancelled diretamente no DB
    await prisma.subscription.updateMany({
      where: { tenant: { slug: 'gate-bill' } },
      data: { status: 'cancelled', nextSyncAt: null },
    });

    // Admin não-billing → 402 SUBSCRIPTION_INACTIVE
    await request(server)
      .get('/admin/services')
      .set('Authorization', `Bearer ${token}`)
      .expect(402)
      .expect(({ body }) => {
        expect((body as { code: string }).code).toBe('SUBSCRIPTION_INACTIVE');
      });

    // /admin/billing/subscription liberado
    await request(server)
      .get('/admin/billing/subscription')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect(({ body }) => {
        expect((body as { status: string }).status).toBe('cancelled');
      });

    // /admin/billing/checkout liberado (permite renovar)
    await request(server)
      .post('/admin/billing/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(200);

    // Storefront pública → 404 quando cancelled
    await request(server).get('/public/gate-bill/services').expect(404);
  });

  it('past_due NÃO bloqueia admin nem storefront (gating só dispara em cancelled)', async () => {
    const server = app.getHttpServer();
    const prisma = app.get(PrismaService);

    const reg = await request(server)
      .post('/auth/register/owner')
      .send({
        email: 'pd@bill.test', password: 'StrongPass!1', name: 'P',
        tenantName: 'PD', slug: 'pd-bill',
      })
      .expect(201);
    const token = (reg.body as { accessToken: string }).accessToken;

    await prisma.subscription.updateMany({
      where: { tenant: { slug: 'pd-bill' } },
      data: { status: 'past_due' },
    });

    await request(server)
      .get('/admin/services')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    await request(server).get('/public/pd-bill/services').expect(200);
  });
});
```

Run: `npm run test:e2e -- billing-admin-gating`
Expected: PASS.

- [ ] **Step 26.2: Commit**

```bash
git add test/e2e/billing-admin-gating.e2e-spec.ts
git commit -m "test(e2e): admin gating on cancelled + past_due remains operational"
```

---

## Task 27: Atualizar `README.md` e `.env.example` finais

**Files:**
- Modify: `README.md`
- Modify: `.env.example`

- [ ] **Step 27.1: `.env.example` — checar bloco final**

Confirme que `.env.example` contém (já adicionado na Task 2):

```
REDIS_URL=redis://localhost:6379
BILLING_PROVIDER=console
BILLING_TRIAL_DAYS=14
BILLING_PAST_DUE_GRACE_DAYS=7
BILLING_SYNC_CRON=0 6,18 * * *
BILLING_TRIAL_CHECK_CRON=15 6 * * *
MP_ACCESS_TOKEN=
MP_PLAN_AMOUNT_CENTS=4990
MP_BILLING_FREQUENCY=months
MP_RETURN_URL=http://localhost:3001/admin/billing/return
MP_API_BASE_URL=https://api.mercadopago.com
```

- [ ] **Step 27.2: `README.md` — seção Fase 4**

Em `README.md`, na lista de fases:

```markdown
### Fase 4 — Billing (Mercado Pago via polling) ✅
- `/admin/billing/(subscription|checkout|sync|cancel|invoices)`
- Provider abstraído (`BillingProvider`): `ConsoleBillingProvider` em dev, `MercadopagoBillingProvider` em prod.
- Crons BullMQ:
  - `billing-sync` (default `0 6,18 * * *` UTC) — polling de estado por status.
  - `trial-check` (default `15 6 * * *` UTC) — `trialing → past_due` e `past_due → cancelled` após grace.
- Gating: tenant `cancelled` ganha 402 em `/admin/*` (exceto billing) e 404 na storefront.
- Sem webhook MP. Subscription on-demand re-sync em `/admin/billing/sync` resolve 95% dos casos pós-checkout.
```

E acrescente em "How to run locally":

```markdown
- Redis local: `docker compose up -d redis`
- Variáveis de billing (`BILLING_PROVIDER=console` no dev — sem MP de verdade).
```

- [ ] **Step 27.3: Verificação final**

Run:
```bash
npm run lint && npm run test && npm run test:e2e && npm run build
```
Expected: TODOS verdes.

- [ ] **Step 27.4: Commit final**

```bash
git add README.md .env.example
git commit -m "docs(phase4): update README and env example for billing"
```

---

## Critério de aceitação da Fase 4

**Pronto quando** (do spec §4 — Fase 4):
> Barbeiro completa fluxo de pagamento, status local sincroniza, gating de tenant inativo funciona.

Validação concreta:
- `test/e2e/billing-checkout.e2e-spec.ts` passa (checkout → console approve → sync → status `active`).
- `test/e2e/billing-cron-sync.e2e-spec.ts` passa (cron pega `authorized → paused → cancelled`).
- `test/e2e/billing-trial-check.e2e-spec.ts` passa (trial expira → `past_due`; +8d → `cancelled`).
- `test/e2e/billing-admin-gating.e2e-spec.ts` passa (`cancelled` ⇒ admin 402 / storefront 404; `past_due` continua operacional).
- `src/modules/billing/*.spec.ts` (3 arquivos) passam, cobrindo TDD do service.
- Cobertura: `npm run test:cov` mostra `src/modules/billing/` ≥ 90% e geral ≥ 70% (alvo da spec §11).
- `BILLING_PROVIDER=mercadopago` em `npm run build` valida ausência de defaults perigosos (sem `MP_ACCESS_TOKEN` → boot falha com mensagem clara).

---

## O que NÃO entra nesta fase (parking lot da Fase 4)

- Webhook do Mercado Pago (spec §15 — futuro; substitui polling sem mexer em domain).
- `Idempotency-Key` real no checkout (depende de cache Redis dedicado; idempotência prática hoje vem da regra "se existe preapproval e status compatível, devolve mesmo `initPoint`").
- Notificação por email do barbeiro em transições `past_due`/`cancelled` (Fase 5 — quando AuditLog e templates de operação chegarem).
- `Invoice` model local (hoje proxia MP em `GET /admin/billing/invoices`).
- Dashboard do barbeiro (`/admin/dashboard/summary`) — fica para Fase 5 ou separado.
- Múltiplos planos / feature gating diferenciado (parking lot da spec §14).
- Pause/resume de assinatura via admin (hoje só cancel; reativar = novo checkout).
- Métricas Prometheus específicas de billing (spec §10 — entra junto com observabilidade global).
- Suspender/reativar tenant pelo dono do SaaS (Fase 5).






