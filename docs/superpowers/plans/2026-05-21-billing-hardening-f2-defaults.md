# Billing Hardening F2 — Defaults Defensivos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fechar os vetores C2, C3 e C4 da auditoria 2026-05-21 substituindo todos os fallbacks `??` envolvendo config de billing por `config.getOrThrow(...)` (deixando Joi como única source of truth) e envolvendo o registro dos schedulers em try/catch + re-throw pra que o boot falhe visível se Redis/BullMQ estiver indisponível.

**Architecture:** Mudança puramente runtime (sem schema, sem endpoint, sem migration). Fix em 2 arquivos do módulo billing (`billing.service.ts`, `billing.schedules.ts`) + ajuste de mocks de teste existentes (porque `mkConfig` em 3 spec files devolve `{ get }` mas não `{ getOrThrow }`, o que quebraria os testes assim que o código de produção mudar). Cria spec novo `billing.schedules.spec.ts` (não existe hoje) cobrindo R-F2-05.

**Tech Stack:** NestJS 11 (`ConfigService.getOrThrow`), BullMQ (Queue.upsertJobScheduler), Jest, Joi (defaults em `src/config/env.validation.ts`).

**Spec source-of-truth:** [`docs/superpowers/specs/2026-05-21-billing-hardening-v2-design.md`](../specs/2026-05-21-billing-hardening-v2-design.md) §8 (Fase F2, R-F2-01 a R-F2-07).

---

## File Structure

**Arquivos modificados:**
- `src/modules/billing/billing.service.ts` — 3 trocas de `?? <n>` por `getOrThrow` (linhas 48, 109, 416)
- `src/modules/billing/billing.schedules.ts` — 2 trocas de `?? '<cron>'` por `getOrThrow` (linhas 22-23) + try/catch envolvendo os 2 `upsertJobScheduler` (linhas 25-34) com log estruturado + re-throw
- `src/modules/billing/billing.service.spec.ts` — `mkConfig` ganha `getOrThrow` no mock retornando o mesmo `map[k]` (lança se `undefined`)
- `src/modules/billing/billing.cron.spec.ts` — idem (mkConfig precisa `getOrThrow`)
- `src/modules/billing/billing.checkout.spec.ts` — idem

**Arquivos criados:**
- `src/modules/billing/billing.schedules.spec.ts` — unit spec novo cobrindo: (a) registra os 2 schedulers em boot normal; (b) skip silencioso em `NODE_ENV=test`; (c) re-throws se `upsertJobScheduler` falhar; (d) log `billing.schedules_registration_failed` antes do re-throw

**Não modificar nesta fase:**
- `.env.example` — defaults já estão corretos (`BILLING_PAST_DUE_GRACE_DAYS=1`, `BILLING_SYNC_CRON=0 * * * *`) — confirmado em pre-flight.
- `src/config/env.validation.ts` — Joi defaults já estão corretos (`default(1)`, `default('0 * * * *')`) — confirmado em pre-flight.
- `src/modules/ai-visagism/ai-visagism.schedules.ts` — tem padrão `??` similar mas está **fora do escopo** da spec F2 (spec é explicitamente backend billing). Anotar como follow-up.

**Convenções respeitadas:**
- pt-BR em mensagens de log estruturado e erros (`Failed to register billing schedulers`).
- Logger estruturado via `nestjs-pino` com `event: '...'` como convenção (igual ao `billing.schedules_registered` existente).
- Não importar `Sentry` manualmente — integração NestJS captura exceptions não tratadas em lifecycle hooks (R-F2-06).

---

## Task 0: Recall — re-ler spec e fazer echo-back

**Arquivo:** N/A (etapa de leitura/raciocínio, sem código).

- [ ] **Step 1: Re-ler ambos os specs**

Ler na íntegra (sem skip):
1. `docs/superpowers/specs/2026-05-21-billing-hardening-v2-design.md`
2. `docs/superpowers/specs/2026-05-20-trial-grace-tightening-design.md`

- [ ] **Step 2: Responder echo-back de 5 bullets na resposta da Task 0**

Responder textualmente (não commitar):

1. Quais invariants (INV-01 a INV-16) são relevantes pra F2?
   *Esperado: **INV-14** (Joi como única fonte de defaults de billing — `??` proibido) e **INV-15** (boot falha visível sem Redis/BullMQ; re-throw obrigatório). INV-01 a INV-13 e INV-16 não tocam F2 diretamente, mas INV-07 (404 em past_due) continua valendo no resto do sistema.*
2. Que decisões eu posso ferir sem perceber?
   *Esperado: **D-05** (re-throw, não logar e continuar; não fazer retry interno antes do throw — mascara bug de config). **D-10** (essa é a PR da fase F2, não bundle com F3/F4). Cuidado em não introduzir Sentry manual: o spec diz integração NestJS captura automaticamente (R-F2-06).*
