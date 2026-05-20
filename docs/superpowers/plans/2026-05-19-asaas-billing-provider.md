# Plano: Adicionar `AsaasBillingProvider` (Fase 4 — extensão)

> Mudança additive sobre Fase 4 (Billing). Não altera contrato de domínio nem schema do DB.
> Spec atualizado: [2026-05-11-kairobarber-backend-design.md](../specs/2026-05-11-kairobarber-backend-design.md) — nova decisão "Billing provider primário: Asaas".

---

## 1. Motivação

Mercado Pago Assinaturas não suporta PIX recorrente (estrutural). Tenant final esbarrou no checkout MP ao tentar pagar com saldo em conta (não permitido pra preapproval) e com cartão de crédito novo (Confirmar travado, causa ainda não diagnosticada). Asaas aceita PIX + cartão + boleto recorrentes nativamente, aceita PF, libera produção rápido. Mantemos MP por trás da mesma interface `BillingProvider` pra rollback.

## 2. Invariantes (carregadas do spec)

- **INV-BILLING-01**: Interface `BillingProvider` é a fronteira; nenhum acoplamento de gateway vaza pra `BillingService`, `BillingController`, schedules ou worker.
- **INV-BILLING-02**: `Subscription.mpPreapprovalId` é identifier opaco do provider corrente — coluna **não** será renomeada (evita migration + churn em ~50 callsites).
- **INV-BILLING-03**: Polling permanece como mecanismo de sync (cron 2x/dia + on-demand). Webhook Asaas fica pra fase futura como otimização.
- **INV-BILLING-04**: Status mapping Asaas → domínio é determinístico e implementado **dentro do provider** (não vaza pro service).

## 3. Glossário travado

| Termo na interface | MP | Asaas |
|---|---|---|
| `preapprovalId` | preapproval id | subscription id |
| `createPreapproval` | `POST /preapproval` | `GET /v3/customers?externalReference=` + `POST /v3/customers` (se faltar) + `POST /v3/subscriptions` |
| `fetchPreapproval` | `GET /preapproval/{id}` | `GET /v3/subscriptions/{id}` + `GET /v3/payments?subscription={id}` (pra status detalhado) |
| `cancelPreapproval` | `PUT /preapproval/{id}` status=cancelled | `DELETE /v3/subscriptions/{id}` |
| `listPayments` | `GET /authorized_payments/search?preapproval_id=` | `GET /v3/payments?subscription={id}&offset=&limit=` |
| `initPoint` | `init_point` da preapproval | `invoiceUrl` da primeira cobrança pendente |

## 4. Mapping de status (Asaas → `RemoteSubscriptionStatus`)

```
subscription.status === 'INACTIVE'                          → 'cancelled'
subscription.status === 'EXPIRED'                           → 'paused'
subscription.status === 'ACTIVE' && tem payment OVERDUE     → 'paused'   (past_due no domínio)
subscription.status === 'ACTIVE' && tem payment RECEIVED|CONFIRMED → 'authorized' (active no domínio)
subscription.status === 'ACTIVE' && apenas PENDING          → 'pending'
```

`nextPaymentDate` = `nextDueDate` da próxima cobrança pendente (ordenada asc).

## 5. Decision log

| Decisão | Alternativa rejeitada | Por quê |
|---|---|---|
| `BILLING_PROVIDER=asaas` como nova opção (não substituir MP) | Trocar MP pelo Asaas e deletar `MercadopagoBillingProvider` | Rollback simples se Asaas falhar; também não invalida ambientes que já estavam testando MP. |
| Estender `CreatePreapprovalInput` com `payerName` (obrigatório) e `payerCpfCnpj` (opcional) | Manter interface só com `payerEmail` | Asaas exige `name` ao criar customer. CPF é exigido pra emitir cobrança PIX/boleto mas o Asaas coleta no `paymentLink` se não tivermos. |
| Identificar customer Asaas via `externalReference=tenantId` | Persistir `providerCustomerId` no DB (migration) | Idempotência sem schema change; `GET /v3/customers?externalReference=` faz a busca toda vez. Custo: 1 chamada extra por checkout. |
| `billingType: UNDEFINED` na subscription | Forçar `PIX` ou `CREDIT_CARD` | Deixa o assinante escolher no checkout do Asaas (PIX/cartão/boleto). |
| Sem webhook nesta entrega | Implementar webhook Asaas agora | Polling já cobre; webhook é otimização. Mantém escopo enxuto. |

## 6. Em escopo (`R-ASAAS-NN`)

