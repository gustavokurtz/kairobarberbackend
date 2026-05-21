# Billing Hardening v2: trial farm + fallbacks defensivos + resiliência cron

**Data:** 2026-05-21
**Autor:** Gustavo Nascimento (em colaboração com Claude)
**Status:** Spec em revisão
**Escopo deste documento:** mudanças no backend (`kairobarber-api`) pra fechar 8 vulnerabilidades de receita identificadas em auditoria 2026-05-21 — 4 críticas (signup farm, fallbacks discrepantes, bootstrap silencioso) + 4 altas (rate-limit, timeout HTTP, coerência 404 storefront, race no checkout).

> ⚠️ **Leitura prévia obrigatória:** [`2026-05-20-trial-grace-tightening-design.md`](./2026-05-20-trial-grace-tightening-design.md) — esta spec **estende** a janela apertada definida lá, fechando vetores que escapavam do gating. Invariants INV-01 a INV-11 da spec anterior continuam valendo; aqui adicionamos INV-12 a INV-16.

---

## 1. Contexto e objetivo

### Por que existe

Em 2026-05-21 fizemos auditoria de receita do backend e encontramos 8 vulnerabilidades que permitem **perda direta de dinheiro** (custo SaaS pago sem retorno) ou **operação grátis** (tenant usando o sistema sem pagar). Resumo dos vetores:

**C1 — Trial farm escalável (CRÍTICO).** `POST /auth/register/owner` em [auth.controller.ts:19-30](../../../src/modules/auth/auth.controller.ts) **não tem `@Throttle`** (compare com `/login` linha 33 que tem, `/forgot-password` linha 68, `/customers/claim` linha 97). Combinado com `findByEmail` case-sensitive em [user.repository.ts:9-10](../../../src/modules/auth/repositories/user.repository.ts) (e schema `email String @unique` cru em [schema.prisma:54](../../../prisma/schema.prisma)), atacante cria N tenants via:
- Bot/botnet sem rate-limit
- Variações de case (`gustavo@gmail.com`, `Gustavo@gmail.com`, `GUSTAVO@gmail.com` — Gmail trata como mesma caixa; Postgres trata como contas distintas)
- Cada signup ganha trial 3 dias + cota mensal IA visagismo (custo Groq Llama 4 + opcional gpt-image-1 + upload R2)

**C2 — Discrepância `?? 1` vs `?? 7` em grace days (CRÍTICO).** [billing.service.ts:109](../../../src/modules/billing/billing.service.ts) (front via `getBillingStatus`) usa `?? 1`; [billing.service.ts:416](../../../src/modules/billing/billing.service.ts) (`runTrialCheck` que decide cancelar) usa `?? 7`. Mitigado por Joi `.default(1)`, mas qualquer mudança no schema ou env vazia faz o cron silenciosamente esperar 7 dias enquanto banner mostra "0". Tenant opera 6 dias extras.

**C3 — Discrepância fallback do cron sync (CRÍTICO).** [billing.schedules.ts:22](../../../src/modules/billing/billing.schedules.ts) tem fallback `'0 6,18 * * *'` (2×/dia); spec D-11 quer `'0 * * * *'` (1×/hora). Mitigado por Joi `.default('0 * * * *')`. Mesma classe de bug que C2: bomba-relógio que arma se Joi default for removido.

**C4 — Bootstrap dos crons sem try/catch (CRÍTICO).** [billing.schedules.ts:17-41](../../../src/modules/billing/billing.schedules.ts) — `upsertJobScheduler` pode throw se Redis indisponível no boot. Sem webhook do gateway (decisão arquitetural em CLAUDE.md §1), o cron é o **único sinal** de OVERDUE. Cron silenciosamente não registrado = trial infinito + past_due nunca detectado.

**A1 — `POST /admin/billing/sync` sem `@Throttle` (ALTO).** [billing.controller.ts:78-84](../../../src/modules/billing/billing.controller.ts). Tenant past_due pode pendurar 1000 req/s contra Asaas → risco de bloqueio da nossa conta Asaas inteira (rate-limit por API key) → nenhum tenant consegue assinar/renovar.

**A2 — Fetch ao Asaas sem timeout (ALTO).** [asaas.billing-provider.ts:225-234](../../../src/modules/billing/providers/asaas.billing-provider.ts) — `fetch()` sem `AbortSignal.timeout`. Asaas lento → workers NestJS pendurados → 503 em endpoints legítimos (checkout do barbeiro novo trava na hora crítica).

**A3 — AI visagismo retorna 402 (vaza estado de billing) (ALTO).** [ai-visagism.service.ts:255-260](../../../src/modules/ai-visagism/ai-visagism.service.ts) retorna `402 SUBSCRIPTION_INACTIVE` em past_due/cancelled. Storefront `/public/{slug}/*` retorna `404 TENANT_NOT_FOUND` (INV-07 da spec billing-tightening). Inconsistência: scraper varrendo slugs descobre quem está inadimplente.

**A4 — `createCheckout` sem lock em race condition (ALTO).** [billing.service.ts:229-329](../../../src/modules/billing/billing.service.ts). Throttle 3/60s **não previne 3 calls concorrentes** — serializa janelas separadas. Cliques paralelos criam preapprovals órfãs no Asaas → cobrança duplicada se cliente paga via link de email antigo.

### Objetivo

Fechar os 4 críticos (C1-C4) + 4 altos (A1-A4) sem mudanças no schema de billing (só `User` em C1) e sem refactor além do estritamente necessário. Cada fix é cirúrgico, alinhado com a arquitetura existente.

### Por que agora

- Plataforma em produção (Railway, branch `main` → CI verde → deploy auto) — qualquer dos vetores ativos vaza dinheiro a partir de hoje.
- A spec [`2026-05-20-trial-grace-tightening-design.md`](./2026-05-20-trial-grace-tightening-design.md) já apertou a janela de grace pra 1 dia — agora a aquisição precisa fechar (signup) e a infraestrutura precisa parar de falhar silenciosamente (C4, A2).

