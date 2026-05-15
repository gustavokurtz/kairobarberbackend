# Test Plan — KairoBarber API

Plano de teste canônico do backend. Estruturado por **fluxo de negócio**, não por endpoint solto.

Cada caso aponta para um spec E2E quando já automatizado (`✅ test/e2e/foo.e2e-spec.ts`). Casos sem spec são candidatos a automatizar ou itens do [manual-checklist](./manual-checklist.md).

## Convenções

- **Prioridade**: P0 (smoke / bloqueia release) · P1 (crítico) · P2 (importante) · P3 (nice to have)
- **Status**: ✅ automatizado · 🟡 parcial · ⬜ manual · 🚧 sugerido automatizar

## Variáveis de ambiente para testes manuais

```bash
export API=http://localhost:3000
export SLUG=barbearia-teste
# Após login:
export ACCESS=...
export REFRESH=...
```

---

## 0. Smoke (P0)

| ID | Caso | Status | Comando |
|----|------|--------|---------|
| SMK-01 | `GET /health/live` | ✅ `health.e2e-spec.ts` | `curl -s $API/health/live` |
| SMK-02 | `GET /health/ready` com Postgres up | ✅ | `curl -s $API/health/ready` |
| SMK-03 | Rota protegida sem token → 401 | ✅ (implícito) | `curl -i $API/admin/tenant` |
| SMK-04 | Migrations aplicadas | ⬜ ops | `pnpm exec prisma migrate status` |

---

## 1. Auth & Onboarding

### Happy paths

| ID | Caso | Prioridade | Status | Spec |
|----|------|------------|--------|------|
| AUTH-01 | Registro de owner cria user + tenant + subscription trial + tokens | P0 | ✅ | `auth-onboarding.e2e-spec.ts` |
| AUTH-02 | Login retorna access+refresh | P0 | ✅ | `auth-onboarding.e2e-spec.ts` |
| AUTH-03 | Refresh rotaciona token (refresh antigo invalida) | P1 | ✅ | `auth-onboarding.e2e-spec.ts` |
| AUTH-04 | Logout invalida refresh | P1 | ✅ | `auth-onboarding.e2e-spec.ts` |
| AUTH-05 | Verify email (token único, 1x uso) | P1 | 🟡 verificar | — |
| AUTH-06 | Forgot → reset password completo | P1 | 🚧 | — |
| AUTH-07 | Aceitar convite de barbeiro cria user com role `barber_member` | P1 | 🟡 | `barber-panel-setup.e2e-spec.ts` |
| AUTH-08 | Customer claim por magic link | P1 | 🟡 | `public-booking.e2e-spec.ts` (gera token; faltaria efetivar) |

### Negativos & segurança

| ID | Caso | Prioridade | Status |
|----|------|------------|--------|
| AUTH-N01 | Slug duplicado → 409/422 (NUNCA 500) | P1 | 🟡 |
| AUTH-N02 | Slug inválido (`Aa`, `com espaço`, `chars$`) → 400 | P1 | ✅ DTO |
| AUTH-N03 | Senha < 8 chars → 400 | P1 | ✅ DTO |
| AUTH-N04 | Login senha errada → 401 com mensagem genérica (não distinguir email inexistente) | P1 | 🟡 |
| AUTH-N05 | Throttle login: 6 tentativas em <60s → 429 | P1 | 🚧 |
| AUTH-N06 | Throttle forgot-password: 4 em <60s → 429 | P1 | 🚧 |
| AUTH-N07 | Reset token reusado → 400 | P1 | 🚧 |
| AUTH-N08 | JWT adulterado → 401 | P1 | ✅ JwtGuard |
| AUTH-N09 | Email best-effort: provider falhando NÃO quebra registro | P1 | 🟡 (commit 78dda83 fixou) |

---

## 2. Tenant Setup

| ID | Caso | Prioridade | Status |
|----|------|------------|--------|
| TEN-01 | `GET /admin/tenant` retorna subscription | P1 | ✅ |
| TEN-02 | `PATCH /admin/tenant` atualiza bio/phone/avatar/timezone | P1 | 🟡 |
| TEN-03 | `PATCH /admin/tenant/business-hours` aceita estrutura válida | P0 | ✅ `public-booking.e2e-spec.ts` |
| TEN-04 | BH inválido (end<start, overlap, dia faltando) → 400 | P1 | 🟡 |
| TEN-05 | `avatarUrl` sem protocolo → 400 | P2 | ✅ DTO |
| TEN-06 | Não-owner tentando `PATCH /admin/tenant` → 403 | P1 | 🚧 |