3. Quais requirements R-F2-NN são meu escopo?
   *Esperado: **R-F2-01 a R-F2-07** (1: linha 109 service / 2: linha 416 service / 3: linha 48 service / 4: linhas 22-23 schedules / 5: try/catch boot / 6: doc sobre Sentry / 7: testes).*
4. Qual anti-acceptance protege de scope creep?
   *Esperado: ❌ qualquer `??` envolvendo `BILLING_*` em service/schedules; ❌ app sobe sem crons registrados; ❌ exception silenciada (sem re-throw); ❌ mudança em `.env.example` (defaults já corretos).*
5. Qual recall-check de teste prova que não quebrei reativação?
   *Esperado: `billing-cron-sync.e2e-spec.ts` + `billing-trial-check.e2e-spec.ts` continuam verdes (cron de sync e trial-check exercitam o caminho de mudança status `past_due → cancelled` baseado em grace days — se o número trocou de `7` pra `getOrThrow` retornando o env (default Joi `1`), os testes que setam `BILLING_PAST_DUE_GRACE_DAYS` explícito continuam OK). Reativação propriamente dita (past_due → checkout → sync → active) é exercitada por `billing-checkout.e2e-spec.ts` e `billing-cron-sync.e2e-spec.ts` — não tocados.*

---

## Task 1: Pre-flight — confirmar Joi defaults e `.env.example` estão corretos

**Arquivo:** N/A (verificação read-only).

**Por que:** A spec assume que Joi schema é a source of truth. Antes de remover os `??`, confirmar que (a) Joi tem `default(...)` pra todas as 4 envs afetadas e (b) `.env.example` reflete os valores corretos. Se algum `default` estiver faltando no Joi, o `getOrThrow` quebra mesmo com env vazia (que é o comportamento desejado, mas precisa ser intencional).

- [ ] **Step 1: Conferir defaults Joi**

Run: `grep -nE 'BILLING_(PAST_DUE_GRACE_DAYS|TRIAL_DAYS|SYNC_CRON|TRIAL_CHECK_CRON)' src/config/env.validation.ts`

Expected output (linhas 65-68):
```
65:  BILLING_TRIAL_DAYS: Joi.number().integer().min(0).max(60).default(3),
66:  BILLING_PAST_DUE_GRACE_DAYS: Joi.number().integer().min(0).max(60).default(1),
67:  BILLING_SYNC_CRON: Joi.string().default('0 * * * *'),
68:  BILLING_TRIAL_CHECK_CRON: Joi.string().default('15 6 * * *'),
```

Se algum `.default(...)` estiver faltando: **PARAR** e ajustar `env.validation.ts` antes de prosseguir (não está no escopo do plano mas é pré-requisito).

- [ ] **Step 2: Conferir `.env.example`**

Run: `grep -nE 'BILLING_(PAST_DUE_GRACE_DAYS|TRIAL_DAYS|SYNC_CRON|TRIAL_CHECK_CRON)' .env.example`

Expected (linhas 50-53):
```
50:BILLING_TRIAL_DAYS=3
51:BILLING_PAST_DUE_GRACE_DAYS=1
52:BILLING_SYNC_CRON=0 * * * *
53:BILLING_TRIAL_CHECK_CRON=15 6 * * *
```

- [ ] **Step 3: Confirmar `getOrThrow` existe no `ConfigService` (NestJS 11)**

Run: `grep -rn "getOrThrow" src/ | head -5`

Expected: já existe em `auth/tokens.service.ts`, `storage/providers/r2-storage.provider.ts`, `ai-visagism/...`. Padrão confirmado no codebase.

---

## Task 2: Ajustar `mkConfig` mocks pra suportar `getOrThrow` (TDD pre-step)

**Arquivo:** `src/modules/billing/billing.service.spec.ts` + `billing.cron.spec.ts` + `billing.checkout.spec.ts`.

**Por que:** Os 3 spec files atualmente devolvem `{ get: (k) => map[k] } as ConfigService`. Quando o código de produção trocar pra `getOrThrow`, o mock retornará `undefined` (porque `getOrThrow` não existe no objeto) — TypeScript permite porque o cast `as ConfigService` é falso-positivo. Resultado: `TypeError: this.config.getOrThrow is not a function`. Esta task atualiza os mocks **antes** de mexer no código de produção, pra que os testes existentes não falhem por motivo errado quando Tasks 3-5 rodarem.

**Comportamento desejado do mock:** `getOrThrow<T>(k)` retorna `map[k]` se a chave existe, lança `Error("Configuration key \"K\" does not exist")` se não existe (espelha o comportamento real do NestJS).

- [ ] **Step 1: Atualizar `billing.service.spec.ts` — modificar `mkConfig`**

Localizar (linhas 33-42):
```ts
function mkConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const map: Record<string, unknown> = {
    BILLING_TRIAL_DAYS: 14,
    BILLING_PAST_DUE_GRACE_DAYS: 1,
    MP_PLAN_AMOUNT_CENTS: 4990,
    MP_BILLING_FREQUENCY: 'months',
    ...overrides,
  };
  return { get: (k: string) => map[k] } as ConfigService;
}
```

