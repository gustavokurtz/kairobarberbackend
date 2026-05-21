# Billing Hardening F3 — Hardening crons/HTTP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fechar os vetores A1 (`POST /admin/billing/sync` sem throttle, risco de pendurar 1000 req/s contra Asaas e queimar a API key compartilhada) e A2 (fetch ao Asaas sem timeout, risco de pendurar workers NestJS em latência alta) adicionando `@Throttle({limit:5, ttl:60_000})` no endpoint de sync e `AbortSignal.timeout(10_000)` em todas as chamadas HTTP do `AsaasBillingProvider`, com mapeamento de timeout pra `DomainException` HTTP 504 `BILLING_PROVIDER_ERROR`.

**Architecture:** Mudança puramente runtime (sem schema, sem endpoint novo). Fix em 2 arquivos do módulo billing (`billing.controller.ts` + `providers/asaas.billing-provider.ts`). O throttle é decorator NestJS já usado em outros endpoints do mesmo controller (`/checkout` linha 51). O timeout é via `AbortSignal.timeout(10_000)` nativo do Node 18+ passado pro `fetch()`; quando dispara, o fetch rejeita com `DOMException` (`name === 'TimeoutError'`), capturado em `try/catch` ao redor da chamada e remapeado pra `DomainException(BILLING_PROVIDER_ERROR, status: GATEWAY_TIMEOUT)`. Outros erros (network failure, abort externo) ficam isolados via `name === 'AbortError'` no mesmo catch.

**Tech Stack:** NestJS 11 (`@nestjs/throttler` — `Throttle` já importado no controller), `AbortSignal.timeout` nativo (Node ≥ 17.3, projeto rodando ≥ 18), Jest + supertest + testcontainers (padrão E2E do projeto), `DomainException` + `ErrorCodes.BILLING_PROVIDER_ERROR` (já existe, [error-codes.ts:52](../../../src/common/exceptions/error-codes.ts)).

**Spec source-of-truth:** [`docs/superpowers/specs/2026-05-21-billing-hardening-v2-design.md`](../specs/2026-05-21-billing-hardening-v2-design.md) §9 (Fase F3, R-F3-01 a R-F3-04).

---

## File Structure

**Arquivos modificados:**
- `src/modules/billing/billing.controller.ts:79` — adiciona `@Throttle({ default: { limit: 5, ttl: 60_000 } })` no `POST /admin/billing/sync` (acima do `@HttpCode`, abaixo do `@AllowInactiveSubscription()`)
- `src/modules/billing/providers/asaas.billing-provider.ts:225-262` — `request()`: envolve `await this.fetchImpl(...)` em `try/catch`; adiciona `signal: AbortSignal.timeout(10_000)` no init do fetch; captura `TimeoutError`/`AbortError` e lança `DomainException` `BILLING_PROVIDER_ERROR` HTTP 504 com `details: { method, path }`
- `src/modules/billing/providers/asaas.billing-provider.spec.ts` — adiciona describe `request() timeout` com testes unit pra (a) signal passado no fetch, (b) TimeoutError → 504, (c) AbortError → 504

**Arquivos criados:**
- `test/e2e/billing-sync-throttle.e2e-spec.ts` — spec E2E novo cobrindo R-F3-04 do throttle do `/admin/billing/sync`. **Spec novo (não estende `billing-cron-sync.e2e-spec.ts`)** porque (1) cron sync vs endpoint sync são caminhos distintos, (2) testar throttle vai criar 6 calls no mesmo IP, que poluiria outras assertions do spec existente, (3) o padrão do projeto é spec dedicado por área (vide `billing-checkout`, `billing-past-due-gating`, `billing-admin-gating` — todos separados).

**Não modificar nesta fase:**
- `runBillingSync` / `BillingProcessor` — fora do escopo F3 (anti-acceptance: "❌ Mudança no `runBillingSync` retry logic"). O timeout corta a chamada individual; o cron continua com seu retry exponencial (`SYNC_RETRY_BACKOFF_MS`) intacto.
- `mercadopago.billing-provider.ts` / `console.billing-provider.ts` — fora do escopo (spec menciona só Asaas em A2). Console nem faz HTTP; MP é legado e não está em prod (memória `project_kairobarber`).
- `.env.example` — sem env novo.
- `src/config/env.validation.ts` — sem env novo (timeout é hardcoded 10_000 ms; spec D-07 trava o valor).

**Convenções respeitadas:**
- pt-BR em mensagens (`"Timeout na comunicação com Asaas."`).
- `@Throttle` no controller layer com mesma forma sintática usada em `/checkout` (linha 51): `@Throttle({ default: { limit: N, ttl: 60_000 } })`.
- E2E usa `setTestEnv()` + `buildTestApp()` + `startTestPostgres()` + `startTestRedis()` (padrão dominante visto em `billing-past-due-gating.e2e-spec.ts`).
- Test E2E não precisa driblar throttle global (1000/60s em E2E) — exercita o decorator local 5/60s diretamente fazendo 6 calls do mesmo IP, igual F1 fez pra `/auth/register/owner` no `auth-onboarding.e2e-spec.ts`.