---

## 2. Invariants (regras globais, não-negociáveis)

Esta spec **adiciona** INV-12 a INV-16. INV-01 a INV-11 da spec [`2026-05-20-trial-grace-tightening-design.md`](./2026-05-20-trial-grace-tightening-design.md) continuam valendo.

| ID | Invariant |
|---|---|
| INV-12 | Toda **escrita** de `User.email` passa por `email.trim().toLowerCase()` no service layer (`registerOwner`, `inviteBarber`, qualquer flow que cria User). Não confiar em DTO/middleware client-side. |
| INV-13 | Todo **lookup** de `User.email` normaliza antes de comparar (`findByEmail`, `login`, `forgotPassword`). Constraint do DB é `UNIQUE INDEX user_email_lower ON "User"(LOWER(email))`, não `email @unique` cru. |
| INV-14 | Defaults de billing vêm **sempre** de Joi via `getOrThrow`. Fallbacks `??` em [`billing.service.ts`](../../../src/modules/billing/billing.service.ts) e [`billing.schedules.ts`](../../../src/modules/billing/billing.schedules.ts) são proibidos pra qualquer config de janela/cron — Joi schema é a source of truth. |
| INV-15 | Boot da aplicação **falha visível** se Redis/BullMQ não disponível. `BillingSchedules.onApplicationBootstrap` envolve `upsertJobScheduler` em try/catch que loga + Sentry + **re-throw**. Sistema NUNCA sobe sem crons registrados. |
| INV-16 | Toda rota pública **slug-scoped** (`/public/:slug/*`, incluindo `/public/:slug/ai/visagism/*`) em tenant `past_due`/`cancelled`/`suspendedAt` retorna `404 TENANT_NOT_FOUND`. Sem 402 vazando estado de billing. Endpoints token-scoped pós-criação (`/public/ai/visagism/consultations/:id*` e `/public/appointments/:id*`) ficam acessíveis ao cliente final mesmo em past_due — a entrega já foi feita ou paga, cliente final não pode ser punido pela inadimplência do tenant. |

---

## 3. Glossário travado

| Termo | Definição precisa neste spec |
|---|---|
| **Trial farm** | Ataque onde um agente cria N tenants gratuitamente pra consumir cota IA / armazenamento / janela de trial. Mitigado por throttle + dedup por email normalizado. |
| **Email normalizado** | `email.trim().toLowerCase()`. Sem strip de aliases (`+foo`) nem dots gmail-specific. Aplicado em writes e lookups. |
| **Falha-rápido (migration)** | Migration adiciona `UNIQUE INDEX LOWER(email)` direto. Se houver duplicates no DB existente, falha atômica no deploy — não aplica mitigação defensiva, assume banco limpo. |
| **Re-throw no bootstrap** | `try { ... } catch(err) { logger.error + sentry.captureException + throw }`. Propaga pro NestJS que aborta boot. Railway re-tenta deploy automaticamente. |
| **Race de checkout** | Múltiplos `POST /admin/billing/checkout` concorrentes no mesmo tenant. Cada um cancela o `mpPreapprovalId` anterior + cria novo no Asaas. Sem serialização, preapprovals órfãs ficam vivas no gateway. |
| **404 puro** | Resposta `{ status: 404, code: 'TENANT_NOT_FOUND', message: 'Barbearia não encontrada.' }`. Idêntica à de slug inexistente. Spec INV-07 + INV-16 + D-04 anterior. |

---

## 4. Decision log

| Decisão | Alternativas rejeitadas | Por quê |
|---|---|---|
| D-01: `@Throttle({limit:3, ttl:60_000})` em `POST /auth/register/owner` | 5/60s (igual login); 10/60s (mais permissivo); sem throttle (status quo) | Mesma magnitude do `/checkout` (3/60s) — ambos têm side-effect financeiro (cria trial+cota IA / cria preapproval). 5/60s seria permissivo demais pra criar 5 tenants/min por IP. |
| D-02: Normalize email só `trim().toLowerCase()` | Strip Gmail aliases (`+foo`); strip dots gmail-specific; sem normalize | Universal pra qualquer provider. Strip de aliases bloqueia user legítimo que rotula com `+saas`; strip de dots é gmail-only e adiciona código condicional. Combinação throttle + lowercase derruba o vetor escalado de case-variation. Custo de farmar com `+1`, `+2`, ... é dominado pelo custo de aquisição (CPF real, validação manual via emails de cadastro, etc). |
| D-03: CPF/CNPJ continua **opcional** no signup | Exigir obrigatório no `RegisterOwnerDto` + `@unique` em Tenant.documentNumber | Decisão explícita do owner: manter zero fricção de onboarding. Documento já é obrigatório no checkout (linha 256-262 de [billing.service.ts](../../../src/modules/billing/billing.service.ts)) — gating financeiro continua intacto. Throttle + email único é suficiente. |
| D-04: Migration falha-rápido sem cleanup defensivo | `UPDATE` normalizador antes do index; cleanup retroativo de duplicates | Banco assumido limpo (pré-go-live, base pequena). Se falhar no deploy, detectamos imediato e fazemos cleanup manual. Cleanup defensivo (`UPDATE SET email = LOWER(TRIM(email))` com tratamento de conflito) é over-engineering pro cenário real. |
| D-05: Bootstrap fail = re-throw, app crasha | Logar + continuar (app sobe sem cron); retry interno 3x antes de crashar | Crash visível >> trial infinito silencioso. Railway re-tenta deploy quando Redis volta. Retry interno mascara bug de configuração (REDIS_URL errado leva 30s pra falhar visivelmente). |
| D-06: Throttle `5/60s` em `POST /admin/billing/sync` | 3/60s (igual checkout); 10/60s; sem throttle | Sync legítimo é polling pós-pagamento (user clica "atualizei, sincroniza"). 5/min é generoso pra tentar algumas vezes; ainda fecha abuso. 3/60s pode ser apertado se Asaas demora mais de 20s pra confirmar e usuário re-clica. |
| D-07: Timeout HTTP 10s no fetch Asaas | 5s; 30s; sem timeout | Asaas tem latência normal 1-3s; 10s cobre lento mas não pendura worker indefinidamente. Combinado com retry backoff existente (`SYNC_RETRY_BACKOFF_MS` em [billing.constants.ts](../../../src/modules/billing/billing.constants.ts)). |
| D-08: AI visagismo retorna **404 TENANT_NOT_FOUND** em past_due/cancelled | Manter 402; passar pelo middleware `PublicTenantMiddleware`; novo error code | 404 alinha INV-07 da spec billing-tightening: storefront em past_due = 404 puro. Não vaza estado de billing pra scraper. Service-level (linha 255 do ai-visagism.service.ts) é onde o gating mora — manter ali, só trocar status code + error code. |
| D-09: A4 via `prisma.$transaction` + re-leitura | `SELECT ... FOR UPDATE` pessimista; advisory lock Postgres; idempotency key | Transaction com re-leitura da Subscription dentro do escopo serializa checkouts concorrentes sem custo de FOR UPDATE (não temos histórico de contention real). Idempotency key adicionaria coluna nova; fora de escopo. |
| D-10: 4 PRs separadas, uma por fase | PR única monolítica; 8 PRs (uma por fix) | 4 fases agrupam por área (auth, billing-defaults, billing-runtime, storefront-coerencia). PR única tem reverter ruim; 8 PRs gera ruído de review. |