Substituir o `return` por:
```ts
  return {
    get: (k: string) => map[k],
    getOrThrow: (k: string) => {
      if (!(k in map)) throw new Error(`Configuration key "${k}" does not exist`);
      return map[k];
    },
  } as unknown as ConfigService;
}
```

- [ ] **Step 2: Atualizar `billing.cron.spec.ts` — modificar `mkConfig`**

Localizar (linhas 26-32):
```ts
function mkConfig(): ConfigService {
  const map: Record<string, unknown> = {
    BILLING_TRIAL_DAYS: 14,
    BILLING_PAST_DUE_GRACE_DAYS: 7,
  };
  return { get: (k: string) => map[k] } as ConfigService;
}
```

Substituir o `return` por:
```ts
  return {
    get: (k: string) => map[k],
    getOrThrow: (k: string) => {
      if (!(k in map)) throw new Error(`Configuration key "${k}" does not exist`);
      return map[k];
    },
  } as unknown as ConfigService;
}
```

- [ ] **Step 3: Atualizar `billing.checkout.spec.ts` — modificar `mkConfig`**

Localizar (linhas 26-35):
```ts
function mkConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const map: Record<string, unknown> = {
    BILLING_PROVIDER: 'mercadopago',
    BILLING_TRIAL_DAYS: 14,
    MP_PLAN_AMOUNT_CENTS: 4990,
    MP_BILLING_FREQUENCY: 'months',
    ...overrides,
  };
  return { get: (k: string) => map[k] } as ConfigService;
}
```

Substituir o `return` por:
```ts
  return {
    get: (k: string) => map[k],
    getOrThrow: (k: string) => {
      if (!(k in map)) throw new Error(`Configuration key "${k}" does not exist`);
      return map[k];
    },
  } as unknown as ConfigService;
}
```

- [ ] **Step 4: Rodar specs atualmente verdes — devem continuar verdes (sem mudança de código de produção)**

Run: `pnpm jest src/modules/billing/billing.service.spec.ts src/modules/billing/billing.cron.spec.ts src/modules/billing/billing.checkout.spec.ts`

Expected: **todos passam** (mudança é só adicionar método extra no mock; código de produção ainda usa `get`, não `getOrThrow`).

- [ ] **Step 5: Commit**

```bash
git add src/modules/billing/billing.service.spec.ts src/modules/billing/billing.cron.spec.ts src/modules/billing/billing.checkout.spec.ts
git commit -m "test(billing): mock getOrThrow em mkConfig pra suportar F2 defaults"
```

---

## Task 3: TDD — `runTrialCheck` deve propagar erro se `BILLING_PAST_DUE_GRACE_DAYS` ausente (C2, R-F2-02)

**Arquivo:** `src/modules/billing/billing.service.spec.ts` (modificar) + `src/modules/billing/billing.service.ts:416` (modificar).

**Por que:** Este é o **fix principal** da fase. `billing.service.ts:416` (`runTrialCheck`) usa `?? 7` — qualquer mudança no schema ou env vazia faz o cron silenciosamente esperar 7 dias enquanto banner mostra "0". A nova garantia: se a env desaparecer, o cron explode em vez de "regredir silenciosamente".

- [ ] **Step 1: Escrever o teste que falha primeiro**

Localizar o describe `runTrialCheck` em `billing.service.spec.ts` (procurar por `describe('runTrialCheck'` — provavelmente perto da linha 300+).

Adicionar este teste no fim do describe `runTrialCheck` (antes do `});` que fecha):

```ts
    it('propaga erro se BILLING_PAST_DUE_GRACE_DAYS ausente na config (sem fallback silencioso)', async () => {
      // Recria service com mkConfig que NÃO tem BILLING_PAST_DUE_GRACE_DAYS — simula
      // a env removida em runtime. Antes do fix F2, o `?? 7` mascarava isso e o cron
      // esperava 7 dias silenciosamente. Após o fix, getOrThrow propaga e o cron falha
      // ruidoso — Sentry/Pino capturam, ops investiga.
      const configWithoutGrace = {
        get: (k: string) =>
          k === 'BILLING_PAST_DUE_GRACE_DAYS' ? undefined : ({ BILLING_TRIAL_DAYS: 14 } as any)[k],
        getOrThrow: (k: string) => {
          if (k === 'BILLING_PAST_DUE_GRACE_DAYS') {
            throw new Error('Configuration key "BILLING_PAST_DUE_GRACE_DAYS" does not exist');
          }
          return ({ BILLING_TRIAL_DAYS: 14 } as any)[k];
        },
      } as unknown as ConfigService;

      const svcSemGrace = new BillingService(
        repo as unknown as SubscriptionRepository,
        provider,
        configWithoutGrace,
        new Logger('test'),
        audit as unknown as AuditService,
      );

      repo.findExpiredTrials.mockResolvedValue([]);
      // findPastDueOverGrace é chamado DEPOIS do graceDays — então o getOrThrow já estourou.
      await expect(svcSemGrace.runTrialCheck()).rejects.toThrow(
        /BILLING_PAST_DUE_GRACE_DAYS/,
      );
    });
```