---

## Task 0: Recall — re-ler spec e fazer echo-back

**Arquivo:** N/A (etapa de leitura/raciocínio, sem código).

- [ ] **Step 1: Re-ler ambos os specs**

Ler na íntegra (sem skip):
1. `docs/superpowers/specs/2026-05-21-billing-hardening-v2-design.md` (especialmente §9 F3)
2. `docs/superpowers/specs/2026-05-20-trial-grace-tightening-design.md` (INV-01 a INV-11 continuam valendo)

- [ ] **Step 2: Responder echo-back de 5 bullets na resposta da Task 0**

Responder textualmente (não commitar):

1. Quais invariants (INV-01 a INV-16) são relevantes pra F3?
   *Esperado: nenhum invariant novo é introduzido por F3, mas INV-07/INV-16 (404 puro em past_due pra rotas públicas slug-scoped) continua valendo — confirma que mapear timeout pra 504 em endpoint admin autenticado (`/admin/billing/sync`) NÃO viola (404 puro é só pra storefront pública). INV-01 a INV-11 da spec anterior também continuam valendo.*
2. Que decisões eu posso ferir sem perceber?
   *Esperado: **D-06** (throttle do sync é 5/60s — NÃO 3, NÃO 10. Sync é polling legítimo pós-pagamento, mais permissivo que checkout). **D-07** (timeout exato 10s — NÃO 5, NÃO 30. Asaas latência normal 1-3s; 10s cobre p99). **D-10** (esta é PR da F3 isolada — não bundle com F4). Cuidado: F2 commitou recentemente mudanças em `billing.schedules.ts`, e F3 toca só `billing.controller.ts` + `asaas.billing-provider.ts` — não mexer em schedules.*
3. Quais requirements R-F3-NN são meu escopo?
   *Esperado: **R-F3-01** (decorator throttle 5/60s em POST /admin/billing/sync), **R-F3-02** (`AbortSignal.timeout(10_000)` no fetch do AsaasBillingProvider.request), **R-F3-03** (capturar TimeoutError/AbortError → DomainException BILLING_PROVIDER_ERROR status 504), **R-F3-04** (testes E2E 6 calls + unit timeout).*
4. Qual anti-acceptance protege de scope creep?
   *Esperado: ❌ `fetch` ao Asaas sem `signal: AbortSignal.timeout(...)`; ❌ Timeout retorna 500 (DEVE ser 504); ❌ Throttle do `/sync` mais restritivo que 5/60s (3/60s seria apertado demais); ❌ Mudança no `runBillingSync` retry logic (escopo do timeout é só interromper, não retry); ❌ Adicionar retry exponencial dentro de `request()` (já existe `SYNC_RETRY_BACKOFF_MS` no cycle).*
5. Qual recall-check de teste prova que não quebrei reativação?
   *Esperado: `billing-cron-sync.e2e-spec.ts` continua verde — o cron sync continua sincronizando subscriptions e os retries do BullMQ continuam funcionando (timeout só afeta a chamada HTTP individual, não muda lógica do processor). `billing-checkout.e2e-spec.ts` continua verde — checkout não foi tocado nesta fase (vai ser tocado em F4). O caminho `past_due → /admin/billing/checkout → /admin/billing/sync (manual) → active` continua passando; só que o `/sync` agora aceita no máximo 5 calls/min/IP (suficiente pra UX legítimo de polling pós-pagamento).*

---

## Task 1: Pre-flight — confirmar estado do repo e pré-requisitos

**Arquivo:** N/A (verificação read-only).

**Por que:** F3 depende de F1 e F2 estarem mergeadas (spec §9 Pré-requisito: "F3 idealmente após F2 (pra evitar conflito de PR em billing.controller.ts)"). Confirmar antes de codar.

- [ ] **Step 1: Confirmar branch e cleanliness**

Run: `git status && git branch --show-current`

Expected:
- Branch atual: `main` (ou branch de feature derivada de main com F1+F2 inclusos).
- `git status` limpo (sem mudanças pendentes).

Se o branch for `main`, criar branch de feature antes de codar:

```bash
git checkout -b feature/billing-hardening-f3-crons-http
```

- [ ] **Step 2: Confirmar F1 + F2 estão no histórico**

Run: `git log --oneline -20 | grep -E "(F1|F2|throttle|getOrThrow|onApplicationBootstrap)"`

Expected (entre outros — pelo menos estes 7 commits devem aparecer):
- `feat(auth): throttle register/owner 3/60s/IP (F1 R-F1-01)`
- `feat(auth): normalize email lower+trim em writes/reads (F1 R-F1-02..06)`
- `feat(auth): indice funcional UNIQUE LOWER(email) na tabela User (F1 R-F1-07/08)`
- `fix(billing): trocar ?? 7 por getOrThrow em runTrialCheck (C2)`
- `fix(billing): trocar ?? '<cron>' por getOrThrow em BillingSchedules (C3)`
- `fix(billing): try/catch + re-throw em onApplicationBootstrap (C4)`
- `test(billing): spec inicial de BillingSchedules (happy path + skip)`