---

## 5. Escopo

### Está no escopo desta spec

**Fase F1 — Signup hardening (C1):**
- Throttle em `POST /auth/register/owner` (3/60s/IP)
- Normalização `trim().toLowerCase()` em todos os writes/reads de `User.email`
- Migration que **assume banco limpo**: adiciona `UNIQUE INDEX user_email_lower ON "User"(LOWER(email))` direto
- Migration prévia: `UPDATE "User" SET email = LOWER(TRIM(email))` pra garantir consistência antes do index (idempotente, sem perda)
- Remove `@unique` cru de `email` no `User` model (substituído pelo index funcional)

**Fase F2 — Defaults defensivos (C2 + C3 + C4):**
- Trocar `?? 7` por `getOrThrow<number>('BILLING_PAST_DUE_GRACE_DAYS')` em billing.service.ts:416
- Trocar `?? 1` por `getOrThrow<number>('BILLING_PAST_DUE_GRACE_DAYS')` em billing.service.ts:109 (mesmo padrão, mesma fonte)
- Trocar fallback `'0 6,18 * * *'` por `getOrThrow<string>('BILLING_SYNC_CRON')` em billing.schedules.ts:22
- Trocar fallback `'15 6 * * *'` por `getOrThrow<string>('BILLING_TRIAL_CHECK_CRON')` em billing.schedules.ts:23 (mesma classe, fix preventivo)
- Try/catch + re-throw em `onApplicationBootstrap` envolvendo os 2 `upsertJobScheduler` — loga estruturado + Sentry capture + propaga

**Fase F3 — Hardening crons/HTTP (A1 + A2):**
- `@Throttle({limit:5, ttl:60_000})` em `POST /admin/billing/sync` (controller, decorator)
- `signal: AbortSignal.timeout(10_000)` no `fetch()` do `AsaasBillingProvider.request()` em asaas.billing-provider.ts:225-234
- Caso a chamada aborte, mapeia pra `DomainException` com `ErrorCodes.BILLING_PROVIDER_ERROR` + status 504

**Fase F4 — Coerência storefront + checkout race (A3 + A4):**
- `AiVisagismService.assertSubscriptionAllowed` (linha 253-260) muda de `HttpStatus.PAYMENT_REQUIRED + SUBSCRIPTION_INACTIVE` pra `HttpStatus.NOT_FOUND + TENANT_NOT_FOUND`
- Atualizar testes em [ai-visagism.service.spec.ts](../../../src/modules/ai-visagism/ai-visagism.service.spec.ts) pra refletir nova resposta
- `BillingService.createCheckout` envolvido em `prisma.$transaction`:
  - Dentro da transação: re-lê Subscription via `tx.subscription.findUnique({ where: { tenantId } })`
  - Se `mpPreapprovalId` da re-leitura != da leitura inicial, aborta com `DomainException` `CHECKOUT_RACE_DETECTED` (HTTP 409) — request perde, próximo checkout do user funciona normal
  - Update final do `mpPreapprovalId` é dentro da mesma transação

### Fora de escopo

- CAPTCHA / proof-of-work no signup
- Exigir CPF/CNPJ no signup (segue opcional, exigido só no checkout)
- Email verification obrigatório antes do trial (segue best-effort em `registerOwner`)
- Cleanup retroativo de duplicates de email no DB existente (assume banco limpo)
- Rate-limit por device fingerprint (IP-based é suficiente)
- Substituir `mpPreapprovalId` por nome neutro (legado de quando MP era primário; ignorar)
- Idempotency key no checkout (over-engineering pra contention real)
- Lock pessimista `FOR UPDATE` em outros lugares (só checkout, e via transaction)
- Webhook do Asaas (decisão arquitetural mantida)
- Mudanças no front (esta spec é só backend)

---

## 6. Anti-goals globais