---

## 3. Catálogo (serviços, barbeiros, fotos)

### Serviços

| ID | Caso | Prioridade | Status |
|----|------|------------|--------|
| CAT-01 | Criar serviço (happy) | P1 | ✅ implícito |
| CAT-02 | `durationMin` fora de [5, 480] → 400 | P2 | ✅ DTO |
| CAT-03 | `priceCents` < 0 ou > 1_000_000 → 400 | P2 | ✅ DTO |
| CAT-04 | `PUT /admin/services/:id/barbers` com barber de outro tenant → 400/403 | P1 | ✅ `tenant-isolation.e2e-spec.ts` |
| CAT-05 | Serviço soft-deletado não aparece em `/public/:slug/services` | P1 | 🟡 |
| CAT-06 | Serviço soft-deletado preserva `priceCentsSnapshot` em apt antigo | P1 | 🚧 |

### Barbeiros

| ID | Caso | Prioridade | Status |
|----|------|------------|--------|
| BAR-01 | Criar barbeiro com email → dispara invite | P1 | 🟡 `barber-panel-setup.e2e-spec.ts` |
| BAR-02 | `barber_member` edita só o próprio perfil | P1 | 🟡 |
| BAR-03 | Soft delete remove de listagens públicas | P1 | 🟡 |

### Fotos