Se algum estiver faltando: **PARAR**. F3 não pode ser implementada antes de F1+F2 estarem em `main` (decisão D-10 do spec: PRs separadas por fase pra reverter limpo).

- [ ] **Step 3: Confirmar import de `Throttle` já está no controller**

Run: `grep -n "Throttle" src/modules/billing/billing.controller.ts`

Expected:
```
11:import { Throttle } from '@nestjs/throttler';
51:  @Throttle({ default: { limit: 6, ttl: 60_000 } })
```

Se a linha 11 não existir, **PARAR** e adicionar o import (deveria estar lá — `/checkout` já usa Throttle).

- [ ] **Step 4: Confirmar `BILLING_PROVIDER_ERROR` existe em `ErrorCodes`**

Run: `grep -n "BILLING_PROVIDER_ERROR" src/common/exceptions/error-codes.ts`

Expected:
```
52:  BILLING_PROVIDER_ERROR: 'BILLING_PROVIDER_ERROR',
```

Já existe (a spec assume isso). Se faltar: parar e adicionar antes (improvável).

- [ ] **Step 5: Confirmar Node ≥ 18 (necessário pra `AbortSignal.timeout`)**

Run: `node --version`

Expected: `v20.x.x` ou superior (padrão do projeto, ver `.nvmrc` se existir).

`AbortSignal.timeout()` é nativo desde Node 17.3. Não precisa polyfill. Se Node < 17.3 (improvável): parar e fazer upgrade.

- [ ] **Step 6: Confirmar testes atuais verdes (baseline)**

Run: `pnpm test:e2e -- billing`

Expected: 5 suites verdes (`billing-admin-gating`, `billing-checkout`, `billing-cron-sync`, `billing-past-due-gating`, `billing-trial-check`).

**Se algum estiver vermelho:** parar. Não introduza mudanças em cima de baseline quebrado.

---

## Task 2: TDD — `@Throttle` em `POST /admin/billing/sync` (R-F3-01)

**Files:**
- Create: `test/e2e/billing-sync-throttle.e2e-spec.ts` (NOVO)
- Modify: `src/modules/billing/billing.controller.ts:79-85`

- [ ] **Step 1: Criar o spec E2E novo com teste que falha**

Criar `test/e2e/billing-sync-throttle.e2e-spec.ts`:

```ts
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import { StartedRedis, flushTestRedis, startTestRedis } from '../support/billing';

describe('Billing — POST /admin/billing/sync throttle (e2e)', () => {
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

  // Hash determinístico do slug pra X-Forwarded-For — cada tenant fica isolado no
  // throttler global. Pra forçar 429 no 6º call do MESMO IP, reusamos o mesmo IP
  // (mesmo slug) — diferente de outros specs que distribuem por tenant.
  function slugToFakeIp(slug: string): string {
    let h = 0;
    for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
    return `10.${(h >>> 16) & 0xff}.${(h >>> 8) & 0xff}.${h & 0xff}`;
  }

  async function registerAndLogin(slug: string): Promise<{
    accessToken: string;
    fakeIp: string;
  }> {
    const server = app.getHttpServer() as unknown as import('http').Server;
    const fakeIp = slugToFakeIp(slug);
    const reg = await request(server)
      .post('/auth/register/owner')
      .set('X-Forwarded-For', fakeIp)
      .send({
        email: `${slug}@sync.test`,
        password: 'StrongPass!1',
        name: `Owner ${slug}`,
        tenantName: `Barber ${slug}`,
        slug,
      })
      .expect(201);
    const body = reg.body as { accessToken: string };
    return { accessToken: body.accessToken, fakeIp };
  }

  it('aceita 5 calls consecutivas em POST /admin/billing/sync e bloqueia a 6ª com 429', async () => {
    const { accessToken, fakeIp } = await registerAndLogin('sync-throttle-1');
    const server = app.getHttpServer() as unknown as import('http').Server;

    // 5 calls válidas no mesmo IP — limite local é 5/60s (R-F3-01)
    for (let i = 0; i < 5; i++) {
      await request(server)
        .post('/admin/billing/sync')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('X-Forwarded-For', fakeIp)
        .expect(200);
    }

    // 6ª call no mesmo IP em < 60s deve retornar 429 Too Many Requests
    await request(server)
      .post('/admin/billing/sync')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-Forwarded-For', fakeIp)
      .expect(429);
  });
});
```

**Nota sobre `BILLING_PROVIDER='console'` em test env (`setTestEnv` linha 13):** o provider console implementa `BillingProvider` sem fazer HTTP — `syncSubscription` retorna successo sem efeito colateral. As 5 primeiras calls vão retornar 200 sem bater no Asaas. Perfeito pra isolar o teste do throttle.

