# Apertando trial e ciclo mensal: Past_due ativo e janela curta (1 dia)

**Data:** 2026-05-20
**Autor:** Gustavo Nascimento (em colaboração com Claude)
**Status:** Spec em revisão
**Escopo deste documento:** mudança no fluxo de billing pra acelerar conversão e cortar acesso de inadimplentes — backend (kairobarber-api) + front (kairobarber-web), focado no que existe hoje em produção.

> ⚠️ **Aplicabilidade dupla — leia antes de tudo.** Este spec governa **dois cenários distintos** que compartilham a mesma regra de gating:
> 1. **Trial expirado** — barbeiro novo, signup → 3 dias trial → não assinou → `past_due` → 1 dia → `cancelled`.
> 2. **Ciclo mensal vencido** — barbeiro existente que já pagou meses, cobrança mensal do Asaas/MP falhou (cartão sem saldo, boleto não pago, PIX expirado) → `past_due` → 1 dia → `cancelled`.
>
> **NÃO é apenas sobre trial.** A regra de 1 dia + cron 1x/hora + bloqueio de escrita + storefront 404 vale igualmente nos dois casos. A única diferença é a **copy do banner no front** (derivada de `currentPeriodEnd IS NOT NULL`). Backend trata os dois fluxos como o mesmo evento: `status → past_due`.

---

## 1. Contexto e objetivo

### Por que existe

Hoje o KairoBarber tem **dois problemas correlatos** no fluxo de billing:

**1. Aquisição:** 3 dias de trial + 7 dias de grace pós-vencimento = **10 dias rodando sem pagar**. Durante o grace (`past_due`) o painel e a storefront pública continuam 100% funcionais. Na prática, um barbeiro pode cadastrar, atender clientes por 10 dias e nunca pagar — não temos pressão real de fluxo de caixa no MVP.

**2. Retenção / inadimplência:** O mesmo `past_due` frouxo afeta o **ciclo mensal**. Barbeiro que pagou 5 meses tem cobrança falhada no 6º mês → Asaas marca `OVERDUE` → nosso cron sync detecta → vira `past_due` local → mas continua usando o sistema por 7 dias sem pagar, mesmo já tendo demonstrado vontade de assinar. Nesses 7 dias o gateway **não tenta cobrar de novo automaticamente** (pelo menos no Asaas com PIX/boleto), então a chance de recuperação cai e a gente arca com o custo operacional sem receita.

Além disso, a UX de aquisição é deliberadamente "soft": **landing não mostra preço, painel não cobra pagamento de forma chamativa**. Essa decisão de marketing força que o **gating técnico** seja o vendedor — se ele também é frouxo, ninguém paga.

### Objetivo

Reduzir a janela total sem pagar de **10 dias → 4 dias** no trial novo (3 trial + 1 grace), **e** reduzir a janela de inadimplência mensal de **7 dias → 1 dia** (idêntico grace). Ativar `past_due` como estado **bloqueante de escritas** + **storefront fora do ar** + **banner inescapável** no admin, **independente da origem** do past_due. Aplicar a **mesma regra dura** nos dois cenários, sem dual code path no backend.

### Por que agora

- Plataforma já em produção (Railway, branch `main` → CI verde → deploy auto), faltam apenas barbeiros pagantes
- O `cancelled` já bloqueia corretamente — toda a infra de status/guard/middleware existe; basta endurecer `past_due` pra reaproveitar
- IA visagismo já bloqueia em `past_due` ([ai-visagism.service.ts:255](../../../src/modules/ai-visagism/ai-visagism.service.ts)) — temos precedente vivo

### Comportamento dos providers (verificado na doc oficial em 2026-05-20)