- **Não introduzir fricção pro usuário legítimo.** Throttle 3/60s/IP no signup tolera demos e re-cadastros honestos; lowercase de email é transparente.
- **Não criar dual code path.** Email normalize aplica em TODAS as escritas/leituras. Sem `if/else` por origem.
- **Não mascarar falhas de boot.** Crash visível no startup >> trial infinito silencioso (D-05).
- **Não adicionar coluna nova no schema** (exceto o que C1 já faz — substituir constraint cru por index funcional `LOWER`).
- **Não tocar fluxo de reativação** (`past_due → checkout → sync → active` continua funcionando — só blindado).
- **Não quebrar a spec billing-tightening anterior.** INV-01 a INV-11 + D-01 a D-12 continuam intactos.

---

## 7. Fase F1 — Signup hardening

### Pré-requisito
- Estar com `kairobarber-api/` em `main`, CI verde, sem migrations pendentes.
- Ler INV-12, INV-13 + decisões D-01 a D-04 antes de codar.
- **Verificação pré-implementação:** rodar `SELECT LOWER(TRIM(email)) AS e, COUNT(*) FROM "User" GROUP BY e HAVING COUNT(*) > 1` em prod (Railway shell ou Prisma Studio). Se retornar zero linhas, prosseguir. Se retornar duplicates, **PARAR** e abrir decisão de cleanup manual antes de aplicar a migration.

### Re-leitura obrigatória (Recall Task)
Antes de codar, re-ler este spec inteiro + spec [`2026-05-20-trial-grace-tightening-design.md`](./2026-05-20-trial-grace-tightening-design.md). Echo-back:
1. O email é normalizado em qual camada — DTO, service, ou DB?
2. A constraint final do DB é `@unique email` ou `UNIQUE INDEX LOWER(email)`?
3. Qual o limit/ttl do throttle no signup, e por que esse número?
4. Aliases Gmail (`+foo`) e dots são strip ou preservados?
5. Se a migration encontrar duplicates, o que acontece?

### Goal (1 frase)
Após esta fase, signup tem rate-limit `3/60s/IP`, email é normalizado pra `LOWER(TRIM(...))` em todas as escritas/leituras, e DB rejeita duplicates case-insensitive via index funcional.

### Em escopo

- **R-F1-01:** Adicionar `@Throttle({ default: { limit: 3, ttl: 60_000 } })` em [auth.controller.ts:20](../../../src/modules/auth/auth.controller.ts) acima de `@Post('register/owner')`.
- **R-F1-02:** Em [auth.service.ts](../../../src/modules/auth/auth.service.ts) `registerOwner`, antes de qualquer uso, normalizar: `const email = dto.email.trim().toLowerCase()`. Usar `email` em vez de `dto.email` em todas as referências subsequentes (linha 61, 82).
- **R-F1-03:** Em [user.repository.ts:9-11](../../../src/modules/auth/repositories/user.repository.ts) `findByEmail`, normalizar antes da query: `return this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } })`.
- **R-F1-04:** Em [auth.service.ts](../../../src/modules/auth/auth.service.ts) `login` (linha 120-141), normalizar `email` antes de chamar `findByEmail` (defesa redundante — `findByEmail` já normaliza, mas explícito em service também).
- **R-F1-05:** Em [auth.service.ts](../../../src/modules/auth/auth.service.ts) `forgotPassword` (linha 205) e qualquer outro lookup, mesma normalização explícita.
- **R-F1-06:** Auditar `tx.user.create({ data: { email: ... } })` em [auth.service.ts:82](../../../src/modules/auth/auth.service.ts) (`registerOwner`) e em qualquer outro flow que cria User (busca por `prisma.user.create` no codebase) — garantir que `email` salvo é o normalizado.
- **R-F1-07:** Migration Prisma `prisma/migrations/YYYYMMDDHHMMSS_user_email_case_insensitive/migration.sql`:
  ```sql
  -- Step 1: normalize existing rows (idempotente)
  UPDATE "User" SET email = LOWER(TRIM(email)) WHERE email <> LOWER(TRIM(email));
  -- Step 2: drop old unique constraint
  ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_email_key";
  -- Step 3: create functional unique index (falha-rápido se duplicates)
  CREATE UNIQUE INDEX "user_email_lower_unique" ON "User"((LOWER(email)));
  ```
- **R-F1-08:** Schema Prisma: trocar `email String @unique` por `email String` + `@@index([email], map: "user_email_lower_unique")` (Prisma não suporta index funcional nativo até v6; manter o index criado pela migration manual e documentar em comment no schema).
- **R-F1-09:** Testes:
  - Unit em `auth.service.spec.ts`: signup com email `'Gustavo@Gmail.com'` salva como `'gustavo@gmail.com'`. Segundo signup com `'GUSTAVO@gmail.com'` retorna `EMAIL_ALREADY_REGISTERED` (não cria).
  - Unit em `user.repository.spec.ts`: `findByEmail('Gustavo@Gmail.com')` retorna user criado com `'gustavo@gmail.com'`.
  - E2E em `auth.e2e-spec.ts` (ou similar): 4 requests em sequência em `POST /auth/register/owner` retornam 201, 201, 201, **429** (throttle).
  - E2E: `POST /auth/register/owner` com email `'Test@X.com'` e segundo signup com `'test@x.com'` → segundo retorna 409 `EMAIL_ALREADY_REGISTERED`.

### Fora do escopo desta fase
- Mudanças em outros endpoints `/auth/*` (já têm `@Throttle`)
- CAPTCHA
- Verificação CPF/CNPJ no signup
- Cleanup retroativo de duplicates (assume banco limpo)
- F2/F3/F4 (próximas fases)

### Endpoints (tabela exata)

| Método | Path | Mudança |
|---|---|---|
| POST | `/auth/register/owner` | **Adicionar `@Throttle({limit:3, ttl:60_000})`**. Body inalterado. Normaliza `email` no service antes de qualquer uso. |
| POST | `/auth/login` | Inalterado externamente. Normaliza `email` no service (defesa redundante). |
| POST | `/auth/forgot-password` | Inalterado externamente. Normaliza `email` no service. |
| Internal | `UserRepository.findByEmail(email)` | Aplica `.trim().toLowerCase()` antes da query. |