- [ ] **Step 2: Rodar test pra verificar que FALHA**

Run: `pnpm test:e2e -- billing-sync-throttle`

Expected: teste **FALHA** com `expected 429 "Too Many Requests", got 200 "OK"` (porque ainda não tem `@Throttle` no `/sync`).

- [ ] **Step 3: Implementar o decorator**

Em `src/modules/billing/billing.controller.ts`, localizar o método `sync` (linhas 79-85). **Adicionar** a linha `@Throttle(...)` entre `@AllowInactiveSubscription()` e `@HttpCode(HttpStatus.OK)`:

Estado atual:
```ts
  @Post('sync')
  @AllowInactiveSubscription()
  @HttpCode(HttpStatus.OK)
  async sync(@CurrentTenant() tenantId: string) {
    await this.billing.syncSubscription(tenantId);
    return this.billing.getSubscription(tenantId);
  }
```

Estado novo:
```ts
  @Post('sync')
  @AllowInactiveSubscription()
  // A1: tenant past_due polling agressivamente pode pendurar 1000 req/s contra Asaas
  // → risco de rate-limit da nossa conta inteira. 5/60s/IP é generoso pra polling
  // legítimo pós-pagamento (user clica "atualizei, sincroniza") mas fecha abuso.
  // D-06: NÃO usar 3/60s (apertado se Asaas demora > 20s) nem 10/60s (permissivo demais).
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  async sync(@CurrentTenant() tenantId: string) {
    await this.billing.syncSubscription(tenantId);
    return this.billing.getSubscription(tenantId);
  }
```

Não precisa adicionar import (`Throttle` já está no topo do arquivo — confirmado em Task 1 Step 3).

- [ ] **Step 4: Rodar test pra verificar que PASSA**

Run: `pnpm test:e2e -- billing-sync-throttle`

Expected: teste **PASSA**.

- [ ] **Step 5: Rodar suite billing inteira pra detectar regressão**

Run: `pnpm test:e2e -- billing`

Expected: todas as 6 suites verdes (5 pré-existentes + 1 novo). Se `billing-checkout` ou `billing-cron-sync` quebrarem, suspeitar que outro teste estava dependendo do `/sync` ser ilimitado.

- [ ] **Step 6: Commit**

```bash
git add src/modules/billing/billing.controller.ts test/e2e/billing-sync-throttle.e2e-spec.ts
git commit -m "$(cat <<'EOF'
feat(billing): throttle /admin/billing/sync 5/60s/IP (F3 R-F3-01 / A1)

Fecha vetor A1 da auditoria 2026-05-21: tenant past_due podia
pendurar 1000 req/s contra Asaas pelo /sync sem throttle, com
risco de rate-limit da nossa conta inteira (Asaas faz rate-limit
por API key).

D-06: 5/60s — mais permissivo que checkout (6/60s) porque sync é
polling legítimo pós-pagamento. Ainda fecha abuso de bot.

Spec: docs/superpowers/specs/2026-05-21-billing-hardening-v2-design.md
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: TDD — `AbortSignal.timeout(10_000)` + mapeamento 504 no `AsaasBillingProvider.request()` (R-F3-02 + R-F3-03)

**Files:**
- Modify: `src/modules/billing/providers/asaas.billing-provider.ts:225-262`
- Modify: `src/modules/billing/providers/asaas.billing-provider.spec.ts` (adiciona describe `request() timeout`)

- [ ] **Step 1: Adicionar 3 testes que falham no spec do provider**

Abrir `src/modules/billing/providers/asaas.billing-provider.spec.ts`. Localizar a primeira linha do arquivo (imports). **Adicionar** imports necessários no topo se faltarem:

```ts
import { HttpStatus } from '@nestjs/common';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
```

(Provavelmente já estão importados — confirmar antes de duplicar.)

Adicionar este `describe` **dentro** do `describe('AsaasBillingProvider', () => {`, **antes** do `});` que fecha o describe principal (depois dos outros describes existentes):

```ts
  describe('request() timeout (A2 / R-F3-02 + R-F3-03)', () => {
    it('passa AbortSignal.timeout(10_000) no init do fetch', async () => {
      fetchMock.mockResolvedValueOnce(jsonRes(200, { data: [], hasMore: false, totalCount: 0 }));

      await provider.healthCheck();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0];
      expect(init?.signal).toBeDefined();
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      // Sanity: signal vem de AbortSignal.timeout, então não está aborted no momento da call
      expect((init?.signal as AbortSignal).aborted).toBe(false);
    });

    it('mapeia TimeoutError do fetch pra DomainException 504 BILLING_PROVIDER_ERROR', async () => {
      // Simula AbortSignal disparando timeout — fetch rejeita com DOMException name='TimeoutError'
      const timeoutErr = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      fetchMock.mockRejectedValueOnce(timeoutErr);

      await expect(provider.healthCheck()).resolves.toEqual({ ok: false });
      // healthCheck engole — vamos testar pelo caminho que propaga:
      fetchMock.mockRejectedValueOnce(timeoutErr);

      await expect(
        provider.listPayments('sub_X', { page: 1, pageSize: 20 }),
      ).rejects.toMatchObject({
        opts: {
          code: ErrorCodes.BILLING_PROVIDER_ERROR,
          status: HttpStatus.GATEWAY_TIMEOUT, // 504
        },
      });
    });

    it('mapeia AbortError externo pra DomainException 504 (mesma classe)', async () => {
      const abortErr = new DOMException('Aborted', 'AbortError');
      fetchMock.mockRejectedValueOnce(abortErr);

      await expect(
        provider.listPayments('sub_Y', { page: 1, pageSize: 20 }),
      ).rejects.toMatchObject({
        opts: {
          code: ErrorCodes.BILLING_PROVIDER_ERROR,
          status: HttpStatus.GATEWAY_TIMEOUT,
        },
      });
    });

    it('preserva method+path nos details da DomainException de timeout', async () => {
      const timeoutErr = new DOMException('Timeout', 'TimeoutError');
      fetchMock.mockRejectedValueOnce(timeoutErr);

      await expect(provider.listPayments('sub_Z', { page: 1, pageSize: 20 })).rejects.toMatchObject(
        {
          opts: {
            details: {
              method: 'GET',
              path: expect.stringContaining('/v3/subscriptions/sub_Z/payments'),
            },
          },
        },
      );
    });
  });
