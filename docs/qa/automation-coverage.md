# Automation Coverage

Mapa das specs E2E existentes → o que cada uma cobre → gaps conhecidos.

Roda com `pnpm test:e2e` (sequencial via `--runInBand`, ~30-60s por spec, sobe Postgres + Redis em testcontainers).

## Specs por domínio

### Auth & Onboarding

| Spec | Casos cobertos |
|------|----------------|
| [auth-onboarding.e2e-spec.ts](../../test/e2e/auth-onboarding.e2e-spec.ts) | register/owner, login, refresh, logout, rotação de refresh |
| [barber-panel-setup.e2e-spec.ts](../../test/e2e/barber-panel-setup.e2e-spec.ts) | Setup completo de painel de barbeiro (convite + aceite) |

**Gaps**:
- `forgot-password` → `reset-password` end-to-end (consumir token do email console).
- Verify email (token único, reuso → 400).
- Throttling de `/auth/login` (5/min) e `/auth/forgot-password` (3/min).
- Distinção mensagem genérica vs user enumeration em login com email inexistente.
- Token de reset reusado → 400.

### Storefront pública + Booking

| Spec | Casos cobertos |
|------|----------------|
| [public-booking.e2e-spec.ts](../../test/e2e/public-booking.e2e-spec.ts) | Fluxo completo: setup → catálogo público → availability → booking → tokens → cancel → re-cancel 409. Também: SLOT_TAKEN concorrente via HTTP. |
| [booking-race.e2e-spec.ts](../../test/e2e/booking-race.e2e-spec.ts) | Race condition direto no `AppointmentsService` (sem HTTP) com `pg_advisory_xact_lock`. |
| [public-tenant-isolation.e2e-spec.ts](../../test/e2e/public-tenant-isolation.e2e-spec.ts) | Storefront slug A não vaza recursos de slug B. |

**Gaps**:
- Cancelamento com <2h restantes → erro de janela mínima.
- `startsAt` no passado / fora de business hours → 400/409.
- Throttle de booking público (10/min).
- Reaproveitamento de customer por telefone (sem duplicar).
- Email falhando → `emailDelivered: false` (verificado o try/catch no controller, mas não tem spec).

### Admin

| Spec | Casos cobertos |
|------|----------------|
| [admin-appointments.e2e-spec.ts](../../test/e2e/admin-appointments.e2e-spec.ts) | List com filtros, walk-in, confirm/complete/cancel/no-show, reschedule. Barber só vê os próprios. |
| [tenant-isolation.e2e-spec.ts](../../test/e2e/tenant-isolation.e2e-spec.ts) | Cross-tenant: barbers, services, appointments, customers. |

**Gaps**:
- Transições inválidas de state machine → confirmar todas dão 409 (não 500).
- Reschedule para slot colidindo → 409.
- Edge cases de DTO (datas malformadas no filtro → 400 vs 500).

### Billing

| Spec | Casos cobertos |
|------|----------------|
| [billing-checkout.e2e-spec.ts](../../test/e2e/billing-checkout.e2e-spec.ts) | Criação de checkout via `ConsoleBillingProvider`. |
| [billing-cron-sync.e2e-spec.ts](../../test/e2e/billing-cron-sync.e2e-spec.ts) | Cron de sync atualiza status. |
| [billing-trial-check.e2e-spec.ts](../../test/e2e/billing-trial-check.e2e-spec.ts) | Trialing expirado → past_due → cancelled após graça. |
| [billing-admin-gating.e2e-spec.ts](../../test/e2e/billing-admin-gating.e2e-spec.ts) | Cancelled: 402 em `/admin/*`, billing acessível, 404 storefront. |

**Gaps**:
- `barber_member` chamando `POST /admin/billing/cancel` → 403.
- Checkout real Mercado Pago sandbox (provider real, não console) — não dá pra automatizar sem fixture de pagamento.

### SaaS Admin

| Spec | Casos cobertos |
|------|----------------|
| [saas-admin-authz.e2e-spec.ts](../../test/e2e/saas-admin-authz.e2e-spec.ts) | Tenant_owner → 403 em `/saas/*`. |
| [saas-admin-dashboard.e2e-spec.ts](../../test/e2e/saas-admin-dashboard.e2e-spec.ts) | MRR/ARR/churn/conversion. |
| [saas-admin-tenants.e2e-spec.ts](../../test/e2e/saas-admin-tenants.e2e-spec.ts) | List + filtros + detail. |
| [saas-admin-suspend.e2e-spec.ts](../../test/e2e/saas-admin-suspend.e2e-spec.ts) | Suspend → 402 admin / 404 storefront. Unsuspend volta. |
| [saas-admin-audit-log.e2e-spec.ts](../../test/e2e/saas-admin-audit-log.e2e-spec.ts) | Audit log registra ações + filtros. |
| [saas-admin-ai-usage.e2e-spec.ts](../../test/e2e/saas-admin-ai-usage.e2e-spec.ts) | Snapshot mensal de uso de IA. |
| [saas-admin-users.e2e-spec.ts](../../test/e2e/saas-admin-users.e2e-spec.ts) | Listagem de usuários por role. |

