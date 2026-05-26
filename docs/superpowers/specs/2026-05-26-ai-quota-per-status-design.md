# Cota de IA por status de assinatura (trial=10, active=30)

**Data:** 2026-05-26
**Autor:** Gustavo Nascimento (em colaboração com Claude)
**Status:** Spec em revisão
**Escopo deste documento:** mudança no limite mensal de consultas de visagismo de IA — backend (kairobarber-api) + front (kairobarber-web). Diferencia cota por status da subscription (trial menor, active maior). Sem mudança de schema.

---

## 1. Contexto e objetivo

### Por que existe

Hoje o limite mensal de consultas de IA é uma **env var global única** (`AI_VISAGISM_MONTHLY_QUOTA=100`), aplicada igualmente a tenants em `trialing` e em `active`. Isso significa que um barbeiro recém-cadastrado, ainda em trial de 3 dias e sem ter pago R$1, pode disparar 100 consultas pra Groq/OpenAI — o mesmo orçamento de quem está pagando R$49/mês. Custo de IA escalando linearmente com cadastro fake/abandono, sem proteção.

### Objetivo

Reduzir o limite de trial de **100→10** e fixar o limite do plano pago em **30** (em vez de 100). Continuar permitindo ajuste sem deploy via env vars. Preservar:
- atomicidade do débito (sem race condition),
- garantia de que a chamada externa (Groq/OpenAI) **só ocorre após** débito bem-sucedido,
- contador único `Subscription.aiQuotaUsedThisMonth` (sem mudar schema),
- reset mensal automatizado existente.

### Por que agora

- Sistema entra em produção em breve (front em construção, backend Fases 0-6 done).
- Custo de IA é o item de orçamento mais difícil de prever e mais sensível a abuso de trial.
- Mudança é cirúrgica (env + ~30 linhas de código + 1 endpoint passa a expor limite).

---

## 2. Invariants (regras globais, não-negociáveis)

| ID | Invariant |
|---|---|
| INV-01 | Cota é debitada via **UPDATE atômico** no Postgres (`UPDATE ... SET used = used+1 WHERE used < limit RETURNING`). Nunca há lookup→update separado no caminho feliz. |
| INV-02 | A chamada ao provider externo (Groq/OpenAI) **só ocorre dentro do worker BullMQ**, e o worker **só processa jobs que foram enfileirados após débito bem-sucedido**. Nenhum cenário pode resultar em chamada externa sem que a cota tenha sido debitada antes. |
| INV-03 | O limite efetivo varia por `SubscriptionStatus`: `trialing` → `AI_VISAGISM_TRIAL_QUOTA` (default 10), `active` → `AI_VISAGISM_ACTIVE_QUOTA` (default 30), `past_due`/`cancelled` → 0 (na prática nunca chegam aqui devido ao gating de subscription em outras camadas, mas o CASE no SQL ainda garante). |
| INV-04 | O contador `Subscription.aiQuotaUsedThisMonth` é **único por tenant** e **não é resetado em transições de status** — em particular, trial→active **acumula** (decisão D3). |
| INV-05 | O reset mensal continua sendo um cron único (`JOB_AI_QUOTA_RESET`) que zera `aiQuotaUsedThisMonth` de todas as subscriptions, 1× por mês. Inalterado. |
| INV-06 | Os valores 10 e 30 moram em **env vars** (`AI_VISAGISM_TRIAL_QUOTA`, `AI_VISAGISM_ACTIVE_QUOTA`), não em coluna do banco, não em constante hardcoded. |
| INV-07 | A mensagem de erro no storefront público **não revela** o número exato do limite nem o estado trial vs active — copy genérica do `visagism-error-bubble.tsx` é preservada. |
| INV-08 | Não há `Plan` model nem coluna `planId` em `Subscription`. Plano único permanece premissa (YAGNI). |

---

## 3. Glossário travado

| Termo | Definição precisa neste spec |
|---|---|
| **Limite efetivo** | O número aplicado no `WHERE used < N` do UPDATE atômico naquele instante, em função do `Subscription.status` do tenant. 10 pra trialing, 30 pra active, 0 pros demais. |
| **Trial quota** | `AI_VISAGISM_TRIAL_QUOTA` (default 10). Aplicada quando `status='trialing'`. |
| **Active quota** | `AI_VISAGISM_ACTIVE_QUOTA` (default 30). Aplicada quando `status='active'`. |
| **Débito atômico** | A operação SQL `UPDATE ... WHERE used < CASE status WHEN ...` que, no mesmo round-trip, incrementa o contador OU rejeita por estouro. Nunca dá pra "ler o limite, depois debitar separado" no caminho feliz. |
| **Charge** | Chamada a `QuotaService.chargeOrThrow(tenantId)`. Retorna `{ used, limit }` em sucesso; lança `DomainException(AI_QUOTA_EXCEEDED, 429)` em estouro. |
| **Refund** | Decremento de 1 em `aiQuotaUsedThisMonth` (nunca abaixo de 0) — só chamado em caminho de erro/compensação. Inalterado. |
| **AI usage dashboard** | Página `/saas/ai-usage` no front, vista só pelo saas-owner (Gustavo). Lista tenants e consumo. Passa a mostrar limite dinâmico. |