```

**Notas técnicas:**
- `DOMException` é global em Node 18+. Não precisa importar.
- `provider.listPayments` é escolhido como veículo de teste porque (a) faz uma única call de fetch (simples), (b) propaga erros do `request()` sem catch local (vs `cancelPreapproval` que engole 404, ou `healthCheck` que engole tudo).
- A asserção `toMatchObject({ opts: { code, status } })` espelha a estrutura de `DomainException` (campo público `.opts` contém `{ code, message, status, details }`).
- Não testamos contra `DomainException` instanceof via `toBeInstanceOf` porque o Jest matchers de erro são mais ergonômicos com `toMatchObject`.

- [ ] **Step 2: Rodar testes pra verificar que FALHAM**

Run: `pnpm jest src/modules/billing/providers/asaas.billing-provider.spec.ts -t "request\\(\\) timeout"`

Expected:
- "passa AbortSignal.timeout(10_000) no init do fetch": **FAIL** (init.signal é undefined hoje).
- "mapeia TimeoutError do fetch pra DomainException 504": **FAIL** (catch atual não existe — fetch rejeita propaga como DOMException cru, não como DomainException 504).
- "mapeia AbortError externo pra DomainException 504": **FAIL** (mesma razão).
- "preserva method+path nos details": **FAIL** (mesma razão).

- [ ] **Step 3: Implementar `AbortSignal.timeout` + try/catch no `request()`**

Em `src/modules/billing/providers/asaas.billing-provider.ts`, localizar o método `request` (linhas 225-262). Substituir o método inteiro por:

```ts
  private async request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.apiBaseUrl}${path}`, {
        method,
        headers: {
          access_token: this.opts.apiKey,
          'Content-Type': 'application/json',
          'User-Agent': 'kairobarber-api',
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        // A2 / R-F3-02: 10s cobre p99 do Asaas (latência normal 1-3s) sem pendurar
        // workers indefinidamente. SYNC_RETRY_BACKOFF_MS continua intacto no cycle —
        // este timeout é só pra interromper a chamada individual.
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      // R-F3-03: AbortSignal.timeout dispara DOMException name='TimeoutError'.
      // AbortError externo (controller.abort()) também é capturado pela mesma classe.
      // Outros erros (TypeError network failure, etc.) propagam crus — mantém comportamento.
      const name = (err as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        this.logger.warn({
          event: 'asaas.request_timeout',
          method,
          path,
          timeoutMs: 10_000,
        });
        throw new DomainException({
          code: ErrorCodes.BILLING_PROVIDER_ERROR,
          message: 'Timeout na comunicação com Asaas.',
          status: HttpStatus.GATEWAY_TIMEOUT,
          details: { method, path },
        });
      }
      throw err;
    }
    if (res.ok) return res;

    const errBody = await safeJson(res);
    const firstError = errBody?.errors?.[0];
    this.logger.warn({
      event: 'asaas.request_failed',
      method,
      path,
      statusCode: res.status,
      providerCode: firstError?.code,
      providerMessage: firstError?.description,
      requestBody: sanitizeBody(body),
    });
    if (res.status === 401 || res.status === 403) {
      throw new DomainException({
        code: ErrorCodes.BILLING_PROVIDER_UNAUTHORIZED,
        message: 'Provedor de pagamento (Asaas) rejeitou as credenciais.',
        status: HttpStatus.BAD_GATEWAY,
        details: { statusCode: res.status, providerMessage: firstError?.description },
      });
    }
    throw new DomainException({
      code: ErrorCodes.BILLING_PROVIDER_ERROR,
      message: 'Falha ao falar com o provedor de pagamento (Asaas).',
      status: HttpStatus.BAD_GATEWAY,
      details: { statusCode: res.status, providerMessage: firstError?.description },
    });
  }
```