**Cobertura**: muito boa. Nada urgente.

### AI Visagism

| Spec | Casos cobertos |
|------|----------------|
| [ai-visagism-happy-path.e2e-spec.ts](../../test/e2e/ai-visagism-happy-path.e2e-spec.ts) | Upload + análise + polling completed com `viewToken`. |
| [ai-visagism-quota.e2e-spec.ts](../../test/e2e/ai-visagism-quota.e2e-spec.ts) | Cota 100/mês esgotada → 429. |
| [ai-visagism-cleanup.e2e-spec.ts](../../test/e2e/ai-visagism-cleanup.e2e-spec.ts) | Cron LGPD apaga rows >7 dias. |
| [ai-visagism-gating.e2e-spec.ts](../../test/e2e/ai-visagism-gating.e2e-spec.ts) | Subscription cancelled bloqueia. |
| [ai-visagism-tokens.e2e-spec.ts](../../test/e2e/ai-visagism-tokens.e2e-spec.ts) | Token ausente → 400; token errado → 404. |
| [ai-visagism-generation.e2e-spec.ts](../../test/e2e/ai-visagism-generation.e2e-spec.ts) | Geração de imagem opt-in. |

**Gaps automáticos**: Upload sem `photo` field, content-type inválido, tamanho máx (413).

**Não automatizável** (humano apenas): qualidade da análise, coerência das sugestões, qualidade da imagem gerada. Ver [manual-checklist § AI Visagism](./manual-checklist.md#ai-visagism).

### Health & Infra

| Spec | Casos cobertos |
|------|----------------|
| [health.e2e-spec.ts](../../test/e2e/health.e2e-spec.ts) | Liveness + readiness com Postgres. |

---

## Como o E2E é montado

- **Base**: [test/support/test-app.ts](../../test/support/test-app.ts) sobe o `AppModule` completo com `ValidationPipe(whitelist+forbidNonWhitelisted+transform)` e `GlobalExceptionFilter`, envolto em `tenantAls.run` pra ALS funcionar igual ao `main.ts`.
- **Postgres**: `testcontainers/postgresql` por spec — banco efêmero, sem interferência cruzada. Migrations rodam automaticamente em [postgres-container.ts](../../test/support/postgres-container.ts).
- **Redis**: idem, via `startTestRedis()` — necessário pra qualquer spec que toque BullMQ (booking-race usa, mesmo que não use BullMQ diretamente, porque AppModule carrega).
- **Providers externos**: `EMAIL_PROVIDER=console`, `STORAGE_PROVIDER=console`, `AI_VISAGISM_PROVIDER=console`, `BILLING_PROVIDER=console`. Tudo mockado a nível de boundary.

---

## Lacunas com maior payoff pra automatizar

Priorize por ROI:

| Sugestão | Por quê | Esforço estimado |
|----------|---------|-----------------|
| Throttling: spec parametrizado pra `/auth/login`, `/auth/forgot-password`, `/public/.../appointments` | Regressão silenciosa se config mudar | M (1 spec, ~80 linhas) |
| Forgot/reset password end-to-end consumindo console email provider | Fluxo crítico de recuperação, hoje sem spec | M |
| Cancel <2h → erro de janela mínima | Regra de negócio chave da Fase 3 | S |
| Reschedule colidindo → 409 | Pode dar 500 silenciosamente | S |
| State machine completa (matriz de transições) | Garante 409 em vez de 500 em todas inválidas | M |
| Booking edge cases agrupados (`startsAt` passado/fora-BH, barber não-associado) | Cobertura de DTO/validação | M |

Total: ~6 specs novas, talvez 1-2h cada. Cobre quase tudo que hoje é 🚧.

---

## Como adicionar uma nova spec

1. Copiar template de `auth-onboarding.e2e-spec.ts` (mais simples) ou `public-booking.e2e-spec.ts` (mais completo).
2. `beforeAll`: `setTestEnv()`, `startTestPostgres()`, `buildTestApp()`. Se for tocar BullMQ ou billing: também `startTestRedis()`.
3. `afterAll`: `app.close()` → `redis.container.stop()` (se houver) → `container.stop()`.
4. Usar helpers em [test/support/](../../test/support/): `saas.ts` (createTenantOwner), `time.ts` (nextOpenSlotISO), `billing.ts`, `ai-visagism.ts`.
5. Rodar isolado: `pnpm test:e2e -- nome-do-spec`.