- [ ] **Step 2: Rodar — deve falhar**

Run: `pnpm jest src/modules/billing/billing.service.spec.ts -t "propaga erro se BILLING_PAST_DUE_GRACE_DAYS ausente"`

Expected: **FAIL** — o teste espera throw mas o código atual usa `?? 7`, então passa pelo `undefined ?? 7 = 7` e não throws.

- [ ] **Step 3: Aplicar o fix em `billing.service.ts:416`**

Localizar:
```ts
    const graceDays = this.config.get<number>('BILLING_PAST_DUE_GRACE_DAYS') ?? 7;
```

Substituir por:
```ts
    const graceDays = this.config.getOrThrow<number>('BILLING_PAST_DUE_GRACE_DAYS');
```

- [ ] **Step 4: Rodar — deve passar**

Run: `pnpm jest src/modules/billing/billing.service.spec.ts -t "propaga erro se BILLING_PAST_DUE_GRACE_DAYS ausente"`

Expected: **PASS**.

- [ ] **Step 5: Rodar todo o spec — não pode quebrar nada**

Run: `pnpm jest src/modules/billing/billing.service.spec.ts`

Expected: **todos passam** (mkConfig default tem `BILLING_PAST_DUE_GRACE_DAYS: 1`, então `getOrThrow` retorna 1 normalmente nos testes existentes).

- [ ] **Step 6: Rodar billing.cron.spec — também tem BILLING_PAST_DUE_GRACE_DAYS: 7 no mock**

Run: `pnpm jest src/modules/billing/billing.cron.spec.ts`

Expected: **todos passam**.

- [ ] **Step 7: Commit**

```bash
git add src/modules/billing/billing.service.ts src/modules/billing/billing.service.spec.ts
git commit -m "fix(billing): trocar ?? 7 por getOrThrow em runTrialCheck (C2 — Joi como source of truth)"
```

---

## Task 4: Trocar `?? 1` por `getOrThrow` em `getBillingStatus` (R-F2-01, linha 109)

**Arquivo:** `src/modules/billing/billing.service.ts:109`.

**Por que:** Mesmo padrão de C2 mas no caminho do banner (`getBillingStatus`). Spec INV-14 proíbe `??` aqui também. Mock dos testes já foi ajustado em Task 2, então não quebra.

- [ ] **Step 1: Localizar a linha 109 de `billing.service.ts`**

Localizar:
```ts
      const graceDays = this.config.get<number>('BILLING_PAST_DUE_GRACE_DAYS') ?? 1;
```

Substituir por:
```ts
      const graceDays = this.config.getOrThrow<number>('BILLING_PAST_DUE_GRACE_DAYS');
```

- [ ] **Step 2: Rodar billing.service.spec.ts — não pode quebrar**

Run: `pnpm jest src/modules/billing/billing.service.spec.ts`

Expected: **todos passam** (mock de mkConfig tem `BILLING_PAST_DUE_GRACE_DAYS: 1`, getOrThrow retorna 1).

- [ ] **Step 3: Commit**

```bash
git add src/modules/billing/billing.service.ts
git commit -m "fix(billing): trocar ?? 1 por getOrThrow em getBillingStatus (alinhando INV-14)"
```

---

## Task 5: Trocar `?? 3` por `getOrThrow` em `startTrial` (R-F2-03, linha 48)

**Arquivo:** `src/modules/billing/billing.service.ts:48`.

**Por que:** Não é uma discrepância como C2, mas é a mesma classe de bug preventivo — `startTrial` é chamado em `registerOwner`. Se `BILLING_TRIAL_DAYS` desaparecer, queremos boot/runtime visível, não trial de 3 dias por padrão silencioso.

- [ ] **Step 1: Localizar a linha 48 de `billing.service.ts`**

Localizar:
```ts
    const trialDays = this.config.get<number>('BILLING_TRIAL_DAYS') ?? 3;
```

Substituir por:
```ts
    const trialDays = this.config.getOrThrow<number>('BILLING_TRIAL_DAYS');
```

- [ ] **Step 2: Rodar TODOS os specs do billing — `startTrial` é exercitado por vários**

Run: `pnpm jest src/modules/billing/`

Expected: **todos passam** (todos os mkConfig têm `BILLING_TRIAL_DAYS` populado).

- [ ] **Step 3: Verificar grep — não pode sobrar nenhum `??` em billing.service.ts envolvendo BILLING_***

Run: `grep -n 'BILLING_.*??' src/modules/billing/billing.service.ts`

Expected: **0 linhas** (nenhuma match).

- [ ] **Step 4: Commit**