Mudanças cirúrgicas:
1. Envolveu `const res = await this.fetchImpl(...)` em `try { let res: Response; res = ... }`.
2. Adicionou `signal: AbortSignal.timeout(10_000)` no init do fetch.
3. Adicionou catch que detecta TimeoutError/AbortError, loga `asaas.request_timeout`, e lança `DomainException(BILLING_PROVIDER_ERROR, GATEWAY_TIMEOUT, { method, path })`.
4. Outros erros propagam (re-throw `err`).
5. O resto do método (parsing `res.ok`, mapping 401/403, mapping 5xx) intocado.

- [ ] **Step 4: Rodar testes pra verificar que PASSAM**

Run: `pnpm jest src/modules/billing/providers/asaas.billing-provider.spec.ts -t "request\\(\\) timeout"`

Expected: **4 testes verdes**.

- [ ] **Step 5: Rodar spec inteiro do provider pra detectar regressão**

Run: `pnpm jest src/modules/billing/providers/asaas.billing-provider.spec.ts`

Expected: **todos passam** (testes pré-existentes não dependem de signal ou catch — só verificam call URL/body/response mapping).

Se algum teste pré-existente quebrar com mensagem mencionando `signal` ou `AbortSignal`: o problema é o test matcher comparando init inteiro com objeto literal sem `signal`. Solução: trocar pra `toMatchObject` ou ignorar a chave `signal` no matcher.

**Mais provável:** nenhuma quebra. Os testes existentes verificam URL/method/body via `fetchMock.mock.calls[i]`, não comparam init completo.

- [ ] **Step 6: Rodar suite unit inteira do billing pra detectar regressão cross-spec**

Run: `pnpm jest src/modules/billing/`

Expected: tudo verde. Incluindo `billing.cron.spec.ts` e `billing.service.spec.ts`, que podem (em integração) chamar o provider — mas como esses specs mockam o provider inteiro, não devem ser afetados.

- [ ] **Step 7: Rodar E2E billing inteiro pra confirmar não-regressão funcional**

Run: `pnpm test:e2e -- billing`

Expected: 6 suites verdes (5 pré-existentes + `billing-sync-throttle`). Atenção em `billing-cron-sync` — se ele bate em Asaas mock e tem latência simulada > 10s, pode tropeçar. **Mais provável:** spec usa `BILLING_PROVIDER='console'` (default em `setTestEnv`), então Asaas não roda — sem regressão.

- [ ] **Step 8: Commit**

```bash
git add src/modules/billing/providers/asaas.billing-provider.ts src/modules/billing/providers/asaas.billing-provider.spec.ts
git commit -m "$(cat <<'EOF'
feat(billing): timeout 10s + 504 em AsaasBillingProvider.request (F3 R-F3-02/03 / A2)

Fecha vetor A2 da auditoria 2026-05-21: fetch() ao Asaas sem
AbortSignal podia pendurar worker NestJS indefinidamente em
latência alta, causando 503 em endpoints legítimos (checkout do
barbeiro novo trava na hora crítica).

D-07: AbortSignal.timeout(10_000) — cobre p99 do Asaas (latência
normal 1-3s) sem ser apertado. TimeoutError/AbortError mapeados
pra DomainException BILLING_PROVIDER_ERROR HTTP 504 com
{ method, path } nos details. SYNC_RETRY_BACKOFF_MS no cycle
intocado (timeout só corta a call individual).

Spec: docs/superpowers/specs/2026-05-21-billing-hardening-v2-design.md
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Verificação final — full test suite + grep de anti-acceptance

**Arquivo:** N/A (verificação).

- [ ] **Step 1: Grep — `signal: AbortSignal.timeout` presente em todos os fetch do Asaas**

Run: `grep -nE "this\\.fetchImpl|AbortSignal" src/modules/billing/providers/asaas.billing-provider.ts`

Expected (3+ linhas):
- Linha do `await this.fetchImpl(...)` (uma só — `request()` é o único call site).
- Linha com `signal: AbortSignal.timeout(10_000)`.

Se houver `fetchImpl` chamado fora de `request()`: **PARAR** e adicionar `AbortSignal.timeout` também (não esperado — provider já passa tudo pelo `request()` privado).

- [ ] **Step 2: Grep — `@Throttle` presente no `/sync`**

Run: `grep -B1 -A1 "@Post\\('sync'\\)" src/modules/billing/billing.controller.ts`

Expected: bloco mostrando `@Throttle({ default: { limit: 5, ttl: 60_000 } })` próximo do `@Post('sync')`.

- [ ] **Step 3: Lint**

Run: `pnpm lint`

Expected: **0 errors, 0 warnings novos**.

- [ ] **Step 4: Build TypeScript**

Run: `pnpm build`

Expected: **build OK**. Se reclamar de `AbortSignal.timeout`, confirmar `tsconfig.json` tem `"lib": [..., "DOM"]` ou `"ES2022"` (provavelmente já tem — `AbortSignal` é usado em outros lugares do projeto).

- [ ] **Step 5: Suite unit completa**

Run: `pnpm test`

Expected: **todos verdes** (≈140+ testes do projeto).

- [ ] **Step 6: Suite E2E billing**

Run: `pnpm test:e2e -- billing`

Expected: **6 suites verdes** (5 pré-existentes + `billing-sync-throttle`).

- [ ] **Step 7: Suite E2E completa (smoke final)**

Run: `pnpm test:e2e`

Expected: **todas as suites verdes**. Se algum spec não-billing tropeçar, suspeitar de algum efeito colateral inesperado (cota de teste, container shutdown). Não esperado.

- [ ] **Step 8: Smoke manual local (opcional, recomendado pra confiança)**

```bash
docker compose up -d postgres redis
pnpm prisma migrate dev
pnpm start:dev
```

Em outro terminal:

```bash
# 1) Cadastra e pega token
curl -s -X POST http://localhost:3000/auth/register/owner \
  -H 'Content-Type: application/json' \
  -d '{"email":"f3smoke@x.com","password":"StrongPass!1","name":"F3 Smoke","tenantName":"F3 Smoke","slug":"f3-smoke"}' \
  | jq -r .accessToken