### Acceptance (checkboxes verificáveis)
- [ ] `POST /auth/register/owner` tem `@Throttle({ default: { limit: 3, ttl: 60_000 } })`.
- [ ] 4ª chamada de `POST /auth/register/owner` no mesmo IP em 60s retorna HTTP 429.
- [ ] Signup com `email: 'Test@X.com'` cria User com `email = 'test@x.com'` no DB.
- [ ] Segundo signup com `email: 'TEST@x.com'` retorna 409 `EMAIL_ALREADY_REGISTERED`.
- [ ] `findByEmail('Test@X.com')` retorna o user criado.
- [ ] Migration roda em ambiente de dev sem erro (com banco limpo) e cria `user_email_lower_unique`.
- [ ] Tentativa de inserir 2 users com emails que diferem só em case falha por constraint do DB (testado via Prisma Studio ou SQL direto).
- [ ] `pnpm test`, `pnpm test:e2e`, `pnpm lint`, `pnpm build` verdes.

### Anti-acceptance (não pode acontecer)
- ❌ Signup retorna 201 em chamada paralela com email case-variant do existente.
- ❌ `User.email` no DB tem qualquer letra maiúscula após esta fase.
- ❌ Migration cria o index sem o `UPDATE` prévio normalizando.
- ❌ Algum lookup de email em service usa `dto.email` cru.
- ❌ Throttle bloqueia 1 ou 2 signups legítimos consecutivos (limit é 3 inclusive).
- ❌ Email aliases (`gustavo+1@gmail.com`) são strip (preservados — escolha consciente D-02).

---

## 8. Fase F2 — Defaults defensivos (C2 + C3 + C4)

### Pré-requisito
- F1 mergeada e em prod (ou em paralelo se não houver conflito; ambos tocam arquivos diferentes).
- Ler INV-14, INV-15 + D-05.

### Re-leitura obrigatória (Recall Task)
1. Por que `??` é proibido em billing.service.ts e billing.schedules.ts?
2. Quem é a source of truth dos defaults de billing após esta fase?
3. O que acontece se Redis estiver fora no boot?
4. O Sentry capture é antes ou depois do re-throw?
5. Quais 4 variáveis de env são afetadas?

### Goal (1 frase)
Após esta fase, defaults de billing vêm exclusivamente do Joi schema; código não tem fallback `??`; e o boot da aplicação falha visível se Redis/BullMQ estiver indisponível.

### Em escopo

- **R-F2-01:** Em [billing.service.ts:109](../../../src/modules/billing/billing.service.ts), trocar `this.config.get<number>('BILLING_PAST_DUE_GRACE_DAYS') ?? 1` por `this.config.getOrThrow<number>('BILLING_PAST_DUE_GRACE_DAYS')`.
- **R-F2-02:** Em [billing.service.ts:416](../../../src/modules/billing/billing.service.ts), trocar `this.config.get<number>('BILLING_PAST_DUE_GRACE_DAYS') ?? 7` por `this.config.getOrThrow<number>('BILLING_PAST_DUE_GRACE_DAYS')`. **Esta é a correção principal** (era `?? 7` regredindo silenciosamente).
- **R-F2-03:** Em [billing.service.ts:48](../../../src/modules/billing/billing.service.ts), trocar `this.config.get<number>('BILLING_TRIAL_DAYS') ?? 3` por `this.config.getOrThrow<number>('BILLING_TRIAL_DAYS')`.
- **R-F2-04:** Em [billing.schedules.ts:22-23](../../../src/modules/billing/billing.schedules.ts), trocar:
  ```ts
  const syncCron = this.config.get<string>('BILLING_SYNC_CRON') ?? '0 6,18 * * *';
  const trialCron = this.config.get<string>('BILLING_TRIAL_CHECK_CRON') ?? '15 6 * * *';
  ```
  por:
  ```ts
  const syncCron = this.config.getOrThrow<string>('BILLING_SYNC_CRON');
  const trialCron = this.config.getOrThrow<string>('BILLING_TRIAL_CHECK_CRON');
  ```
- **R-F2-05:** Em [billing.schedules.ts:17-41](../../../src/modules/billing/billing.schedules.ts) `onApplicationBootstrap`, envolver os 2 `upsertJobScheduler` em try/catch:
  ```ts
  try {
    await this.queue.upsertJobScheduler(BILLING_SYNC_JOB_KEY, { pattern: syncCron, tz: 'UTC' }, { name: JOB_BILLING_SYNC, data: {} });
    await this.queue.upsertJobScheduler(TRIAL_CHECK_JOB_KEY, { pattern: trialCron, tz: 'UTC' }, { name: JOB_TRIAL_CHECK, data: {} });
  } catch (err) {
    this.logger.error({
      event: 'billing.schedules_registration_failed',
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    throw new Error(`Failed to register billing schedulers: ${(err as Error).message}`);
  }
  ```
- **R-F2-06:** Confirmar que `SentryModule` (ou equivalente) está no app — exceptions não-capturadas em `onApplicationBootstrap` propagam automaticamente pro Sentry via integração NestJS (não precisa `captureException` manual). Documentar no comment do try/catch.
- **R-F2-07:** Testes:
  - Unit em `billing.service.spec.ts`: simular `config.getOrThrow` jogando `Error` → `runTrialCheck` propaga (não silencia).
  - Unit em `billing.schedules.spec.ts` (criar se não existir): simular `queue.upsertJobScheduler` rejeitando → `onApplicationBootstrap` re-throws com mensagem específica.

### Fora do escopo desta fase
- Monitoramento de saúde do scheduler em runtime (separado, próxima spec se observar incidência)
- Mover defaults pra outra fonte que não Joi (e.g., constantes hardcoded)
- F1/F3/F4