| ID | Caso | Prioridade | Status |
|----|------|------------|--------|
| PHO-01 | `POST /admin/photos/upload-url` gera presigned PUT | P1 | 🟡 (provider "console" no E2E) |
| PHO-02 | `POST /admin/photos` confirma upload | P1 | 🟡 |
| PHO-03 | Upload real do navegador via presigned PUT | P1 | ⬜ manual ([manual-checklist](./manual-checklist.md#r2-upload)) |
| PHO-04 | `contentType: application/pdf` → 400 | P2 | 🚧 |

---

## 4. Storefront Pública (`/public/:slug/*`)

| ID | Caso | Prioridade | Status |
|----|------|------------|--------|
| PUB-01 | `GET /public/:slug` retorna dados públicos | P0 | ✅ `public-booking.e2e-spec.ts` |
| PUB-02 | Listas filtram inativos/soft-deletados | P1 | 🟡 |
| PUB-03 | Tenant inexistente → null/404 | P1 | 🟡 |
| PUB-04 | Availability by-barber retorna slots dentro de BH | P0 | ✅ |
| PUB-05 | Availability by-barber sem `serviceId` → 400 | P2 | 🚧 |
| PUB-06 | Availability by-service agrupa por barbeiro | P1 | ✅ |
| PUB-07 | Slot some após booking | P0 | ✅ |
| PUB-08 | Time-off bloqueia slot | P1 | 🚧 |
| PUB-09 | `from > to` → 400 | P3 | 🚧 |
| PUB-10 | Tenant suspended → 404 storefront | P1 | ✅ `saas-admin-suspend.e2e-spec.ts` |
| PUB-11 | Tenant cancelled (billing) → 404 storefront | P1 | ✅ `billing-admin-gating.e2e-spec.ts` |

---

## 5. Booking Público & Magic Link

| ID | Caso | Prioridade | Status |
|----|------|------------|--------|
| BOOK-01 | Booking público happy path (gera tokens, dispara email) | P0 | ✅ `public-booking.e2e-spec.ts` |
| BOOK-02 | **Double-booking concorrente → exatamente 1 vence** | P0 | ✅ `booking-race.e2e-spec.ts` + spec HTTP |
| BOOK-03 | Customer reaproveitado por telefone (não duplica) | P1 | 🟡 |
| BOOK-04 | Lookup por magic link válido | P1 | ✅ |
| BOOK-05 | Lookup token inválido/cruzado → 400 | P1 | ✅ |
| BOOK-06 | Cancel com >2h → 200 | P1 | ✅ |
| BOOK-07 | Cancel com <2h → erro de janela mínima | P1 | 🚧 |
| BOOK-08 | Re-cancel → 409 | P1 | ✅ |
| BOOK-09 | Email falha → booking ainda 201, `emailDelivered: false` | P1 | 🟡 |
| BOOK-10 | `startsAt` no passado → 400 | P2 | 🚧 |
| BOOK-11 | `startsAt` fora de BH → 400/409 | P2 | 🚧 |
| BOOK-12 | `barberId` não associado ao serviço → 400 | P2 | 🚧 |
| BOOK-13 | Throttle: 11 bookings em 60s → 429 | P2 | 🚧 |
| BOOK-14 | **Conteúdo real do email** (HTML, links clicáveis, anti-spam) | P1 | ⬜ manual |

---

## 6. Admin Appointments

| ID | Caso | Prioridade | Status |
|----|------|------------|--------|
| ADM-01 | Listar com `from/to/status/barberId` | P1 | ✅ `admin-appointments.e2e-spec.ts` |
| ADM-02 | `barber_member` só lista os próprios (filtro forçado) | P1 | ✅ |
| ADM-03 | Walk-in com `customerId` | P1 | ✅ |
| ADM-04 | Walk-in com `customer{}` novo (findOrCreateByPhone) | P1 | ✅ |
| ADM-05 | Walk-in sem `customerId` nem `customer` → 400 | P2 | 🚧 |
| ADM-06 | State machine: scheduled → confirmed → completed | P1 | ✅ |
| ADM-07 | Transições inválidas → 409 (nunca 500) | P1 | 🟡 |
| ADM-08 | Reschedule colidindo → 409 | P1 | 🚧 |
| ADM-09 | `barber_member` agindo em apt de outro → 403 | P1 | ✅ |

---

## 7. Multi-Tenant Isolation (Security)

| ID | Caso | Prioridade | Status |
|----|------|------------|--------|
| MT-01 | Listas admin filtram só do tenant atual | P0 | ✅ `tenant-isolation.e2e-spec.ts` |
| MT-02 | `GET /admin/barbers/:id` de outro tenant → 404 | P0 | ✅ |
| MT-03 | `PATCH` cross-tenant → 404/403 | P0 | ✅ |
| MT-04 | Storefront slug-A não vaza ID do slug-B | P0 | ✅ `public-tenant-isolation.e2e-spec.ts` |
| MT-05 | Walk-in admin de A com customer de B → 400/404 | P0 | ✅ |
| MT-06 | SaaS endpoints `/saas/*` exigem `saas_owner` | P1 | ✅ `saas-admin-authz.e2e-spec.ts` |

---

## 8. Billing

| ID | Caso | Prioridade | Status |
|----|------|------------|--------|
| BIL-01 | Trial inicial após registro | P1 | ✅ |
| BIL-02 | `POST /admin/billing/checkout` retorna `checkoutUrl` | P1 | ✅ `billing-checkout.e2e-spec.ts` |
| BIL-03 | `POST /admin/billing/sync` atualiza status | P1 | ✅ `billing-cron-sync.e2e-spec.ts` |
| BIL-04 | Subscription `cancelled` → 402 em `/admin/*` exceto billing | P0 | ✅ `billing-admin-gating.e2e-spec.ts` |
| BIL-05 | `/admin/billing/*` segue acessível mesmo cancelled | P0 | ✅ |
| BIL-06 | `barber_member` chamando `POST /cancel` → 403 | P1 | 🚧 |
| BIL-07 | Cron `trial-check`: trialing expirado → past_due → cancelled | P1 | ✅ `billing-trial-check.e2e-spec.ts` |
| BIL-08 | **Checkout real Mercado Pago sandbox** (URL carrega, pagamento flui) | P1 | ⬜ manual |
| BIL-09 | Após pagamento sandbox, `/sync` reflete `active` | P1 | ⬜ manual |

---

## 9. SaaS Admin (`/saas/*`)

| ID | Caso | Prioridade | Status |
|----|------|------------|--------|
| SAAS-01 | `tenant_owner` em `/saas/*` → 403 | P1 | ✅ `saas-admin-authz.e2e-spec.ts` |
| SAAS-02 | `GET /saas/dashboard` retorna métricas | P1 | ✅ `saas-admin-dashboard.e2e-spec.ts` |
| SAAS-03 | `GET /saas/tenants` com filtros (status/suspended/search) | P1 | ✅ `saas-admin-tenants.e2e-spec.ts` |
| SAAS-04 | Suspend/unsuspend gera 402 em admin, 404 público | P0 | ✅ `saas-admin-suspend.e2e-spec.ts` |
| SAAS-05 | Suspend grava audit log | P1 | ✅ `saas-admin-audit-log.e2e-spec.ts` |
| SAAS-06 | `GET /saas/ai-usage` snapshot do mês | P2 | ✅ `saas-admin-ai-usage.e2e-spec.ts` |
| SAAS-07 | `GET /saas/users` filtros | P2 | ✅ `saas-admin-users.e2e-spec.ts` |

---

## 10. AI Visagism

### Automatizável

| ID | Caso | Prioridade | Status |
|----|------|------------|--------|
| AI-01 | Upload + análise + polling completed | P1 | ✅ `ai-visagism-happy-path.e2e-spec.ts` |
| AI-02 | Cota 100/mês esgotada → 429 | P1 | ✅ `ai-visagism-quota.e2e-spec.ts` |
| AI-03 | Cron `ai-photo-cleanup` apaga rows >7 dias | P1 | ✅ `ai-visagism-cleanup.e2e-spec.ts` |
| AI-04 | Tenant cancelled → 402 / gating de subscription | P1 | ✅ `ai-visagism-gating.e2e-spec.ts` |
| AI-05 | `viewToken` ausente → 400; token errado → 404 | P1 | ✅ `ai-visagism-tokens.e2e-spec.ts` |
| AI-06 | Geração de imagem opt-in (provider mock) | P2 | ✅ `ai-visagism-generation.e2e-spec.ts` |
| AI-07 | `consentAcceptedAt` stale → 400 | P2 | 🟡 |
| AI-08 | Upload sem `photo` field → 400 | P2 | 🚧 |
| AI-09 | Upload de arquivo não-imagem → 400 | P2 | 🚧 |
| AI-10 | Upload >tamanho máx → 413 | P2 | 🚧 |

### Apenas humano (qualidade de IA)

| ID | Caso | Prioridade | Status |
|----|------|------------|--------|
| AI-H01 | Análise faz sentido pra um rosto real (face shape correto) | P1 | ⬜ [manual](./manual-checklist.md#ai-visagism) |
| AI-H02 | Sugestões de corte são coerentes (não absurdas) | P1 | ⬜ manual |
| AI-H03 | Imagem gerada lembra o rosto enviado (não aleatória) | P1 | ⬜ manual |
| AI-H04 | Rejeita não-rostos com mensagem clara (objetos, paisagens) | P1 | ⬜ manual |
| AI-H05 | Tempo de processamento percebido aceitável (<30s) | P2 | ⬜ manual |

---

## 11. Negativos transversais (Security)

| ID | Caso | Prioridade | Status |
|----|------|------------|--------|
| SEC-01 | JWT adulterado → 401 | P1 | ✅ |
| SEC-02 | Access token expirado → 401; refresh ainda funciona | P1 | 🚧 |
| SEC-03 | Payload com chaves extras → ignorado (`whitelist: true` em [test-app.ts](../../test/support/test-app.ts)) | P1 | ✅ ValidationPipe global |
| SEC-04 | SQL injection em `?search=` → tratado como string | P1 | ✅ Prisma parametriza |
| SEC-05 | XSS em campos texto → aceito no back, escapado no front | P2 | ⬜ front |
| SEC-06 | Tokens não vazam em logs | P1 | ⬜ revisar |
| SEC-07 | CORS restrito (não `*` em rotas autenticadas) | P1 | ⬜ revisar config |

---

## Achados de revisão de código (pré-existentes)

Levantados durante a leitura inicial dos controllers. **Não são test cases — são bugs candidatos a serem fechados**:

| # | Arquivo:linha | Severidade | Achado |
|---|---------------|------------|--------|
| 1 | [billing.controller.ts:65-71](../../src/modules/billing/billing.controller.ts#L65) | Medium | `POST /sync` sem `@Roles` — qualquer membro autenticado força sync. Confirmar se intencional. |
| 2 | [tenants.controller.ts:68-71](../../src/modules/tenants/tenants.controller.ts#L68) | Info | `/subscription-debug` parece rota de dev. Confirmar se está atrás de flag/feature toggle em prod. |
| 3 | [time-off.controller.ts](../../src/modules/barbers/time-off.controller.ts) | Medium | Sem `@Roles` — qualquer membro cria/deleta time-off de qualquer barbeiro do tenant. Considerar restringir. |
| 4 | [photos.controller.ts](../../src/modules/catalog/photos.controller.ts) | Medium | Mesmo problema: sem `@Roles`. Qualquer membro deleta fotos. |
| 5 | [public-availability.controller.ts:139-143](../../src/modules/public/public-availability.controller.ts#L139) | Info | Tenant sem business hours retorna lista vazia silenciosa. Confirmar se deveria retornar erro explícito. |

---

## Status agregado

| Total de casos | ✅ Auto | 🟡 Parcial | 🚧 Gap auto | ⬜ Manual |
|---------------|---------|-----------|-------------|----------|
| ~110 | ~52 | ~16 | ~22 | ~11 |

Ver detalhe em [automation-coverage.md](./automation-coverage.md).