```bash
git add src/modules/billing/billing.service.ts
git commit -m "fix(billing): trocar ?? 3 por getOrThrow em startTrial (fechando INV-14 em billing.service)"
```

---

## Task 6: Trocar fallbacks de cron por `getOrThrow` em `billing.schedules.ts` (R-F2-04, linhas 22-23)

**Arquivo:** `src/modules/billing/billing.schedules.ts:22-23`.

**Por que:** Fix do C3 — fallback `'0 6,18 * * *'` (2×/dia) discordando do Joi default `'0 * * * *'` (1×/hora). Mesmo padrão de C2 mas pra cron string. Inclui também `BILLING_TRIAL_CHECK_CRON` no mesmo movimento (mesma classe de bug, fix preventivo).

- [ ] **Step 1: Localizar linhas 22-23 de `billing.schedules.ts`**

Localizar:
```ts
    const syncCron = this.config.get<string>('BILLING_SYNC_CRON') ?? '0 6,18 * * *';
    const trialCron = this.config.get<string>('BILLING_TRIAL_CHECK_CRON') ?? '15 6 * * *';
```

Substituir por:
```ts
    const syncCron = this.config.getOrThrow<string>('BILLING_SYNC_CRON');
    const trialCron = this.config.getOrThrow<string>('BILLING_TRIAL_CHECK_CRON');
```

- [ ] **Step 2: Verificar grep — nenhum `??` envolvendo BILLING_* em schedules**

Run: `grep -n 'BILLING_.*??' src/modules/billing/billing.schedules.ts`

Expected: **0 linhas**.

- [ ] **Step 3: Rodar lint + build — schedules ainda não tem spec, só conferir tipos**

Run: `pnpm lint && pnpm build`

Expected: **0 erros**.

- [ ] **Step 4: Commit**

```bash
git add src/modules/billing/billing.schedules.ts
git commit -m "fix(billing): trocar ?? '<cron>' por getOrThrow em BillingSchedules (C3 — fim da discrepância 2x/dia vs 1x/hora)"
```

---

## Task 7: Criar `billing.schedules.spec.ts` — primeiro teste de boot normal (preparação pra Task 8 TDD)

**Arquivo:** `src/modules/billing/billing.schedules.spec.ts` (NOVO).

**Por que:** R-F2-07 do spec menciona "Unit em `billing.schedules.spec.ts` (criar se não existir): simular `queue.upsertJobScheduler` rejeitando → `onApplicationBootstrap` re-throws com mensagem específica." Esta task cria o esqueleto + um teste do happy path, depois Task 8 adiciona o teste de re-throw via TDD.

- [ ] **Step 1: Criar o arquivo com esqueleto + teste de boot normal**

Criar `src/modules/billing/billing.schedules.spec.ts`:

```ts
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { BillingSchedules } from './billing.schedules';
import {
  BILLING_SYNC_JOB_KEY,
  TRIAL_CHECK_JOB_KEY,
} from './billing.constants';
import {
  JOB_BILLING_SYNC,
  JOB_TRIAL_CHECK,
} from 'src/infra/queues/queue-names';

function mkQueue() {
  return {
    upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
  } as unknown as Queue & { upsertJobScheduler: jest.Mock };
}

function mkConfig(map: Record<string, unknown> = {}): ConfigService {
  const merged: Record<string, unknown> = {
    NODE_ENV: 'development',
    BILLING_SYNC_CRON: '0 * * * *',
    BILLING_TRIAL_CHECK_CRON: '15 6 * * *',
    ...map,
  };
  return {
    get: (k: string) => merged[k],
    getOrThrow: (k: string) => {
      if (!(k in merged)) throw new Error(`Configuration key "${k}" does not exist`);
      return merged[k];
    },
  } as unknown as ConfigService;
}

describe('BillingSchedules', () => {
  describe('onApplicationBootstrap — happy path', () => {
    it('registra os 2 schedulers (sync + trial-check) com os crons da config', async () => {
      const queue = mkQueue();
      const schedules = new BillingSchedules(queue, mkConfig());

      await schedules.onApplicationBootstrap();

      expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(2);
      expect(queue.upsertJobScheduler).toHaveBeenNthCalledWith(
        1,
        BILLING_SYNC_JOB_KEY,
        { pattern: '0 * * * *', tz: 'UTC' },
        { name: JOB_BILLING_SYNC, data: {} },
      );
      expect(queue.upsertJobScheduler).toHaveBeenNthCalledWith(
        2,
        TRIAL_CHECK_JOB_KEY,
        { pattern: '15 6 * * *', tz: 'UTC' },
        { name: JOB_TRIAL_CHECK, data: {} },
      );
    });

    it('skip silencioso quando NODE_ENV=test (não registra nada)', async () => {
      const queue = mkQueue();
      const schedules = new BillingSchedules(queue, mkConfig({ NODE_ENV: 'test' }));

      await schedules.onApplicationBootstrap();

      expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Rodar — deve passar (código atual já faz isso)**

Run: `pnpm jest src/modules/billing/billing.schedules.spec.ts`

Expected: **2 testes verdes**.

- [ ] **Step 3: Commit**

```bash
git add src/modules/billing/billing.schedules.spec.ts
git commit -m "test(billing): adicionar spec inicial de BillingSchedules (happy path + skip em test)"
```

---

## Task 8: TDD — boot re-throws se Redis/BullMQ indisponível (R-F2-05, INV-15, D-05)

**Arquivo:** `src/modules/billing/billing.schedules.spec.ts` (modificar) + `src/modules/billing/billing.schedules.ts` (modificar).

**Por que:** Esta é a outra parte crítica da fase. Sem webhook do gateway, o cron é o **único sinal** de OVERDUE — silenciar falha de boot = trial infinito + past_due nunca detectado. INV-15 + D-05 exigem re-throw visível.

- [ ] **Step 1: Escrever os 2 testes que falham primeiro**

Adicionar no `billing.schedules.spec.ts`, **dentro** do `describe('BillingSchedules', () => {`, **depois** do describe `'onApplicationBootstrap — happy path'`:

```ts
  describe('onApplicationBootstrap — falha de Redis/BullMQ', () => {
    it('re-throws com mensagem específica se upsertJobScheduler rejeitar', async () => {
      const queue = mkQueue();
      (queue.upsertJobScheduler as jest.Mock).mockRejectedValueOnce(
        new Error('ECONNREFUSED 127.0.0.1:6379'),
      );
      const schedules = new BillingSchedules(queue, mkConfig());

      await expect(schedules.onApplicationBootstrap()).rejects.toThrow(
        /Failed to register billing schedulers.*ECONNREFUSED/,
      );
    });

    it('loga billing.schedules_registration_failed antes do re-throw (com error e stack)', async () => {
      const queue = mkQueue();
      const upstreamError = new Error('Redis offline');
      (queue.upsertJobScheduler as jest.Mock).mockRejectedValueOnce(upstreamError);
      const schedules = new BillingSchedules(queue, mkConfig());

      // Stub do logger interno do NestJS (Logger instanciado via new Logger(name) usa
      // o consoleLogger por padrão; o jeito ergonômico é spy no método error do logger
      // privado).
      const errorSpy = jest
        .spyOn((schedules as unknown as { logger: { error: jest.Mock } }).logger, 'error')
        .mockImplementation(() => undefined as never);

      await expect(schedules.onApplicationBootstrap()).rejects.toThrow();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'billing.schedules_registration_failed',
          error: 'Redis offline',
          stack: expect.any(String),
        }),
      );
    });
  });
```

- [ ] **Step 2: Rodar — devem falhar**

Run: `pnpm jest src/modules/billing/billing.schedules.spec.ts -t "falha de Redis/BullMQ"`

Expected: **2 FAILs** — código atual não tem try/catch, então o reject do `upsertJobScheduler` propaga como `Error('ECONNREFUSED ...')` cru, não como "Failed to register billing schedulers: ...". E não loga `billing.schedules_registration_failed`.

- [ ] **Step 3: Aplicar o fix em `billing.schedules.ts`**

Localizar (linhas 25-34 — depois da extração dos crons):
```ts
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
```

Substituir por:
```ts
    try {
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
    } catch (err) {
      // INV-15 + D-05: crash visível >> trial infinito silencioso. Sem webhook do
      // gateway, este cron é o único sinal de OVERDUE — se não registrar, ninguém
      // detecta past_due. Sentry captura exceptions não tratadas em lifecycle hooks
      // via integração NestJS (sem captureException manual). Railway re-tenta deploy.
      this.logger.error({
        event: 'billing.schedules_registration_failed',
        error: (err as Error).message,
        stack: (err as Error).stack,
      });
      throw new Error(
        `Failed to register billing schedulers: ${(err as Error).message}`,
      );
    }