# Salve o token

# 2) 6 calls em /admin/billing/sync — 5 devem dar 200, 6ª deve dar 429
for i in 1 2 3 4 5 6; do
  echo "Call $i:"
  curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/admin/billing/sync \
    -H "Authorization: Bearer <TOKEN>"
done
# Esperado: 200 200 200 200 200 429
```

Encerrar o servidor (Ctrl-C). Restaurar.

---

## Task 5: PR — abrir pull request da fase F3

**Arquivo:** N/A — operação git/GitHub.

- [ ] **Step 1: Conferir status**

Run: `git status && git log --oneline main..HEAD`

Expected: 2 commits desta fase:
1. `feat(billing): throttle /admin/billing/sync 5/60s/IP (F3 R-F3-01 / A1)`
2. `feat(billing): timeout 10s + 504 em AsaasBillingProvider.request (F3 R-F3-02/03 / A2)`

- [ ] **Step 2: Push da branch**

Run: `git push -u origin feature/billing-hardening-f3-crons-http`

- [ ] **Step 3: Abrir PR via `gh`**

```bash
gh pr create --title "feat(billing): F3 — hardening crons/HTTP (A1 + A2)" --body "$(cat <<'EOF'
## Summary

Fase F3 do [spec billing-hardening-v2](docs/superpowers/specs/2026-05-21-billing-hardening-v2-design.md). Fecha 2 vetores de severidade alta:

- **A1**: `POST /admin/billing/sync` sem `@Throttle`. Tenant past_due podia disparar 1000 req/s contra Asaas → risco de rate-limit da nossa conta inteira (Asaas é por API key). Throttle 5/60s/IP — generoso pra polling legítimo pós-pagamento, ainda fecha abuso de bot. **D-06.**
- **A2**: `fetch()` ao Asaas sem timeout. Asaas lento → workers NestJS pendurados → 503 em endpoints legítimos (checkout do barbeiro novo trava). `AbortSignal.timeout(10_000)` em todas as chamadas; `TimeoutError`/`AbortError` mapeados pra `DomainException BILLING_PROVIDER_ERROR` HTTP 504 com `{ method, path }` nos details. **D-07.**

Sem mudança de schema, sem novo endpoint, sem novo env var.

## Test plan
- [x] Unit: 4 novos testes em `asaas.billing-provider.spec.ts` (signal passado / TimeoutError 504 / AbortError 504 / method+path nos details)
- [x] E2E: novo spec `billing-sync-throttle.e2e-spec.ts` (5 OK + 6ª 429)
- [x] Unit: `pnpm jest src/modules/billing/` 100% verde
- [x] E2E: `pnpm test:e2e -- billing` 100% verde (6 specs)
- [x] Lint + build: `pnpm lint && pnpm build`
- [x] Smoke manual: 6 calls em /sync — 5 200 + 1 429

## Anti-acceptance verificado
- ❌ `fetch` ao Asaas sem `signal: AbortSignal.timeout(...)` → grep confirma signal presente
- ❌ Timeout retorna 500 → testado: DomainException usa HttpStatus.GATEWAY_TIMEOUT (504)
- ❌ Throttle do /sync mais restritivo que 5/60s → spec linha exata `{ limit: 5, ttl: 60_000 }`
- ❌ Mudança em `runBillingSync` retry logic → 0 linhas mudadas em billing.processor.ts / billing.schedules.ts
- ❌ Retry exponencial adicionado dentro de `request()` → não adicionado (já existe SYNC_RETRY_BACKOFF_MS no cycle)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Aguardar CI**