### Endpoints (tabela exata)

Nenhum endpoint adicionado/modificado nesta fase. Mudanças são internas (config + boot lifecycle).

### Acceptance
- [ ] Nenhuma ocorrência de `??` envolvendo `BILLING_*` em [billing.service.ts](../../../src/modules/billing/billing.service.ts) ou [billing.schedules.ts](../../../src/modules/billing/billing.schedules.ts) — verificável via `grep`.
- [ ] App boot com env válida sobe normalmente e loga `billing.schedules_registered`.
- [ ] App boot com `BILLING_PAST_DUE_GRACE_DAYS` removida do `.env` falha visível com mensagem do Joi (pré-bootstrap).
- [ ] App boot com Redis fora falha em `onApplicationBootstrap` com log `billing.schedules_registration_failed` + erro propagado (Railway re-tenta deploy).
- [ ] `pnpm test`, `pnpm test:e2e`, `pnpm lint`, `pnpm build` verdes.

### Anti-acceptance
- ❌ Algum `?? <number>` ou `?? '<string>'` envolvendo config de billing.
- ❌ App sobe sem crons registrados (com log de sucesso de boot).
- ❌ Exception silenciada no catch (sem re-throw).
- ❌ Mudança em valores no `.env.example` (defaults já estão corretos lá).

---

## 9. Fase F3 — Hardening crons/HTTP (A1 + A2)

### Pré-requisito
- F1 e F2 podem estar paralelas. F3 idealmente após F2 (pra evitar conflito de PR em billing.controller.ts).
- Ler D-06, D-07.

### Re-leitura obrigatória (Recall Task)
1. Qual o limit/ttl do throttle no `/sync`, e por que mais permissivo que checkout?
2. Quantos segundos é o timeout do fetch Asaas?
3. O que acontece se o timeout estourar — qual status HTTP é retornado?
4. O retry backoff existente (`SYNC_RETRY_BACKOFF_MS`) é afetado?

### Goal (1 frase)
Após esta fase, `POST /admin/billing/sync` tem rate-limit `5/60s` e toda chamada HTTP ao Asaas aborta em 10s, mapeando pra `BILLING_PROVIDER_ERROR` HTTP 504.

### Em escopo

- **R-F3-01:** Em [billing.controller.ts:78](../../../src/modules/billing/billing.controller.ts), adicionar `@Throttle({ default: { limit: 5, ttl: 60_000 } })` acima de `@Post('sync')`.
- **R-F3-02:** Em [asaas.billing-provider.ts:225-234](../../../src/modules/billing/providers/asaas.billing-provider.ts) `request()`, adicionar `signal: AbortSignal.timeout(10_000)` no objeto de opções do `fetch()`.
- **R-F3-03:** Em [asaas.billing-provider.ts](../../../src/modules/billing/providers/asaas.billing-provider.ts) `request()`, capturar `AbortError` (ou `error.name === 'TimeoutError'`) e converter pra `DomainException`:
  ```ts
  } catch (err) {
    if ((err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError') {
      throw new DomainException({
        code: ErrorCodes.BILLING_PROVIDER_ERROR,
        message: 'Timeout na comunicação com Asaas.',
        status: HttpStatus.GATEWAY_TIMEOUT, // 504
        details: { method, path },
      });
    }
    throw err;
  }
  ```
- **R-F3-04:** Testes:
  - E2E em `billing.controller.e2e-spec.ts` (ou unit): 6 calls sequenciais em `POST /admin/billing/sync` retornam 200, 200, 200, 200, 200, **429**.
  - Unit em `asaas.billing-provider.spec.ts`: mockar `fetch` retornando promise que demora 11s → `request()` lança `DomainException` com status 504.

### Fora do escopo desta fase
- Retry exponencial dentro do `request()` (já existe `SYNC_RETRY_BACKOFF_MS` no cycle; não duplicar)
- Circuit breaker pra Asaas
- Mudança no timeout do `node-fetch` global (usar AbortSignal localmente é suficiente)

### Endpoints (tabela exata)

| Método | Path | Mudança |
|---|---|---|
| POST | `/admin/billing/sync` | **Adicionar `@Throttle({limit:5, ttl:60_000})`**. Body inalterado. Resposta inalterada. |
| (interno) | `AsaasBillingProvider.request()` | Adiciona `AbortSignal.timeout(10_000)`. Lança 504 em timeout em vez de pendurar. |

### Acceptance
- [ ] `POST /admin/billing/sync` tem `@Throttle({ default: { limit: 5, ttl: 60_000 } })`.
- [ ] 6ª chamada em 60s no mesmo IP retorna 429.
- [ ] Mock de Asaas com latência > 10s faz `runBillingSync` (cron) registrar failure + agendar retry; não pendura worker.
- [ ] Chamada manual `POST /admin/billing/sync` com Asaas indisponível retorna 504 `BILLING_PROVIDER_ERROR` em < 11s.
- [ ] `pnpm test`, `pnpm test:e2e`, `pnpm lint`, `pnpm build` verdes.

### Anti-acceptance
- ❌ `fetch` ao Asaas sem `signal: AbortSignal.timeout(...)`.
- ❌ Timeout retorna 500 (deve ser 504).
- ❌ Throttle do `/sync` mais restritivo que 5/60s (3/60s seria apertado).
- ❌ Mudança no `runBillingSync` retry logic (escopo do timeout é só interromper, não retry).

---

## 10. Fase F4 — Coerência storefront + checkout race (A3 + A4)

### Pré-requisito
- F1, F2, F3 ideal mas não bloqueante. F4 toca arquivos isolados (ai-visagism.service.ts + billing.service.ts createCheckout).
- Ler INV-16 + D-08, D-09.