- **R-ASAAS-01**: Estender `CreatePreapprovalInput` com `payerName: string` e `payerCpfCnpj?: string`.
- **R-ASAAS-02**: `MercadopagoBillingProvider` e `ConsoleBillingProvider` aceitam (e ignoram) os novos campos sem regressão.
- **R-ASAAS-03**: `BillingService.createCheckout` recebe `ownerName` (obrigatório) e `ownerCpfCnpj` (opcional) e repassa ao provider.
- **R-ASAAS-04**: `BillingController.checkout` busca `User.name` e injeta no service.
- **R-ASAAS-05**: Novo `AsaasBillingProvider implements BillingProvider` com mapping definido em §3-§4.
- **R-ASAAS-06**: Env vars `ASAAS_API_KEY`, `ASAAS_API_BASE_URL`, `ASAAS_PLAN_AMOUNT_CENTS`, `ASAAS_BILLING_CYCLE`, `ASAAS_RETURN_URL` no `.env.example` + Joi schema condicional (`BILLING_PROVIDER=asaas`).
- **R-ASAAS-07**: `BILLING_PROVIDER` Joi schema aceita novo valor `asaas`.
- **R-ASAAS-08**: `BillingModule` factory instancia `AsaasBillingProvider` quando `BILLING_PROVIDER=asaas`.
- **R-ASAAS-09**: Suite de testes unitários do `AsaasBillingProvider` (fetch mockado) cobre: createPreapproval (customer novo + customer existente), fetchPreapproval (cada status combination), cancelPreapproval (idempotente em 404), listPayments (paginação), healthCheck.

## 7. FORA do escopo (anti-acceptance)

- Não implementar webhook Asaas nesta entrega.
- Não migrar dados existentes (sem `Subscription` em prod ainda).
- Não pré-preencher cartão no Asaas (rota com `creditCard` direto exigiria muito mais campos; deixar `billingType: UNDEFINED` e usar `invoiceUrl`).
- Não renomear `mpPreapprovalId` no schema.
- Não criar fluxo de cobrança avulsa (`POST /v3/payments`).

## 8. Endpoints da API Asaas usados

| Operação | Método | Path |
|---|---|---|
| Buscar customer por externalReference | GET | `/v3/customers?externalReference={tenantId}&limit=1` |
| Criar customer | POST | `/v3/customers` |
| Criar subscription | POST | `/v3/subscriptions` |
| Buscar subscription | GET | `/v3/subscriptions/{id}` |
| Cancelar subscription | DELETE | `/v3/subscriptions/{id}` |
| Listar payments da subscription | GET | `/v3/payments?subscription={id}&offset=&limit=` |
| Healthcheck | GET | `/v3/customers?limit=1` |

Header de auth: `access_token: $aact_...` (não é `Authorization: Bearer`).

## 9. Acceptance

- [ ] `pnpm build` verde.
- [ ] `pnpm test` verde (todos os providers + BillingService).
- [ ] `pnpm lint` verde.
- [ ] Suite nova `asaas.billing-provider.spec.ts` cobre os 5 cenários de R-ASAAS-09.
- [ ] `.env.example` documenta as 5 novas env vars.
- [ ] `env.validation.ts` rejeita config inválida (`BILLING_PROVIDER=asaas` sem `ASAAS_API_KEY`).
- [ ] Spec atualizado com Decision log entry e nota terminológica.

## 10. Sequência de execução

1. Estender interface `BillingProvider` (`payerName` + `payerCpfCnpj?`) + atualizar testes existentes (MP/Console).
2. Atualizar `BillingService.createCheckout` + `BillingController` + DTO.
3. Adicionar env vars + Joi schema.
4. Escrever testes do `AsaasBillingProvider` (TDD red).
5. Implementar `AsaasBillingProvider`.
6. Plugar no `BillingModule`.
7. Build + test + lint.

---

## 11. Security review (pós-entrega 2026-05-19)

### 11.1 Achados corrigidos nesta entrega