---

## 4. Decision log

| ID | Decisão | Alternativas rejeitadas | Por quê |
|---|---|---|---|
| D1 | Plano único permanece — nada de `Plan` model agora | (a) Introduzir model `Plan` com `aiMonthlyQuota`; (b) Coluna `aiMonthlyLimit` em `Subscription` populada por plano | YAGNI. Spec atual trava plano único (R$49). Não há plano de Pro/Premium no horizonte previsível. Refator pode ser feito depois sem dor. |
| D2 | Valores em env vars (`AI_VISAGISM_TRIAL_QUOTA=10`, `AI_VISAGISM_ACTIVE_QUOTA=30`) | (a) Coluna `aiMonthlyLimit` em `Subscription`; (b) Constantes hardcoded em `ai-visagism.constants.ts` | Env var alinha com modelo "plano único", permite ajuste por ambiente (dev/staging/prod) sem migration, e zero mudança de schema. |
| D3 | Contador `aiQuotaUsedThisMonth` **não zera** em trial→active (acumula) | (a) Reset pra 0 quando billing.processor detecta transição; (b) Reset condicional (só se already-stourado) | Mudança comportamental mínima. Trial dura só 3 dias — improvável estourar 10. Se virar active no D2 com 4 usados, fica 4/30 (justo, dá pra entender). |
| D4 | Sem migração de dados | (a) `UPDATE Subscription SET aiQuotaUsedThisMonth = 0` no deploy | Confirmado com Gustavo: tenants atuais não chegaram perto do limite. Migração geraria efeito colateral sem necessidade. |
| D5 | UPDATE único com `CASE status` inline no SQL | (a) `SELECT status` + UPDATE com limite resolvido em JS (2 round-trips) | 1 round-trip, atomic, e fecha a janelinha entre lookup e update. Status mora na mesma tabela — overhead é zero. |
| D6 | Front: atualizar **apenas** dashboard saas-owner (`/saas/ai-usage` e `/saas/tenants/[id]`) com limite dinâmico vindo do backend | (a) Adicionar indicador "x/y consultas" no `/admin/*` do tenant; (b) Página dedicada | Escopo mínimo. Indicador em `/admin` precisaria de novo endpoint `GET /admin/ai/usage` — vira fase própria, fora desta entrega. |
| D7 | Copy do storefront (`visagism-error-bubble.tsx`) **não muda** | (a) Diferenciar copy por status (trial vs active); (b) Mostrar quantos faltam | Cliente final não é dono — não pode "fazer upgrade". Copy genérica é correta. Vazamento de billing seria ruído. |
| D8 | `chargeOrThrow` continua síncrono e no caminho-quente (antes de upload R2 e enqueue) | (a) Mover débito pro worker | Mover pro worker permitiria fila com job já criada antes de saber se cota basta — gasto de R2 + DB + logs. O esquema atual rejeita 429 em <50ms se estourado, antes de tocar qualquer recurso pago. |

---

## 5. Arquitetura

### 5.1 Fluxo do débito (caminho quente)

```
POST /public/{slug}/ai/visagism/consultations
        │
        ▼
  ai-visagism.service.ts :: create()
        │
        ├── 1. assertSubscriptionAllowed(tenantId)     [status ∈ {trialing, active}]
        ├── 2. assertPhotoValid(...)
        ├── 3. QuotaService.chargeOrThrow(tenantId)    ← ❗ DÉBITO ATÔMICO (SQL UPDATE com CASE)
        │       │
        │       └─→ se used >= limit_efetivo → throw 429 AI_QUOTA_EXCEEDED
        │
        ├── 4. storage.uploadBuffer(...)                [só ocorre se charge OK]
        ├── 5. repo.create(...)                          [só ocorre se charge OK]
        ├── 6. queue.add(JOB_AI_ANALYSIS, ...)           [só ocorre se charge OK]
        │
        └── return 201 { id, ..., quotaUsed, quotaLimit }
```