### Re-leitura obrigatória (Recall Task)
1. AI visagismo em past_due retorna qual status HTTP e qual error code?
2. A mudança em A3 toca o middleware ou o service?
3. A4 usa `FOR UPDATE` ou re-leitura dentro de transaction?
4. Se A4 detectar race, qual error code é retornado?
5. A spec INV-16 afeta endpoints fora do AI visagismo?

### Goal (1 frase)
Após esta fase, AI visagismo retorna 404 `TENANT_NOT_FOUND` em past_due/cancelled (alinha INV-16), e checkouts concorrentes são serializados via transaction com detecção de race, evitando preapprovals órfãs no Asaas.

### Em escopo

- **R-F4-01:** Em [ai-visagism.service.ts:253-260](../../../src/modules/ai-visagism/ai-visagism.service.ts) `assertSubscriptionAllowed`, trocar:
  ```ts
  throw new DomainException({
    code: ErrorCodes.SUBSCRIPTION_INACTIVE,
    message: 'A barbearia não está com assinatura ativa.',
    status: HttpStatus.PAYMENT_REQUIRED,
  });
  ```
  por:
  ```ts
  throw new DomainException({
    code: ErrorCodes.TENANT_NOT_FOUND,
    message: 'Barbearia não encontrada.',
    status: HttpStatus.NOT_FOUND,
  });
  ```
- **R-F4-02:** Atualizar [ai-visagism.service.spec.ts](../../../src/modules/ai-visagism/ai-visagism.service.spec.ts): testes que esperam 402 esperam agora 404 + `TENANT_NOT_FOUND`.
- **R-F4-03:** Em [billing.service.ts:229-329](../../../src/modules/billing/billing.service.ts) `createCheckout`, envolver toda a lógica (após validações iniciais) em `prisma.$transaction`:
  ```ts
  return this.prisma.$transaction(async (tx) => {
    const subFresh = await tx.subscription.findUnique({ where: { tenantId: input.tenantId } });
    if (!subFresh) throw new DomainException({ ... SUBSCRIPTION_NOT_FOUND });
    if (subFresh.mpPreapprovalId !== sub.mpPreapprovalId) {
      // Outro checkout concorrente foi mais rápido — abortar.
      throw new DomainException({
        code: ErrorCodes.CHECKOUT_RACE_DETECTED,
        message: 'Outro checkout em andamento. Tente novamente em alguns segundos.',
        status: HttpStatus.CONFLICT,
      });
    }
    // cancelPreapproval do antigo (idempotente; pode ficar fora da tx)
    // createPreapproval no Asaas (chamada externa fora da tx — não bloquear DB)
    // depois: tx.subscription.update({ ... mpPreapprovalId: created.preapprovalId })
  });
  ```
  **Nota arquitetural:** chamadas HTTP ao Asaas (cancel + create) NÃO podem ficar dentro do `$transaction` (mantém DB lock por segundos). Estrutura final: re-lê dentro da tx (validação) → fecha tx → faz chamadas Asaas → re-abre tx pra fazer o update final com re-checagem. Detalhe de implementação fica no plano.
- **R-F4-04:** Adicionar `CHECKOUT_RACE_DETECTED` em [error-codes.ts](../../../src/common/exceptions/error-codes.ts).
- **R-F4-05:** Testes:
  - Unit em `ai-visagism.service.spec.ts`: tenant em past_due → `assertSubscriptionAllowed` lança 404 + `TENANT_NOT_FOUND`. (Antes era 402.)
  - Unit em `billing.service.spec.ts`: simular 2 chamadas concorrentes de `createCheckout` — uma vence com 200, outra retorna 409 `CHECKOUT_RACE_DETECTED`. Usar `Promise.all` + mock de Asaas com latência artificial.
  - Verificar via mock que apenas **1** `createPreapproval` chega no Asaas em cenário concorrente (a perdedora aborta antes da chamada externa).

### Fora do escopo desta fase
- Idempotency key persistente no DB (over-engineering)
- Lock pessimista `FOR UPDATE` (re-leitura dentro de tx é suficiente — D-09)
- Cleanup retroativo de preapprovals órfãs já existentes no Asaas (script separado se observarmos)
- Mudança no front pra tratar 409 `CHECKOUT_RACE_DETECTED` (front pode retentar manualmente; UX adequado é separado)
- Mover o gating de AI visagismo pro middleware `PublicTenantMiddleware` (alternativa em D-08, rejeitada por scope)

### Endpoints (tabela exata)

| Método | Path | Mudança |
|---|---|---|
| POST | `/public/:slug/ai/visagism/consultations` | Em past_due/cancelled retorna **404 TENANT_NOT_FOUND** (antes 402 SUBSCRIPTION_INACTIVE). Body 201 inalterado em trialing/active. **Único endpoint AI visagism slug-scoped — único afetado por INV-16.** |
| GET | `/public/ai/visagism/consultations/:id` | **Inalterado.** Token-scoped pós-criação; cliente final segue acessando seu resultado mesmo se tenant ficou past_due depois. |
| POST | `/public/ai/visagism/consultations/:id/generate-image` | **Inalterado.** Mesma razão acima. Atenção em revisão de plano: se este endpoint hoje chama `assertSubscriptionAllowed`, R-F4-01 também afeta este (verificar no plano). |
| GET | `/public/ai/visagism/consultations/:id/image` | **Inalterado.** Idem. |
| POST | `/admin/billing/checkout` | Adiciona possibilidade de retorno **409 CHECKOUT_RACE_DETECTED** quando 2+ requests concorrentes. 200 normal em caso single-flight. |