| Sev | Achado | Fix |
|---|---|---|
| 🔴 Alto | **PII em logs**: `requestBody` cru (com `name`/`email`/`cpfCnpj` no Asaas, `payer_email` no MP) era despejado no `logger.warn` quando o provider externo respondia 4xx/5xx → vazava em stdout (Railway) e Sentry. Risco LGPD. | `sanitizeBody()` em ambos providers ([asaas.billing-provider.ts](../../src/modules/billing/providers/asaas.billing-provider.ts), [mercadopago.billing-provider.ts](../../src/modules/billing/providers/mercadopago.billing-provider.ts)) substitui campos PII por `[redacted]`. Testes cobrem. |
| 🟡 Médio | **Re-checkout criava subscriptions órfãs**: `createCheckout` em status `past_due`/`cancelled` sobrescrevia `mpPreapprovalId` no DB sem cancelar o anterior no gateway → assinatura antiga seguia ativa lá, cobrando no próximo ciclo. Bug financeiro (não exploit, mas owner autenticado podia disparar). | `BillingService.createCheckout` agora chama `provider.cancelPreapproval(sub.mpPreapprovalId)` ANTES de criar novo. Idempotente em 404. Falha de cancel não bloqueia o novo checkout (logada como warn). |
| 🟡 Médio | **Sem rate limit específico em `/admin/billing/checkout`**: throttle global de 300/min permitia abuso (mesmo owner autenticado podia disparar várias subscriptions). | `@Throttle({ default: { limit: 3, ttl: 60_000 } })` em [billing.controller.ts](../../src/modules/billing/billing.controller.ts). |

### 11.1.b Achados corrigidos em rodada de code review pós-teste real (2026-05-19 tarde)

| Sev | Achado | Fix |
|---|---|---|
| 🔴 Crítico | **`applyRemoteState` travava reativação de cancelled**: o guard "nunca regredir de cancelled" combinado com o fix de `createCheckout` (que mantém status atual durante espera de pagamento) fazia: user cancelled → Renovar → paga → sync detecta `authorized` → guard mantém cancelled → pagamento fica preso pra sempre. | Guard removido. Defesa real contra "reviver cancelled" é o controle de `mpPreapprovalId`: sem ID válido o sync vira no-op; só chega ao apply se houve checkout explícito. |
| 🟡 Médio | **`runTrialCheck` não cancelava no gateway ao mover past_due → cancelled**: subscription continuava ativa no Asaas gerando payments overdue. Se cliente pagasse a antiga via link do email Asaas e depois clicasse "Reativar" no painel, cobrança duplicada. | Cancela no gateway antes de marcar local cancelled. `mpPreapprovalId` zerado pra evitar sync tentar buscar ID inválido. |
| 🟡 Médio | **Race condition `createCheckout` vs cron `billing-sync`**: cron lia sub com `mpPreapprovalId='OLD'`, user clicava Renovar nesse meio, cron sobrescrevia o `NEW` recém-criado com o resultado do fetch do OLD. | `applyRemoteState` re-fetcha estado atual antes de update; se `mpPreapprovalId` divergiu (alguém criou checkout novo), pula com log `subscription.sync_skipped_stale_preapproval`. +1 read no DB por sync; ganho: consistência. |

### 11.2 Achados documentados para próxima rodada (não bloqueantes)

#### 🟡 SEC-00: `cancelSubscription` em falha de rede do gateway (decisão consciente — não corrigir agora)