Worker (`ai-visagism.processor.ts :: runAnalysis`) consome `JOB_AI_ANALYSIS` e **só aqui** chama `provider.analyze()` (Groq/OpenAI). Como o job só existe se o débito foi feito, **não há cenário onde provider externo seja chamado sem cota debitada**.

### 5.2 Query SQL nova

```sql
UPDATE "Subscription"
SET "aiQuotaUsedThisMonth" = "aiQuotaUsedThisMonth" + 1,
    "updatedAt" = NOW()
WHERE "tenantId" = $1
  AND "aiQuotaUsedThisMonth" < (
    CASE "status"
      WHEN 'trialing' THEN $2  -- trialLimit
      WHEN 'active'   THEN $3  -- activeLimit
      ELSE 0
    END
  )
RETURNING "aiQuotaUsedThisMonth", "status"
```

Se nenhuma linha for retornada (`rows.length === 0`), `chargeOrThrow` faz um `SELECT status` de fallback **somente** pra montar a mensagem de erro 429 com o limite correto (10 ou 30). Isso é read-only e não afeta atomicidade.

### 5.3 Front (escopo W1)

- `GET /saas/ai-usage` passa a retornar `aiQuotaLimit` por linha.
- `GET /saas/tenants/[id]` passa a incluir `subscription.aiQuotaLimit`.
- `AiUsageTable` deleta a constante `MONTHLY_QUOTA = 100` e consome `r.aiQuotaLimit`.
- `/saas/tenants/[id]/page.tsx:89` consome `subscription.aiQuotaLimit`.

---

## 6. Mapa de endpoints (mudanças)

| Método | Path | Mudança |
|---|---|---|
| `POST` | `/public/{slug}/ai/visagism/consultations` | Resposta 201: `quotaLimit` agora é 10 ou 30 (era 100). Resposta 429 `AI_QUOTA_EXCEEDED`: `details.limit` idem. |
| `GET` | `/saas/ai-usage` | Cada item do array passa a incluir `aiQuotaLimit: number` (10 ou 30). |
| `GET` | `/saas/tenants/{id}` | Objeto `subscription` passa a incluir `aiQuotaLimit: number`. |

Nenhum endpoint novo. Nenhum endpoint removido. Nenhum breaking — só adição de campos.

---

## 7. Fases

### Fase B1 — Backend: cota dinâmica por status (kairobarber-api)

**Pré-req:** nenhum (build/test verdes em `main`).

**Re-leitura obrigatória (Recall Task):**
- §2 (Invariants — todos)
- §3 (Glossário)
- §4 (Decision log — todos D1–D8)
- §5.1 e §5.2 (fluxo + SQL)
- §6 (mapa de endpoints — linha do POST e linha do GET /saas/ai-usage)
- §10 (Anti-acceptance)
- §11 (Recall template)

**Goal (1 frase):** substituir a env `AI_VISAGISM_MONTHLY_QUOTA` por `AI_VISAGISM_TRIAL_QUOTA=10` + `AI_VISAGISM_ACTIVE_QUOTA=30`, adaptar `QuotaService`/`QuotaRepository` pra resolver o limite via `CASE status` no SQL atomic, e expor `aiQuotaLimit` nos endpoints SaaS de leitura.

**Em escopo:**
- **R-B1-01** Atualizar `.env.example` e `env.validation.ts` (Joi + type `Env`) — remover var antiga, adicionar as duas novas.
- **R-B1-02** `QuotaService`: ler `trialLimit` e `activeLimit` no constructor; `chargeOrThrow` repassa ambos pro repository; em estouro, lê status separadamente (SELECT) pra montar o erro 429 correto.
- **R-B1-03** `QuotaRepository.tryIncrement`: assinatura nova `(tenantId, trialLimit, activeLimit)`; SQL embute CASE; RETURNING inclui status. `refund` inalterado. `resetAll` inalterado.
- **R-B1-04** `ai-visagism.service.ts:create()`: o campo `quotaLimit` da response 201 (já existente em `CreateConsultationResult`) passa a refletir o limite efetivo dinâmico (10 ou 30). Nenhuma estrutura nova — só o valor muda em runtime. Idem `details.limit` no erro 429.
- **R-B1-05** `SaasAiUsageService.snapshot` (`src/modules/saas-admin/services/saas-ai-usage.service.ts`, servindo `GET /saas/ai-usage` via `SaasAdminController`): cada item do array passa a incluir `aiQuotaLimit: number`, resolvido em função de `subscription.status` (10/30/0).
- **R-B1-06** `SaasTenantsService` (`src/modules/saas-admin/services/saas-tenants.service.ts`, servindo `GET /saas/tenants/:id`): payload de `subscription` passa a incluir `aiQuotaLimit: number`.
- **R-B1-07** Testes unitários novos em `quota.service.spec.ts` e `quota.repository.spec.ts`. Atualizar mocks/asserts em `ai-visagism.service.spec.ts`.