### Acceptance
- [ ] Tenant em past_due chamando `POST /public/:slug/ai/visagism/consultations` recebe 404 + `code: 'TENANT_NOT_FOUND'`.
- [ ] Tenant em cancelled idem (mesmo comportamento).
- [ ] Tenant em trialing/active mantém 201 `CREATED` (sem regressão).
- [ ] Polling endpoint `GET /public/ai/visagism/consultations/:id?token=...` em tenant past_due **continua retornando 200** com a consulta existente (cliente final não é punido).
- [ ] 2 chamadas paralelas em `POST /admin/billing/checkout` no mesmo tenant — uma retorna 200, outra retorna 409 `CHECKOUT_RACE_DETECTED`.
- [ ] Em cenário concorrente, apenas 1 `createPreapproval` é chamado no Asaas (verificável via mock counter).
- [ ] Fluxo serial (1 checkout completo → outro checkout) continua funcionando normal (overwrite do mpPreapprovalId).
- [ ] `pnpm test`, `pnpm test:e2e`, `pnpm lint`, `pnpm build` verdes.

### Anti-acceptance
- ❌ AI visagism retorna 402 ou 403 em past_due/cancelled.
- ❌ Front recebe `SUBSCRIPTION_INACTIVE` em endpoint público (vaza estado).
- ❌ Chamada externa ao Asaas (cancel/create) acontece dentro de `prisma.$transaction` (segura DB).
- ❌ Race condition cria 2 preapprovals no Asaas.
- ❌ Fluxo serial de re-checkout (após past_due → renovar) quebra.

---

## 11. Riscos e mitigações

| Risco | Mitigação |
|---|---|
| Migration F1 falha em prod por duplicates existentes | Verificação pré-implementação (query SQL no banco) na seção Pré-requisito de F1. Falha-rápido com mensagem clara permite cleanup manual antes de re-deploy. |
| Throttle 3/60s bloqueia demo em evento ao vivo | Throttle é por IP — múltiplos demonstradores em IPs diferentes ficam isolados. Caso extremo: pausar Throttler temporariamente via env (fora de escopo, mas opção). |
| App não sobe se Redis indisponível (D-05) | Railway re-tenta deploy. Saas-owner alertado via Sentry. Aceito como trade-off contra trial infinito silencioso. |
| Timeout 10s no Asaas durante latência alta normal | Asaas latência mediana 1-3s; 10s cobre p99. Se causar regressão, ajustar pra 15s sem mudar a invariant. |
| F4 transaction adiciona latência ao checkout | Mínima — re-leitura é 1 SELECT extra. Chamadas Asaas (cancel/create) ficam **fora** da transação (D-09, R-F4-03). Total < 200ms a mais que hoje. |
| Race no checkout vira UX ruim (409 sem explicação) | Front trata 409 com mensagem "Tente em alguns segundos" + retry manual. Caso edge — usuário comum não dispara dois checkouts simultâneos. |
| Email lowercase quebra integração com email externo (Resend) | Resend aceita qualquer formato; servidor SMTP normaliza por RFC. Sem impacto. |

---

## 12. Observabilidade

Eventos já logados (não adicionar novos a menos que necessário):
- `subscription.trial_expired`, `subscription.past_due`, `subscription.cancelled` ([billing.service.ts](../../../src/modules/billing/billing.service.ts))
- `billing.sync_cycle`, `subscription.sync_failed`, `subscription.sync_skipped_stale_preapproval`
- `billing.schedules_registered` ([billing.schedules.ts](../../../src/modules/billing/billing.schedules.ts))

**Novos eventos desta spec:**
- `billing.schedules_registration_failed` (F2 R-F2-05) — emitido antes do re-throw, severity error
- `auth.register_owner_throttled` (F1, implícito via NestJS Throttler) — métrica derivável do Sentry/log do throttler
- `billing.checkout_race_detected` (F4 R-F4-03/04) — emitido antes do throw 409, severity warn

**Métricas derivadas pós-deploy (validar 30 dias):**
- Taxa de signups bloqueados por throttle (deve ser < 1% se valor 3/60s é correto)
- Eventos `billing.schedules_registration_failed` (deve ser 0 em estado saudável)
- Eventos `billing.checkout_race_detected` (esperado < 1/dia; se > 10/dia, racing realmente está acontecendo)

---

## 13. Plano de fases

| Fase | Conteúdo | Dependência | Risco | Tempo estimado |
|---|---|---|---|---|
| F1 | Signup hardening (C1) | Verificação prévia de duplicates | Médio (migration) | 4-6h |
| F2 | Defaults defensivos (C2 + C3 + C4) | F1 opcional | Baixo | 2-3h |
| F3 | Hardening crons/HTTP (A1 + A2) | F2 ideal | Baixo | 2-3h |
| F4 | Coerência storefront + checkout race (A3 + A4) | F3 opcional | Médio (transaction) | 4-6h |

Cada fase ganha plano executável via `superpowers:writing-plans` antes de codar.

---

## 14. Recall Task template (a usar como Task 0 de todo plano derivado)

```
Antes de qualquer ação:
1. Re-leia o spec inteiro em
   kairobarber-api/docs/superpowers/specs/2026-05-21-billing-hardening-v2-design.md
2. Re-leia também a spec billing-tightening anterior:
   kairobarber-api/docs/superpowers/specs/2026-05-20-trial-grace-tightening-design.md
3. Responda em echo-back de 5 bullets:
   - Quais invariants (INV-01 a INV-16) são relevantes pra esta fase?
   - Que decisões (D-01 a D-10 desta spec + D-01 a D-12 da anterior) eu posso ferir sem perceber?
   - Quais requirements R-F{N}-NN são meu escopo nesta fase?
   - Qual é o anti-acceptance que me protegerá de scope creep?
   - Qual recall-check de teste prova que eu não quebrei reativação?
4. Só depois de responder, comece a Task 1.
```

---

## 15. Histórico

| Data | Mudança |
|---|---|
| 2026-05-21 | Versão inicial. Brainstorm completo, decisões D-01 a D-10 travadas. Spec deriva de auditoria de receita de 2026-05-21 (8 vetores: 4 críticos + 4 altos). |