```

- [ ] **Step 4: Rodar — devem passar**

Run: `pnpm jest src/modules/billing/billing.schedules.spec.ts`

Expected: **4 testes verdes** (2 do happy path + 2 do failure path).

- [ ] **Step 5: Lint + build**

Run: `pnpm lint && pnpm build`

Expected: **0 erros**.

- [ ] **Step 6: Commit**

```bash
git add src/modules/billing/billing.schedules.ts src/modules/billing/billing.schedules.spec.ts
git commit -m "fix(billing): try/catch + re-throw em onApplicationBootstrap (C4 — INV-15 boot falha visível sem Redis)"
```

---

## Task 9: Verificação final — full test suite + grep de invariants

**Arquivo:** N/A (verificação).

- [ ] **Step 1: Grep — nenhum `??` envolvendo `BILLING_*` em service ou schedules**

Run: `grep -nE 'BILLING_.*\?\?' src/modules/billing/billing.service.ts src/modules/billing/billing.schedules.ts`

Expected: **0 linhas**. Se voltar algo, **PARAR** e remover.

- [ ] **Step 2: Lint**

Run: `pnpm lint`

Expected: **0 errors, 0 warnings novos** (warnings pré-existentes do projeto continuam OK).

- [ ] **Step 3: Build TypeScript**

Run: `pnpm build`

Expected: **build OK**.

- [ ] **Step 4: Suíte unit completa**

Run: `pnpm test`

Expected: **todos verdes**. Se algum spec fora do billing quebrar por causa de `mkConfig` próprio sem `getOrThrow`, ajustar pontualmente (não esperado — só `BillingService` foi tocado nessa direção).

- [ ] **Step 5: E2E billing — pelo menos os 5 do billing**

Run: `pnpm test:e2e -- billing`

Expected: **todos verdes** (`billing-admin-gating`, `billing-checkout`, `billing-cron-sync`, `billing-past-due-gating`, `billing-trial-check`). Estes exercitam o caminho real do `runTrialCheck` e `getBillingStatus` com env real — se algo regredir aqui, é red flag.

- [ ] **Step 6: Smoke manual local — boot com env válida**

Run: `pnpm start:dev` (com Postgres+Redis up via `docker compose up -d postgres redis`).

Expected nos logs:
- `billing.schedules_registered` com `syncCron: "0 * * * *"`, `trialCron: "15 6 * * *"`.
- Aplicação responde em `GET /health/ready`.

Abortar com Ctrl-C após confirmar.

- [ ] **Step 7: Smoke manual local — boot com Redis fora (simula INV-15)**

Run:
```bash
docker compose stop redis
pnpm start:dev
```

Expected:
- Log `billing.schedules_registration_failed` com `error: "..."` e `stack: "..."`.
- Processo **encerra com erro não-zero** (NestJS aborta bootstrap).
- Mensagem final inclui `Failed to register billing schedulers: ...`.

**Restaurar:** `docker compose start redis`.

- [ ] **Step 8: Smoke manual — boot com env crítica faltando**

Run:
```bash
# Salvar .env e remover BILLING_PAST_DUE_GRACE_DAYS
cp .env .env.backup
sed -i '/^BILLING_PAST_DUE_GRACE_DAYS=/d' .env
pnpm start:dev
```

Expected:
- Como Joi tem `default(1)`, app sobe normalmente com `BILLING_PAST_DUE_GRACE_DAYS=1` (default Joi). Esse é o comportamento desejado: defaults vivem no Joi, código produção depende dele via `getOrThrow`.
- Log `billing.schedules_registered`.

**Restaurar:** `mv .env.backup .env`.

- [ ] **Step 9: Smoke manual — Joi sem default** (opcional, ilustra D-05)

Pra provar que `getOrThrow` realmente quebra se Joi mudar: editar **temporariamente** `src/config/env.validation.ts:66` removendo `.default(1)`. Boot deve falhar **pré-bootstrap** com mensagem do Joi:
```
"BILLING_PAST_DUE_GRACE_DAYS" is required
```

**Restaurar** o `.default(1)` imediatamente. **Não commitar.**

---

## Task 10: Atualizar CLAUDE.md do projeto (memória do que mudou)

**Arquivo:** N/A — Não é mudança de código. Skip se não há decisão arquitetural nova (a invariant INV-15 já está no spec).

- [ ] **Step 1: Verificar se CLAUDE.md do projeto precisa atualizar**

Run: `grep -n "INV-1[4-6]\|getOrThrow\|billing.schedules" CLAUDE.md 2>/dev/null || echo "nenhuma menção — OK pular"`

Decisão:
- Se nada relacionado, **pular** esta task (a fonte da verdade é o spec, CLAUDE.md aponta pra ele).
- Se houver menção desatualizada, atualizar pra refletir que defaults vêm de Joi via getOrThrow.

---

## Task 11: PR — abrir pull request da fase F2

**Arquivo:** N/A — operação git/GitHub.

- [ ] **Step 1: Conferir status**

Run: `git status && git log --oneline main..HEAD`

Expected: 5 commits desta fase (Tasks 2, 3, 4, 5, 6, 7, 8 — alguns merged):
1. `test(billing): mock getOrThrow em mkConfig`
2. `fix(billing): trocar ?? 7 por getOrThrow em runTrialCheck (C2)`
3. `fix(billing): trocar ?? 1 por getOrThrow em getBillingStatus`
4. `fix(billing): trocar ?? 3 por getOrThrow em startTrial`
5. `fix(billing): trocar ?? '<cron>' por getOrThrow em BillingSchedules (C3)`
6. `test(billing): adicionar spec inicial de BillingSchedules`
7. `fix(billing): try/catch + re-throw em onApplicationBootstrap (C4)`

- [ ] **Step 2: Push da branch**

Run: `git push -u origin <branch-name>`

- [ ] **Step 3: Abrir PR via `gh`**

```bash
gh pr create --title "fix(billing): F2 — defaults defensivos (C2 + C3 + C4)" --body "$(cat <<'EOF'
## Summary