**FORA do escopo:**
- Migração de `aiQuotaUsedThisMonth` (D4).
- Reset em trial→active (D3).
- Endpoint `GET /admin/ai/usage` pro dono da barbearia (D6 — fase futura, se necessário).
- Plan model ou coluna `aiMonthlyLimit` (D1, D2).

**Endpoints exatos (recall):**

| Método | Path |
|---|---|
| `POST` | `/public/{slug}/ai/visagism/consultations` |
| `GET`  | `/saas/ai-usage` |
| `GET`  | `/saas/tenants/{id}` |

**Acceptance (B1):**
- [ ] `.env.example` sem `AI_VISAGISM_MONTHLY_QUOTA`, com as 2 novas vars.
- [ ] Boot do app falha (Joi) se faltar uma das novas envs (default cobre, mas validate ativo).
- [ ] Unit tests verdes em `quota.service.spec.ts` cobrindo: trial 9→10, trial 10→429, active 29→30, active 30→429, past_due→429 (porque CASE retorna 0).
- [ ] Response 201 do POST de consulta retorna `quotaLimit=10` pra tenant trialing e `quotaLimit=30` pra tenant active.
- [ ] Response 429 do POST de consulta tem `details.limit` refletindo o limite correto.
- [ ] `GET /saas/ai-usage` retorna `aiQuotaLimit` em cada item.
- [ ] `GET /saas/tenants/{id}` retorna `subscription.aiQuotaLimit`.
- [ ] `pnpm lint`, `pnpm build`, `pnpm test` verdes.
- [ ] E2E rodado pelo Gustavo (não automático): trial faz 11 consultas, a 11ª 429; active faz 31 consultas, a 31ª 429; transição trial→active não zera contador.

**Anti-acceptance (B1):**
- ❌ Migração de schema (Prisma migrate gerando algo).
- ❌ Reset de contador em transição de status (billing.processor não toca aiQuota).
- ❌ Coluna nova em `Subscription`.
- ❌ Lookup do status no caminho feliz antes do UPDATE (perde atomicidade).
- ❌ Mudança em `refund()` ou no cron `JOB_AI_QUOTA_RESET`.
- ❌ Endpoint novo (zero novos paths).

---

### Fase W1 — Web: limite dinâmico no dashboard saas-owner (kairobarber-web)

**Pré-req:** B1 deployado em prod **antes** (front consumindo campo novo do backend). Sem feature flag.

**Re-leitura obrigatória:**
- §2 (INV-06, INV-07)
- §4 (D6, D7 especificamente)
- §5.3
- §6 (linha `/saas/ai-usage` e `/saas/tenants/{id}`)
- §10 (anti-acceptance)

**Goal (1 frase):** consumir `aiQuotaLimit` retornado pelo backend nos endpoints SaaS e usar como limite no badge/render do dashboard, removendo a constante hardcoded `MONTHLY_QUOTA = 100`.

**Em escopo:**
- **R-W1-01** `src/lib/api/saas.ts`: adicionar `aiQuotaLimit: number` em `SaasAiUsageRow` e no tipo de `subscription` do tenant detail.
- **R-W1-02** `src/app/(saas)/saas/ai-usage/ai-usage-table.tsx`: deletar `const MONTHLY_QUOTA = 100`. Usar `r.aiQuotaLimit`. Badge "No limite" computado como `r.aiQuotaUsedThisMonth >= r.aiQuotaLimit`. Render `{used}/{limit}` em mobile e desktop.
- **R-W1-03** `src/app/(saas)/saas/tenants/[id]/page.tsx:89`: trocar `/100` por `/{subscription.aiQuotaLimit}`.
- **R-W1-04** Mocks E2E em `src/app/api/e2e-mock/saas/_state.ts`: adicionar `aiQuotaLimit` por linha (10 ou 30 conforme status fake do tenant fixture).
- **R-W1-05** Testes vitest atualizados: `tests/component/ai-usage-table.test.tsx` (se não existir, criar) cobrindo render com limit dinâmico.

**FORA do escopo:**
- Indicador em `/admin/*` pro dono da barbearia (D6).
- Mudança em `visagism-error-bubble.tsx` (D7).
- Página dedicada de cota.

**Endpoints consumidos:**

| Método | Path |
|---|---|
| `GET`  | `/saas/ai-usage` |
| `GET`  | `/saas/tenants/{id}` |