| Provider | Retry automático em falha de cobrança? | Fonte |
|---|---|---|
| Mercado Pago (legado/fallback) | Sim, até 3 tentativas em cartão recorrente quando há fundos insuficientes ou cancelamento | [docs MP](https://www.mercadopago.com.co/developers/en/docs/subscriptions/subscription-management) |
| Asaas — PIX/boleto (primário, `billingType='UNDEFINED'`) | **Não tem retry.** Passou do `dueDate`, vira `OVERDUE` no dia seguinte. | Doc Asaas não menciona retry pra PIX/boleto |
| Asaas — cartão recorrente | Não documentado oficialmente. Pode ter retry no adquirente, mas Asaas não expõe. | Inconclusivo |

Implicação: como Asaas é primário e a maioria dos barbeiros provavelmente paga via PIX/boleto, **a janela natural entre "fatura venceu" e "Asaas marca OVERDUE" é ~24h**. A nossa janela de 1 dia de grace é em cima disso, então o total "vencimento → cancelled" é ~2-3 dias. A latência adicional é o tempo entre o Asaas marcar OVERDUE e nosso cron sync detectar — minimizada por D-11.

---

## 2. Invariants (regras globais, não-negociáveis)

| ID | Invariant |
|---|---|
| INV-01 | `past_due` é estado **bloqueante** de mutações no `/admin/*` e **invisibilizante** da storefront pública `/public/{slug}/*` (mesmo comportamento de 404 que `cancelled`), **independente da origem** (trial expirado ou ciclo mensal vencido). |
| INV-02 | Leituras (`GET`) no `/admin/*` permanecem liberadas em `past_due`, exceto endpoints explicitamente mutáveis via GET (não há nenhum no projeto — auditável). |
| INV-03 | `/admin/billing/*` (incluindo `POST /checkout` e `GET /status`) é **whitelist** que funciona em qualquer status — é o único caminho de saída do `past_due`. |
| INV-04 | A janela de grace é a mesma pros **dois cenários cobertos por este spec** — trial expirado (signup → 3d → nunca assinou) e ciclo mensal vencido (assinante existente que falhou a cobrança recorrente): **1 dia** (`BILLING_PAST_DUE_GRACE_DAYS=1`). Sem regra dual no backend. |
| INV-05 | A diferenciação trial vs inadimplência existe apenas na **camada de copy do banner no front**, derivada de `currentPeriodEnd IS NOT NULL` (proxy de "já pagou pelo menos 1x"). Backend trata igual. |
| INV-06 | Avisos saem **apenas via banner no admin** nesta entrega. Emails transacionais ficam fora do escopo (YAGNI — adicionar on-demand se observarmos churn evitável). |
| INV-07 | A storefront em `past_due` ou `cancelled` retorna **404 puro** (mesma mensagem de "barbearia não encontrada"). Sem página "em manutenção". |
| INV-08 | Mudanças não podem quebrar o fluxo de **reativação**: tenant cancelado clica "Renovar" em `/admin/billing`, paga, e volta pra `active` no próximo sync. Isto já funciona ([billing.service.ts:86-149](../../../src/modules/billing/billing.service.ts)) e o desenho preserva. |
| INV-09 | Filtragem leitura vs escrita é por **método HTTP** (`GET` libera, `POST`/`PUT`/`PATCH`/`DELETE` bloqueia). Sem decorator por endpoint, sem whitelist de paths. |
| INV-10 | A contagem regressiva exibida no banner é **calculada no backend** e exposta via `GET /admin/billing/status` — front nunca calcula data sozinho. |
| INV-11 | O cron `BILLING_SYNC_CRON` roda **1x por hora** (`0 * * * *`). Reduz a latência entre "Asaas marca OVERDUE" e "nosso status local vira `past_due`" pra ≤1h. |

---

## 3. Glossário travado

| Termo | Definição precisa neste spec |
|---|---|
| **Trial** | Período inicial de 3 dias logo após signup (`trialing` status). Sem cobrança, todas as features liberadas. |
| **Past_due** | Estado intermediário "vencido": ou o trial acabou sem assinatura, ou o pagamento recorrente falhou. Dura 1 dia. |
| **Cancelled** | Estado terminal: sem acesso ao painel (exceto `/admin/billing`), storefront 404. Pode reativar via novo checkout. |
| **Grace period** | A janela em `past_due` antes de cair em `cancelled`. **Sempre 1 dia.** |
| **Janela total sem pagar** | Tempo desde o signup até `cancelled` se o barbeiro nunca pagar: **4 dias** (3 trial + 1 grace). |
| **Origem do past_due** | Causa que levou ao status: **trial-origin** (`currentPeriodEnd IS NULL`) ou **payment-origin** (`currentPeriodEnd IS NOT NULL`). Usado apenas pra UI customizar copy do banner. |
| **Banner billing** | Faixa fixa no topo do shell do admin (`kairobarber-web`), sempre visível durante `trialing` e `past_due`, com countdown + CTA "Assinar agora". |
| **Read-only** | No `past_due`, todos os `GET` funcionam; todos os `POST`/`PUT`/`PATCH`/`DELETE` retornam 402 (exceto whitelist `/admin/billing/*`). |
| **Storefront** | Páginas públicas sem auth em `/public/{slug}/*` (API) e `/b/{slug}/*` (web). Em `past_due`/`cancelled` retornam 404. |
| **Reativação** | Tenant em `past_due` ou `cancelled` clica "Renovar" → cria novo `preapproval` no gateway → paga → sync detecta `authorized` → volta pra `active`. |

---

## 4. Decision log

| Decisão | Alternativas rejeitadas | Por quê |
|---|---|---|
| D-01: Aplicar gating idêntico pra trial-origin e payment-origin | Janelas separadas (1d trial, 5d inadimplência) | Decisão explícita do owner: "se ele assinou e deixou vencer, é responsabilidade dele" + avisos pré-vencimento via banner já cobrem o cliente fiel. Simplicidade > diferenciação. |
| D-02: Filtrar leitura/escrita por método HTTP | Decorator `@AllowInPastDue` em cada endpoint; whitelist de paths | Projeto segue REST padrão, zero endpoints mutam via GET (validado em [billing.service.ts](../../../src/modules/billing/billing.service.ts) e demais módulos). Zero código de manutenção por endpoint. |
| D-03: Sem emails nesta entrega | Email D-1 trial, D-1 cobrança, D+0 falha, D+1 past_due | YAGNI. Banner persistente + storefront caindo já criam pressão visível imediata. Emails entram fase 2 se observarmos churn evitável. |
| D-04: Storefront retorna 404 puro (não "em manutenção") | Página informativa "voltamos logo" | 404 puro maximiza pressão social: cliente liga pro barbeiro dizendo "tua página sumiu", barbeiro paga rápido. Mensagem amigável dilui o sinal. |
| D-05: Diferenciar trial vs inadimplência apenas via copy do banner | Adicionar coluna `pastDueReason` no DB; rota separada | `currentPeriodEnd IS NOT NULL` é proxy suficiente. Sem migration, sem nova coluna, sem regra dual no guard. |
| D-06: Manter `BILLING_TRIAL_DAYS=3` | 7 dias (mais generoso na aquisição); 1 dia (relâmpago) | 3 dias já é o atual em prod e é suficiente pra avaliar o produto. Mudar só o grace é a alavanca mais cirúrgica. |
| D-07: Reduzir `BILLING_PAST_DUE_GRACE_DAYS` 7 → 1 | 3 dias (compromisso); 0 dias (sem grace) | 1 dia dá ao barbeiro 24h pra perceber + pagar. 0 dia seria brutal pra quem só esqueceu de pagar. 3 dias dilui demais. |
| D-08: Endpoint `GET /admin/billing/status` retorna countdown calculado | Front calcula via `trialEndsAt`/`updatedAt` | Mantém invariant INV-10 (lógica de data centralizada). Permite ajustar no backend sem deploy do front. Padroniza fuso. |
| D-09: Banner via polling TanStack Query (5 min) | SSE/WebSocket; cálculo client-side | Polling 5 min é suficiente — granularidade da UX é "X dias Y horas", não segundos. Zero infra nova, padrão já usado no projeto. |
| D-10: Whitelist `/admin/billing/*` no guard | Decorator opt-in | Único caminho de saída do `past_due` é checkout — não pode bloquear. Hardcode é mais seguro que decorator esquecido. |
| D-11: `BILLING_SYNC_CRON` 2x/dia → 1x/hora (`0 * * * *`) | Manter 2x/dia; 4x/dia; on-demand apenas | Asaas (provider primário) não tem retry pra PIX/boleto; quando marca OVERDUE, precisamos detectar rápido pra past_due reagir. 1x/hora corta latência de até 12h pra até 1h. Custo: ~24x mais polling/dia, mas `findDueForSync` filtra por `nextSyncAt` e por status (`trialing`/`active`/`past_due`) — volume real escala com base ativa, não 24x. Aceito. |
| D-12: NÃO documentar comportamento Asaas-sem-retry como mitigação inerente | Confiar no retry do gateway pra suavizar grace | Asaas (primário) não tem retry pra PIX/boleto (verificado em doc oficial 2026-05-20). Pra cartão é inconclusivo. Logo, nossa janela de 1 dia DEVE ser tratada como janela total, sem assumir "buffer do gateway". Documentado em §1 pra evitar erro futuro. |

---

## 5. Escopo

### Está no escopo desta spec
- Reduzir `BILLING_PAST_DUE_GRACE_DAYS` default 7 → 1 (env + Joi schema + spec backend)
- Endurecer [subscription-active.guard.ts](../../../src/common/guards/subscription-active.guard.ts): bloquear escritas em `past_due` com whitelist `/admin/billing/*`
- Endurecer [public-tenant.middleware.ts](../../../src/common/middleware/public-tenant.middleware.ts): incluir `past_due` no 404 da storefront
- Novo endpoint `GET /admin/billing/status` retornando `{ status, msUntilDeadline, deadlineAt, origin: 'trial' | 'payment' | null }`
- Auditoria de bloqueio (novos eventos no [audit-actions.ts](../../../src/common/audit/audit-actions.ts) opcional)
- Componente `<BillingBanner>` global no shell do admin do front
- Modal "Pague pra continuar" capturando 402 (`SUBSCRIPTION_PAST_DUE`) em respostas de mutação
- Atualizar [kairobarber-api/CLAUDE.md](../../../CLAUDE.md): corrigir "trial 14 dias" → "trial 3 dias, grace 1 dia"
- Atualizar spec mestre backend ([2026-05-11-kairobarber-backend-design.md](2026-05-11-kairobarber-backend-design.md)): seção billing
- Atualizar spec mestre front ([../../kairobarber-web/docs/superpowers/specs/2026-05-16-kairobarber-web-design.md](../../../../kairobarber-web/docs/superpowers/specs/2026-05-16-kairobarber-web-design.md)): seção billing-ui

### Fora de escopo
- Emails transacionais (D-1, D+0, D+1) — fase 2 se necessário
- Modal full-screen no past_due — banner basta
- Mudança no fluxo de checkout / provider Mercado Pago / Asaas
- Limites de uso durante trial (cap de agendamentos, bloqueio de IA)
- Plano free / downgrade
- Mudar landing pública (continua sem preço, decisão de UX do owner)
- Adicionar coluna `pastDueReason` no DB
- Mudar `BILLING_TRIAL_DAYS` (segue 3)
- Mudar comportamento do `cancelled` (já está correto)
- Renomear `past_due` → `vencido` em pt-BR (custo de migration > benefício)

---

## 6. Anti-goals globais

- **Não criar atrito desnecessário pra quem está pagando.** O guard só atua se `status IN ('past_due','cancelled')`; pra `trialing`/`active` nada muda.
- **Não fazer regra dual no backend.** Trial-origin (signup → trial expirou) e payment-origin (ciclo mensal vencido) têm o **mesmo gating** e **mesmo grace**. Só copy do banner diverge. Qualquer `if (origin === 'trial')` no guard, middleware ou service é red flag.
- **Não tratar inadimplência de assinante como "menos urgente" que trial.** Decisão consciente: se o barbeiro assinou e deixou vencer, é responsabilidade dele resolver em 24h, igual ao trial novo. Sem grace estendido pra "cliente fiel".
- **Não introduzir engenharia preditiva.** Sem emails, sem feature flag, sem A/B test, sem rollout gradual. Mudança simples, observável via audit log + churn rate.
- **Não quebrar reativação.** Tenant em `cancelled` paga → volta pra `active` sem intervenção manual.

---

## 7. Fase B1 — Backend: gating + grace curto

### Pré-requisito
- Estar com `kairobarber-api/` no `main`, CI verde, sem migrations pendentes.
- Ler INV-01 a INV-10 + decisões D-01 a D-10 antes de qualquer linha de código.

### Re-leitura obrigatória (Recall Task)
Antes de codar, re-ler este spec inteiro e fazer echo-back de 5 bullets:
1. Em que método HTTP eu bloqueio em `past_due`?
2. Qual é o whitelist de paths que funciona em qualquer status?
3. Qual é o default novo do `BILLING_PAST_DUE_GRACE_DAYS`?
4. O backend diferencia trial-origin vs payment-origin?
5. Qual é o código HTTP de erro pra escrita bloqueada em `past_due`?

### Goal (1 frase)
Após esta fase, qualquer tenant em `past_due` ou `cancelled` está impedido de mutar dados em `/admin/*` (exceto `/admin/billing/*`) e tem storefront `/public/{slug}/*` retornando 404, e a janela de grace caiu de 7 → 1 dia.

### Em escopo
- **R-B1-01:** Mudar default `BILLING_PAST_DUE_GRACE_DAYS` em [env.validation.ts](../../../src/config/env.validation.ts) de 7 → 1.
- **R-B1-02:** Atualizar [.env.example](../../../.env.example): `BILLING_PAST_DUE_GRACE_DAYS=1` + `BILLING_SYNC_CRON='0 * * * *'`.
- **R-B1-03:** Modificar [subscription-active.guard.ts](../../../src/common/guards/subscription-active.guard.ts):
  - Adicionar bypass: se `req.url` começa com `/admin/billing/`, retorna `true`.
  - Se `sub.status === 'past_due'` e `req.method !== 'GET'`, lançar `DomainException` com `ErrorCodes.SUBSCRIPTION_PAST_DUE` (novo código) e HTTP 402.
  - Manter comportamento atual pra `cancelled`.
- **R-B1-04:** Adicionar `SUBSCRIPTION_PAST_DUE` em [error-codes.ts](../../../src/common/exceptions/error-codes.ts).
- **R-B1-05:** Modificar [public-tenant.middleware.ts](../../../src/common/middleware/public-tenant.middleware.ts):L35-43 — incluir `'past_due'` no `if` que retorna 404.
- **R-B1-06:** Criar endpoint `GET /admin/billing/status` em `billing.controller.ts`:
  - Retorna `{ status, msUntilDeadline: number | null, deadlineAt: Date | null, origin: 'trial' | 'payment' | null, hasCheckout: boolean }`.
  - `origin = 'trial'` se `status === 'trialing'` OU (`status === 'past_due'` E `currentPeriodEnd IS NULL`).
  - `origin = 'payment'` se `status === 'past_due'` E `currentPeriodEnd IS NOT NULL`.
  - `origin = null` se `active` ou `cancelled`.
  - `deadlineAt`: pra `trialing` é `trialEndsAt`; pra `past_due` é `updatedAt + BILLING_PAST_DUE_GRACE_DAYS * 24h`; pra `active`/`cancelled` é `null`.
  - `msUntilDeadline`: `deadlineAt - now` em ms; `null` se `deadlineAt` é `null`; `0` (clampado) se já passou da deadline.
  - Decorado com `@AllowInactiveSubscription()` (já existe).
- **R-B1-07:** Testes:
  - Unit no guard: 4 casos (`trialing GET`, `trialing POST`, `past_due GET`, `past_due POST` → 402).
  - Unit no guard: `past_due POST /admin/billing/checkout` → libera.
  - Unit no middleware: tenant `past_due` → 404; tenant `active` → next.
  - E2E em `billing-trial-check.e2e-spec.ts`: criar tenant em past_due → `POST /admin/services` retorna 402, `GET /admin/services` retorna 200.
  - Atualizar `billing.service.spec.ts` (BILLING_PAST_DUE_GRACE_DAYS: 7 → 1 nos mocks; ajustar asserções).
- **R-B1-08:** Atualizar [kairobarber-api/CLAUDE.md](../../../CLAUDE.md) §1: corrigir "trial 14 dias" → "trial 3 dias, grace 1 dia".
- **R-B1-09:** Atualizar [2026-05-11-kairobarber-backend-design.md](2026-05-11-kairobarber-backend-design.md) §billing: refletir nova janela + gating ativo em past_due.

### Fora do escopo desta fase
- Componente de banner no front (vai pra W1)
- Modal de erro 402 no front (vai pra W1)
- Email transacional
- Mudar `BILLING_TRIAL_DAYS`

### Endpoints (tabela exata)

| Método | Path | Mudança |
|---|---|---|
| GET | `/admin/billing/status` | **Novo**. Retorna `{ status, msUntilDeadline, deadlineAt, origin, hasCheckout }`. |
| GET | `/admin/billing/subscription` | Inalterado. |
| POST | `/admin/billing/checkout` | Inalterado. **Whitelist do guard.** |
| DELETE | `/admin/billing/subscription` | Inalterado. **Whitelist do guard.** |
| GET | `/admin/billing/invoices` | Inalterado. |
| POST | `/admin/billing/sync` | Inalterado. **Whitelist do guard.** |
| `*` | `/admin/billing/*` (qualquer) | Sempre liberado pelo guard, qualquer status. |
| GET | `/admin/**` (não-billing) | Libera em `trialing`/`active`/`past_due`. 402 em `cancelled`. |
| POST/PUT/PATCH/DELETE | `/admin/**` (não-billing) | Libera em `trialing`/`active`. **402 em `past_due` e `cancelled`.** |
| GET | `/public/{slug}/*` | 404 se status `past_due` OU `cancelled` OU tenant `suspendedAt IS NOT NULL`. |

### Acceptance (checkboxes verificáveis)
- [ ] `BILLING_PAST_DUE_GRACE_DAYS` default = 1 em env.validation.ts e .env.example.
- [ ] `BILLING_SYNC_CRON` default = `'0 * * * *'` em billing.schedules.ts e .env.example.
- [ ] **Cenário trial expirado** — tenant em `past_due` (com `currentPeriodEnd IS NULL`) chamando `POST /admin/services` recebe 402 + `code: 'SUBSCRIPTION_PAST_DUE'`.
- [ ] **Cenário ciclo mensal vencido** — tenant em `past_due` (com `currentPeriodEnd IS NOT NULL`) chamando `POST /admin/services` recebe 402 + `code: 'SUBSCRIPTION_PAST_DUE'`. Comportamento **idêntico ao cenário trial**.
- [ ] Tenant em `past_due` (qualquer origem) chamando `GET /admin/services` recebe 200.
- [ ] Tenant em `past_due` (qualquer origem) chamando `POST /admin/billing/checkout` recebe 200/201 (cria checkout).
- [ ] Tenant em `past_due` (qualquer origem) chamando `GET /public/{slug}/services` recebe 404.
- [ ] `GET /admin/billing/status` durante trial retorna `{ status: 'trialing', origin: 'trial', deadlineAt: trialEndsAt }`.
- [ ] `GET /admin/billing/status` durante past_due (sem `currentPeriodEnd`) retorna `origin: 'trial'`.
- [ ] `GET /admin/billing/status` durante past_due (com `currentPeriodEnd`) retorna `origin: 'payment'`.
- [ ] Cron `runTrialCheck` com `BILLING_PAST_DUE_GRACE_DAYS=1` move `past_due` → `cancelled` 24h após `updatedAt` — **independente da origem**.
- [ ] Cron `runBillingSync` com `BILLING_SYNC_CRON='0 * * * *'` roda 1x por hora.
- [ ] Fluxo de reativação: tenant cancelled → checkout → sync → active continua passando (e2e existente verde).
- [ ] CLAUDE.md do api atualizada.
- [ ] Spec mestre backend atualizado.
- [ ] `pnpm test`, `pnpm test:e2e`, `pnpm lint`, `pnpm build` verdes.

### Anti-acceptance (não pode acontecer)
- ❌ Tenant em `trialing` ou `active` recebe 402 em qualquer rota.
- ❌ Tenant em `past_due` consegue `POST /admin/appointments`.
- ❌ Tenant em `past_due` consegue acessar `/public/{slug}` sem 404.
- ❌ Tenant em `past_due` NÃO consegue acessar `/admin/billing` ou criar checkout.
- ❌ Migration nova foi criada (nada muda no schema).
- ❌ Nova coluna em `Subscription` ou `Tenant`.
- ❌ Mudança no comportamento do `cancelled`.

---

## 8. Fase W1 — Web: banner + interceptação 402

### Pré-requisito
- Fase B1 mergeada em `main` e deployada (endpoint `/admin/billing/status` disponível em prod).
- Estar em `kairobarber-web/` no `main`, CI verde.

### Re-leitura obrigatória (Recall Task)
Antes de codar, re-ler INV-01 a INV-10 + D-05 + D-08 + D-09 + as 4 fontes de copy do banner (trial novo, trial expirado, payment vencido, payment past_due). Echo-back:
1. Qual endpoint o banner consome e a cada quanto?
2. Quem decide o texto: backend ou front?
3. Como diferencio "ainda no trial" de "trial acabou em past_due"?
4. O que acontece visualmente quando o user em past_due tenta criar um agendamento?
5. O banner aparece em `active`? Em `cancelled`?

### Goal (1 frase)
O barbeiro logado em `trialing`/`past_due` vê um banner persistente no topo do admin com countdown e CTA "Assinar agora"; quando tenta mutar dados em `past_due`, recebe um modal "Pague pra continuar" com link pra checkout.

### Em escopo
- **R-W1-01:** Componente `<BillingBanner>` em `components/billing/billing-banner.tsx` (kairobarber-web).
- **R-W1-02:** Hook `useBillingStatus()` em `hooks/use-billing-status.ts` com TanStack Query, `queryKey: ['billing','status']`, `refetchInterval: 5 * 60 * 1000`.
- **R-W1-03:** Adicionar `<BillingBanner />` no layout do shell `/admin` ([app/admin/layout.tsx](../../../../kairobarber-web/app/admin/layout.tsx)), abaixo do header.
- **R-W1-04:** Copy condicional (4 estados):
  - `trialing`: "🎁 Trial: faltam {countdown}. [Assinar agora]"
  - `past_due` + `origin=trial`: "⚠️ Seu trial acabou. Sua página pública saiu do ar. [Assinar agora]" + sub-linha "Você tem {countdown} antes de perder acesso ao painel."
  - `past_due` + `origin=payment`: "⚠️ Pagamento não confirmado. Sua página pública saiu do ar. [Atualizar pagamento]" + sub-linha "Você tem {countdown} antes de perder acesso ao painel."
  - `active`/`cancelled`/sem dado: não renderiza.
- **R-W1-05:** Countdown formatado em pt-BR ("2 dias e 4 horas", "12 horas e 30 minutos", "47 minutos") via util `formatCountdown(msUntilDeadline)`. Recalcula client-side a cada 60s (mesmo que polling seja 5min) — UX fluida sem mais requests.
- **R-W1-06:** Interceptador global de erro 402 com `code === 'SUBSCRIPTION_PAST_DUE'` no [client/api.ts](../../../../kairobarber-web/lib/api.ts) (ou equivalente do projeto): dispara modal global `<PastDuePaywallModal>` com CTA "Ir pro checkout" → `router.push('/admin/billing')`.
- **R-W1-07:** Estado `active` (já pagou e tudo ok) não renderiza nada (banner ausente = sinal de saúde).
- **R-W1-08:** Cobertura mínima de teste: component test do `<BillingBanner>` com 4 fixtures de status; integration test do interceptador 402.
- **R-W1-09:** Atualizar [2026-05-16-kairobarber-web-design.md](../../../../kairobarber-web/docs/superpowers/specs/2026-05-16-kairobarber-web-design.md): seção billing-ui referenciar este spec + R-W1-NN.

### Fora do escopo desta fase
- Mudança no design system / tokens (banner usa DS existente; cor de alerta já está em [components/ds/](../../../../kairobarber-web/components/ds/))
- Banner em outras telas além do `/admin/*` (`/saas/*` não tem billing; storefront é unauth)
- Email/SMS/push
- Tela de cancelamento (já existe)

### Endpoints consumidos

| Método | Path | Consumo |
|---|---|---|
| GET | `/admin/billing/status` | `useBillingStatus()`, polling 5 min |
| POST | `/admin/billing/checkout` | CTA do banner e do modal paywall |

### Acceptance
- [ ] Banner renderiza em `trialing` com countdown correto.
- [ ] Banner renderiza em `past_due` + `origin=trial` com copy de trial expirado.
- [ ] Banner renderiza em `past_due` + `origin=payment` com copy de pagamento vencido.
- [ ] Banner NÃO renderiza em `active`.
- [ ] Banner NÃO renderiza em `cancelled` (user vai pro paywall de `/admin/billing` direto).
- [ ] Tentar `POST` qualquer em `past_due` abre modal paywall.
- [ ] CTA "Assinar agora" navega pra `/admin/billing` e o checkout flow funciona.
- [ ] Countdown decresce visualmente a cada 60s sem novo request.
- [ ] `pnpm lint`, `pnpm test`, `pnpm build` verdes.

### Anti-acceptance
- ❌ Banner aparece em `active`.
- ❌ Countdown calculado no front a partir de `trialEndsAt` ou `updatedAt` (viola INV-10).
- ❌ Modal paywall aparece em telas de leitura (`GET`).
- ❌ Quebrar layout do shell em mobile.

---

## 9. Riscos e mitigações

| Risco | Mitigação |
|---|---|
| Cliente fiel viajando perde acesso por cartão vencido | Aceito conscientemente (D-01). Mitigação futura: emails de aviso pré-vencimento (fora deste escopo). |
| Storefront 404 confunde clientes finais | Aceito — é o ponto: pressão social força barbeiro a pagar. |
| Endpoint GET muta estado (raro mas possível) | Validado: zero ocorrências no projeto. Se aparecer no futuro, opt-out via decorator. |
| Race entre cron trial-check e ação do user | Cron roda 1x/dia 06:15 UTC; janela de race < 1s. Tolerável; pior caso é 402 momentâneo. |
| Front em cache mostra banner "trial" depois do user já ter pago | Polling de 5 min + invalidação manual do query key após `POST /checkout` mitigar. |
| Audit log enche de eventos de bloqueio | Não logamos bloqueios em audit; só transições de status. Sem nova fonte de ruído. |

---

## 10. Observabilidade

Eventos já logados (não adicionar novos):
- `subscription.trial_expired` ([billing.service.ts:343](../../../src/modules/billing/billing.service.ts))
- `subscription.past_due` ([billing.service.ts:135](../../../src/modules/billing/billing.service.ts))
- `subscription.grace_period_expired` ([billing.service.ts:392](../../../src/modules/billing/billing.service.ts))
- `subscription.cancelled`

Métrica derivável pós-deploy:
- Tempo médio `trial_started` → `subscription_activated` (conversão de trial)
- Tempo médio `past_due` → `subscription_activated` (recovery rate)
- Taxa `past_due` → `cancelled` (churn por inadimplência)

Validar 30 dias após o deploy: se `recovery rate < 10%`, considerar fase 2 (emails).

---

## 11. Plano de fases

| Fase | Conteúdo | Dependência |
|---|---|---|
| B1 | Backend: gating + grace 1 dia + endpoint status | nenhuma |
| W1 | Web: banner + modal paywall | B1 deployada |

Cada fase ganha plano executável via `superpowers:writing-plans` antes de codar.

---

## 12. Recall Task template (a usar como Task 0 de todo plano derivado)

```
Antes de qualquer ação:
1. Re-leia o spec inteiro em
   kairobarber-api/docs/superpowers/specs/2026-05-20-trial-grace-tightening-design.md
2. Responda em echo-back de 5 bullets:
   - Quais invariants (INV-01 a INV-10) são relevantes pra esta fase?
   - Que decisões (D-01 a D-10) eu posso ferir sem perceber?
   - Quais requirements R-{B1|W1}-NN são meu escopo?
   - Qual é o anti-acceptance que me protegerá de scope creep?
   - Qual recall-check de teste prova que eu não quebrei reativação?
3. Só depois de responder, comece a Task 1.
```

---

## 13. Histórico

| Data | Mudança |
|---|---|
| 2026-05-20 | Versão inicial. Brainstorm completo, decisões D-01 a D-10 travadas. |