Fase F2 do [spec billing-hardening-v2](docs/superpowers/specs/2026-05-21-billing-hardening-v2-design.md). Fecha 3 vetores críticos:

- **C2**: `runTrialCheck` (`billing.service.ts:416`) usava `?? 7` discordando do `?? 1` em `getBillingStatus`. Trocado por `getOrThrow` — Joi schema é a única source of truth.
- **C3**: `BillingSchedules` (`billing.schedules.ts:22`) usava fallback `'0 6,18 * * *'` (2×/dia) discordando do Joi default `'0 * * * *'` (1×/hora). Mesmo fix.
- **C4**: `onApplicationBootstrap` não tinha try/catch — falha do Redis no boot fazia o cron não registrar silenciosamente (e sem cron, sem detecção de past_due). Agora re-throws com log estruturado + Sentry via integração NestJS — Railway re-tenta deploy.

Também aplicado preventivamente:
- `startTrial` (linha 48): `?? 3` → `getOrThrow`
- `BILLING_TRIAL_CHECK_CRON` (linha 23 schedules): mesmo padrão

Sem mudança de schema, endpoint, ou comportamento externo observável quando env está válida.

## Test plan
- [x] Unit: novo `billing.schedules.spec.ts` (happy path + skip test + re-throw em falha de Redis)
- [x] Unit: novo teste em `billing.service.spec.ts` (`runTrialCheck` propaga se env ausente)
- [x] Unit: `pnpm jest src/modules/billing/` 100% verde
- [x] E2E: `pnpm test:e2e -- billing` 100% verde (5 specs)
- [x] Lint + build: `pnpm lint && pnpm build`
- [x] Smoke: boot com Redis up → `billing.schedules_registered`
- [x] Smoke: boot com Redis fora → `billing.schedules_registration_failed` + processo encerra
- [x] Grep: 0 ocorrências de `BILLING_.*??` em `billing.service.ts` e `billing.schedules.ts`

## Anti-acceptance verificado
- ❌ `??` envolvendo `BILLING_*` → grep confirma 0
- ❌ App sobe sem crons → smoke confirma crash visível
- ❌ Exception silenciada → spec cobre re-throw
- ❌ Mudança no `.env.example` → não tocado

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review (post-write checklist)

Verificado contra a spec antes de entregar:

**1. Cobertura R-F2-NN:**
- R-F2-01 (`?? 1` linha 109) → Task 4 ✅
- R-F2-02 (`?? 7` linha 416) → Task 3 ✅
- R-F2-03 (`?? 3` linha 48) → Task 5 ✅
- R-F2-04 (`?? '<cron>'` linhas 22-23) → Task 6 ✅
- R-F2-05 (try/catch + re-throw) → Task 8 ✅
- R-F2-06 (doc sobre Sentry automático) → comment dentro do try/catch da Task 8 ✅
- R-F2-07 (testes unit) → Tasks 3 + 7 + 8 ✅

**2. Acceptance criteria do spec §8:**
- "Nenhuma ocorrência de `??` envolvendo `BILLING_*`" → Task 9 Step 1 ✅
- "App boot com env válida sobe normalmente e loga `billing.schedules_registered`" → Task 9 Step 6 ✅
- "App boot com `BILLING_PAST_DUE_GRACE_DAYS` removida do `.env` falha visível com mensagem do Joi" → Task 9 Step 9 (opcional, ilustra D-05) ✅
- "App boot com Redis fora falha em `onApplicationBootstrap` com log `billing.schedules_registration_failed` + erro propagado" → Task 9 Step 7 ✅
- "`pnpm test`, `pnpm test:e2e`, `pnpm lint`, `pnpm build` verdes" → Task 9 Steps 2-5 ✅

**3. Anti-acceptance do spec §8:**
- ❌ `??` envolvendo config de billing → Task 9 Step 1 (grep) ✅
- ❌ App sobe sem crons → Task 8 (try/catch + re-throw) + Task 9 Step 7 (smoke) ✅
- ❌ Exception silenciada → Task 8 Step 1 (test exige re-throw) ✅
- ❌ Mudança no `.env.example` → não tocado em nenhuma task ✅

**4. Placeholder scan:** nenhum TBD/TODO/placeholder no plano.

**5. Type consistency:** `getOrThrow<T>` usado consistente; `BillingSchedules` constructor signature preservada; `Logger.error({...})` segue o padrão pino estruturado já usado em `billing.schedules_registered`.

**6. Fora de escopo respeitado (spec §8):**
- ❌ Não toca `ai-visagism.schedules.ts` (tem `??` similar, mas spec F2 é só billing)
- ❌ Não adiciona monitoramento de saúde de scheduler em runtime
- ❌ Não move defaults pra constante hardcoded
- ❌ Não toca F1/F3/F4