**Acceptance (W1):**
- [ ] Dashboard `/saas/ai-usage` renderiza `{used}/{limit}` com `limit` vindo da API por linha (não constante).
- [ ] Tenant fixture em trial mostra `/10`; tenant fixture em active mostra `/30`.
- [ ] Badge "No limite" aciona corretamente em ambos os casos (≥10 pra trial, ≥30 pra active).
- [ ] `/saas/tenants/[id]` mostra cota com limite dinâmico.
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test` verdes.

**Anti-acceptance (W1):**
- ❌ Constante `MONTHLY_QUOTA` resíduo no código.
- ❌ Mudança no `visagism-error-bubble.tsx`.
- ❌ Mudança em qualquer página de `/admin/*`.
- ❌ Cálculo de limite no front (front só consome o que vier).

---

## 8. Fluxos críticos (cenários a validar)

| Cenário | Status atual | Limite efetivo | Ação | Resultado esperado |
|---|---|---|---|---|
| Tenant em trial, 9 consultas feitas | `trialing` | 10 | POST nova consulta | 201, `quotaUsed=10, quotaLimit=10` |
| Tenant em trial, 10 consultas feitas | `trialing` | 10 | POST nova consulta | 429 `AI_QUOTA_EXCEEDED`, `details.limit=10` |
| Tenant em trial com 5 usados vira active | `active` (era trialing) | 30 | POST nova consulta | 201, `quotaUsed=6, quotaLimit=30` (acumula, D3) |
| Tenant em active, 29 consultas | `active` | 30 | POST nova consulta | 201, `quotaUsed=30, quotaLimit=30` |
| Tenant em active, 30 consultas | `active` | 30 | POST nova consulta | 429 `AI_QUOTA_EXCEEDED`, `details.limit=30` |
| Tenant em past_due | `past_due` | 0 (irrelevante) | POST nova consulta | Bloqueado **antes** do charge pelo gating de subscription (storefront 404). Charge nunca é chamado. |
| Reset mensal cron roda | qualquer | n/a | Cron dia 1 | Todos `aiQuotaUsedThisMonth` viram 0 |

---

## 9. Riscos e mitigações

| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Front (W1) deployado antes do backend (B1) → UI quebra mostrando `undefined/undefined` | Baixa | Médio | Deploy backend primeiro, depois front. Documentado no plano. |
| Tenant existente em trial com usado já >10 → bloqueia até reset | Baixíssima | Baixo | Confirmado com Gustavo (D4): ninguém chegou perto. Não precisa migration. |
| Race condition: dois requests concorrentes em used=9 | Zero | Zero | UPDATE atomic. Postgres garante (já era o caso). |
| Status muda de trialing pra active no meio do mês, contador "perde" | Zero | Zero | Decisão D3 explícita: acumula. Nada perde. |
| Custos com Groq/OpenAI ainda altos pós-deploy | Baixa | Médio | Limites mais conservadores (10/30 vs 100). Ajustar env se necessário. |

---

## 10. Anti-goals globais (NUNCA neste spec)

- ❌ Plan model ou planId em Subscription.
- ❌ Coluna `aiMonthlyLimit` em Subscription.
- ❌ Reset de `aiQuotaUsedThisMonth` em transição trial→active.
- ❌ Migração que zera contadores no deploy.
- ❌ Endpoint `GET /admin/ai/usage` (futuro, fora desta entrega).
- ❌ Mudança em `visagism-error-bubble.tsx`.
- ❌ Mudança no cron `JOB_AI_QUOTA_RESET`.
- ❌ Cálculo de limite no front.
- ❌ Lookup de status fora do CASE atomic no caminho feliz.

---

## 11. Recall Task template (Task 0 de todo plano derivado)

Antes de tocar em código de qualquer fase deste spec, escreva no topo do plano:

```
Recall — Fase {B1|W1}

1. **Invariants relevantes:** INV-01, INV-02, INV-03, INV-04, INV-06, INV-08 (B1) / INV-06, INV-07 (W1)
2. **Em escopo:** R-{B1|W1}-01 ... R-{B1|W1}-NN (cole IDs do spec)
3. **Anti-acceptance:** (cole bullets ❌ do bloco da fase + os globais §10)
4. **Endpoints exatos:** (cole tabela do bloco da fase)
5. **Acceptance criteria:** (cole checkboxes do bloco da fase)
```

Se algum bullet parecer adivinhado ou parafraseado vago → **pare e re-leia**.

---

## 12. Histórico de versões

| Data | Mudança |
|---|---|
| 2026-05-26 | Versão inicial. Brainstorming com Gustavo. Decisões D1-D8 fechadas em sessão única. |