**Onde**: [billing.service.ts:135-166](../../src/modules/billing/billing.service.ts#L135-L166).

**Descrição**: Se `provider.cancelPreapproval` lança 5xx (Asaas timeout/instável), o `await` propaga e o `repo.update` local não roda. Cenários:
- Asaas falha de verdade → nada mudou, user pode retentar. OK.
- Asaas cancelou mas resposta perdida (network glitch) → Asaas cancelado + local não. Próximo cron sync detecta `INACTIVE` remoto e marca local cancelled em até 12h. **Janela de inconsistência efêmera**, sem prejuízo financeiro (Asaas não cobra mais).

**Decisão**: manter como está. Auto-cura via cron sync já cobre o pior caso. Alternativa (enqueue de retry via BullMQ) adicionaria complexidade pra ganho marginal. Reavaliar se incidência crescer em produção.

#### 🟡 SEC-01: Race condition em `findOrCreateCustomer` (Asaas)

**Onde**: [asaas.billing-provider.ts](../../src/modules/billing/providers/asaas.billing-provider.ts) — método `findOrCreateCustomer`.

**Descrição**: Dois `POST /admin/billing/checkout` concorrentes pro mesmo `tenantId` podem rodar o `GET /v3/customers?externalReference={tenantId}` simultaneamente, ambos verem `data: []`, e ambos prosseguirem pro `POST /v3/customers`. Resultado: dois Customers Asaas com mesmo `externalReference`.

**Impacto**: Consistência (não exploit). Relatórios Asaas duplicam tenant; futuras buscas por `externalReference` podem retornar customer "errado" não-determinístico. Mitigação parcial: rate limit de 3/min em `/checkout` (fix desta entrega) reduz a janela; segundo POST consecutivo agora cai em 429 ou reusa o customer criado no primeiro.

**Fix proposto** (próxima rodada):
- Lock distribuído em Redis: `SET billing:checkout:{tenantId} 1 NX EX 10` antes do `findOrCreateCustomer`. Libera no final.
- Alternativa mais leve: ao receber `400` no `POST /v3/customers` com código `invalid_object_duplicated_external_reference` (se o Asaas suportar), refazer o GET e usar o customer existente.

#### 🟡 SEC-02: `ASAAS_API_BASE_URL` aceita qualquer URI

**Onde**: [env.validation.ts](../../src/config/env.validation.ts) — `ASAAS_API_BASE_URL: Joi.string().uri()`.

**Descrição**: Validação só exige URI válida. Se `.env` for comprometido (ou config remota envenenada), atacante redireciona tráfego pra servidor próprio. Como `access_token` vai no header, exfiltração de chave em uma única requisição.

**Impacto**: Defesa em profundidade. Requer comprometimento prévio do servidor/secrets manager, então severidade real é baixa, mas vale endurecer.

**Fix proposto** (próxima rodada):
```ts
ASAAS_API_BASE_URL: Joi.string()
  .pattern(/^https:\/\/(api|api-sandbox)\.asaas\.com$/)
  .when('BILLING_PROVIDER', { is: 'asaas', then: Joi.required(), otherwise: Joi.optional().allow('') })
```

#### 🔴 SEC-03: Webhook Asaas exige validação OBRIGATÓRIA (quando for implementado)

**Onde**: Endpoint futuro `/billing/webhook/asaas` (não implementado nesta entrega).

**Descrição**: O webhook do Asaas envia o header `asaas-access-token` com o valor que o operador definiu no painel ao criar o webhook. Esse valor **deve** ser comparado contra `ASAAS_WEBHOOK_TOKEN` da env. **Sem essa validação, qualquer atacante na internet pode forjar um POST `PAYMENT_RECEIVED` apontando pra subscription real e ativar a assinatura sem pagar**. Vulnerabilidade crítica — autenticação completa do estado de pagamento depende desse header.

**Requisitos obrigatórios pra quando implementar**:
1. Decorator `@Public()` (não passa por JwtAuthGuard), mas com validação manual do header.
2. Comparação **time-constant** com `crypto.timingSafeEqual` pra evitar timing attack.
3. Rejeitar com 401 se header ausente ou diferente.
4. Validar `event` type contra whitelist de eventos esperados.
5. Validar que o `payment.subscription` (ou `subscription.id`) no payload corresponde a algum `Subscription.mpPreapprovalId` no DB (evita atacante autenticado de outra org forjar eventos de uma subscription que não é dele).
6. Idempotência: deduplicar por `event.id` (Asaas envia esse campo).
7. Rate limit no endpoint pra evitar DoS via webhook flood.

**Fluxo recomendado** (não substitui polling; é otimização):
```
POST /billing/webhook/asaas
  └─ valida header asaas-access-token (timingSafeEqual contra ASAAS_WEBHOOK_TOKEN)
  └─ valida event.type em whitelist
  └─ dedup por event.id (Redis SET NX EX 86400)
  └─ encontra Subscription por mpPreapprovalId
  └─ enqueue job que chama billingService.syncSubscription(tenantId)
  └─ retorna 200 imediatamente (Asaas retenta em 5xx)
```

A skill `superpowers:brainstorming` deve ser invocada antes de implementar — webhook envolve decisões de design não-triviais.

### 11.3 Vetores verificados como OK (não-issues)

- Gating storefront público: [public-tenant.middleware.ts](../../src/common/middleware/public-tenant.middleware.ts) filtra `deletedAt`, `subscription.status === 'cancelled'`, `suspendedAt` → retorna 404 sem vazar info.
- Gating admin: [subscription-active.guard.ts](../../src/common/guards/subscription-active.guard.ts) bloqueia `cancelled` (past_due > grace vira cancelled via cron).
- Tenant isolation: AsyncLocalStorage + Prisma middleware impedem cross-tenant leak.
- AuthZ: `@Roles(UserRole.tenant_owner)` em `/checkout` e `/cancel`.
- `tenantId` no payload do gateway vem do JWT, nunca do client.
- Path injection: `encodeURIComponent` em todos os providers ao montar URLs com IDs.
- CSRF: JWT em header, sem cookies de sessão.
- Input validation: DTOs com class-validator + `forbidNonWhitelisted` global rejeita campos extras.
- `applyRemoteState` nunca regride status `cancelled` → outro estado ([billing.service.ts:87-94](../../src/modules/billing/billing.service.ts#L87-L94)).
- `cancelPreapproval` é idempotente em 404 em ambos providers.
- Status de pagamento local só muda via chamada real ao provider (`fetchPreapproval`) — cliente não consegue forjar `status=active` via API local.