Acompanhar checks do PR. Se verde, mergear (squash) em `main`.

---

## Self-Review (post-write checklist)

Verificado contra a spec antes de entregar:

**1. Cobertura R-F3-NN:**
- R-F3-01 (`@Throttle({limit:5, ttl:60_000})` em POST /admin/billing/sync) → Task 2 ✅
- R-F3-02 (`signal: AbortSignal.timeout(10_000)` no fetch do AsaasBillingProvider.request) → Task 3 Step 3 ✅
- R-F3-03 (capturar TimeoutError/AbortError → DomainException BILLING_PROVIDER_ERROR status 504 com `{ method, path }`) → Task 3 Step 3 ✅
- R-F3-04 (testes — E2E throttle 6 calls + unit timeout > 10s mock) → Task 2 (E2E) + Task 3 Step 1 (4 unit tests) ✅

**2. Acceptance criteria do spec §9:**
- "POST /admin/billing/sync tem `@Throttle({ default: { limit: 5, ttl: 60_000 } })`" → Task 4 Step 2 (grep) ✅
- "6ª chamada em 60s no mesmo IP retorna 429" → Task 2 Step 1 (test cobre exatamente isso) ✅
- "Mock de Asaas com latência > 10s faz `runBillingSync` (cron) registrar failure + agendar retry; não pendura worker" → coberto indiretamente: timeout aborta a request, propaga DomainException 504, runBillingSync trata como erro normal e o cycle do BullMQ aplica retry backoff (`SYNC_RETRY_BACKOFF_MS`) sem mudança no processor. Validação operacional após deploy (não testável em unit sem mock complexo de cron+latência).
- "Chamada manual `POST /admin/billing/sync` com Asaas indisponível retorna 504 BILLING_PROVIDER_ERROR em < 11s" → coberto pela unit do provider (Task 3 Step 1 — 4 testes). E2E end-to-end seria custoso (precisa mock do Asaas no scope do controller); o domínio do AbortSignal está bem isolado e testado em unit.
- "`pnpm test`, `pnpm test:e2e`, `pnpm lint`, `pnpm build` verdes" → Task 4 Steps 3-7 ✅

**3. Anti-acceptance do spec §9:**
- ❌ `fetch` ao Asaas sem `signal: AbortSignal.timeout(...)` → Task 4 Step 1 (grep) ✅
- ❌ Timeout retorna 500 (deve ser 504) → Task 3 Step 1 testes asseguram `HttpStatus.GATEWAY_TIMEOUT` ✅
- ❌ Throttle do `/sync` mais restritivo que 5/60s (3/60s seria apertado) → Task 2 Step 3 código literal `{ limit: 5, ttl: 60_000 }` ✅
- ❌ Mudança no `runBillingSync` retry logic → não tocado (Task 3 só muda `asaas.billing-provider.ts:request`) ✅

**4. Fora de escopo respeitado (spec §9):**
- ❌ Retry exponencial dentro do `request()` → não adicionado
- ❌ Circuit breaker pra Asaas → não adicionado
- ❌ Mudança no timeout do `node-fetch` global → não tocado (usamos AbortSignal localmente, como o spec pede)

**5. Placeholder scan:** nenhum TBD/TODO/placeholder no plano. Todos os steps mostram código exato.

**6. Type consistency:**
- `HttpStatus.GATEWAY_TIMEOUT` (literal 504 do NestJS) — usado consistente no código de produção (Task 3 Step 3) e nos testes (Task 3 Step 1).
- `DomainException` com formato `{ code, message, status, details }` — espelha o uso pré-existente nas linhas 248-261 do `asaas.billing-provider.ts`.
- `ErrorCodes.BILLING_PROVIDER_ERROR` — confirmado existir em `error-codes.ts:52` (Task 1 Step 4).
- Sintaxe `@Throttle({ default: { limit: N, ttl: 60_000 } })` — consistente com `/checkout` linha 51 e `/login` (auth controller).

**7. Conhecidos pontos frágeis (mitigados):**
- Testes de timeout NÃO esperam 10s real — mockam `fetchMock.mockRejectedValueOnce(new DOMException(..., 'TimeoutError'))` (Task 3 Step 1). Trade-off: não validamos AbortSignal real disparando, mas validamos (a) signal está presente no init do fetch [primeiro teste], (b) o mapping do erro é correto [demais testes]. Validar real timeout custaria 10s+ por test, inviável.
- `provider.healthCheck` engole exceptions e retorna `{ ok: false }` — por isso o teste de timeout usa `provider.listPayments` (propaga). Comportamento de `healthCheck` mantido intacto pra não regredir uso em `/health/ready`.

---

## Histórico

| Data | Mudança |
|---|---|
| 2026-05-21 | Versão inicial. Plano executável da F3 (hardening crons/HTTP). Spec: `2026-05-21-billing-hardening-v2-design.md`. |
