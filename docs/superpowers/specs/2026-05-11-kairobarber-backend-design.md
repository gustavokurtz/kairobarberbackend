# KairoBarber — Design do Backend

**Data:** 2026-05-11
**Autor:** Gustavo Nascimento (em colaboração com Claude)
**Status:** Spec aprovada, aguardando plano de implementação
**Escopo deste documento:** somente o backend. Frontend será especificado depois.

---

> **⚠️ Atualizado em 2026-05-20:** as decisões originais sobre trial de 14 dias e grace de 7 dias foram revisadas. Vigentes: **trial 3 dias + grace 1 dia** em past_due (bloqueante de escritas + storefront 404, **independente da origem** — trial expirado ou ciclo mensal vencido). Ver [spec dedicado](2026-05-20-trial-grace-tightening-design.md) — esse spec é load-bearing e tem prioridade sobre as menções a billing nesta página.

## 1. Contexto e objetivo

KairoBarber é um SaaS multi-tenant para barbearias. Existem três tipos de usuário:

- **Dono do SaaS** (Gustavo) — opera a plataforma, vê métricas e gerencia tenants.
- **Barbeiro dono da barbearia** — assina o serviço via Mercado Pago, opera sua loja, contrata funcionários, cadastra cortes, fotos, horários.
- **Cliente final** — entra na URL pública da barbearia (`kairobarber.com/{slug}`), agenda corte, opcionalmente usa o diferencial de IA visagismo.

O **diferencial competitivo** é o chat de IA de visagismo: cliente sobe foto, recebe análise de formato de rosto + sugestões de corte fundamentadas, e pode (opcionalmente) gerar uma foto sua já com o corte sugerido.

### Motivação para começar pelo backend

O autor já tentou anteriormente um monorepo full-stack e nada saiu pronto direito. Este projeto isola o backend primeiro: API contratual definida, dados modelados, fluxos críticos provados, antes de qualquer linha de frontend.

---

## 2. Escopo

### Está no escopo desta spec
- Arquitetura do backend (módulos, fronteiras, comunicação interna)
- Stack técnica
- Modelo de dados (Prisma schema conceitual)
- Endpoints HTTP por módulo (todos os 3 níveis de auth)
- Fluxos críticos end-to-end
- Tratamento de erros, observabilidade, testes
- Segurança e conformidade LGPD
- Plano de fases (build order)

### Fora de escopo (entrarão em specs próprias depois)
- Frontend (admin do barbeiro, storefront pública, painel do SaaS)
- App mobile
- Aceite de pagamento do **cliente final** ao barbeiro (sinal/antecipação)
- Domínio próprio do barbeiro (CNAME)
- Internacionalização (assumimos pt-BR)
- Integração com Google Calendar
- Programa de fidelidade / cupons
- Reviews/avaliações
- Push notification / WhatsApp (email basta no MVP)

---

## 3. Decisões arquiteturais

| Decisão | Escolha | Razão |
|---|---|---|
| Linguagem/framework | NestJS + TypeScript | Estrutura modular forçada pelo framework, ecossistema maduro, familiaridade do autor. |
| ORM | Prisma | DX excelente, type-safe, migrations versionadas. Middleware permite tenant isolation transparente. |
| Banco | Postgres | SQL relacional é melhor fit para este domínio (joins de scheduling, integridade referencial). |
| Estrutura de código | Monolito modular | Evita complexidade prematura. NestJS já força módulos isolados. Extração pra serviço separado é refactor de horas, não dias. |
| Multi-tenancy | Shared DB + coluna `tenantId` | Padrão SaaS, escala até centenas de milhares de tenants. Filtros via middleware Prisma (impossível esquecer). |
| Comunicação assíncrona | BullMQ + Redis | Filas pra IA, email, sync de billing, cleanup LGPD. Workers no mesmo processo no início; extraíveis depois. |
| Storage de fotos | Cloudflare R2 | Compatível S3, sem egress fee — barato pra storefront pública. |
| Email | Resend | DX boa, free tier generoso. |
| IA — análise + geração | OpenAI (GPT-4o vision + gpt-image-1) | Provider único, custo controlado. Trade-off conhecido: edição de imagem inferior a modelos especializados; aceitável pro MVP. Abstraído atrás de interface `VisagismProvider` para troca futura. |
| Mercado Pago integração | **Polling (sem webhook)** | Decisão do autor: shipa rápido sem configurar webhook no MP. Trade-off: status eventualmente consistente. Mitigado com sync on-demand pós-checkout + cron 2x/dia. |
| Billing provider primário | **Asaas** (Mercado Pago vira fallback/legacy) | Decisão tomada em 2026-05-19 após bloqueio no checkout do MP (Confirmar desabilitado). MP **não suporta PIX em assinatura recorrente** (apenas cartão de crédito), limitação estrutural do produto Assinaturas MP. Asaas aceita PIX + cartão + boleto recorrentes nativamente, aceita PF, libera produção rápido. Interface `BillingProvider` já abstraía gateway — código de domínio inalterado, apenas mais um implementador. MP fica em standby (env `BILLING_PROVIDER=mercadopago`) pra rollback rápido se algo no Asaas falhar. |
| Plano comercial | Plano único + trial de 14 dias | Decisão do autor. Sem feature gating complexa no MVP. |
| Cota de IA | Dinâmica por status: `trialing`=10, `active`=30 (env vars `AI_VISAGISM_TRIAL_QUOTA` / `AI_VISAGISM_ACTIVE_QUOTA`) | Débito atômico via UPDATE com CASE no SQL. Counter resetado por cron mensal. Detalhes: `docs/superpowers/specs/2026-05-26-ai-quota-per-status-design.md` |
| Modelo de cliente final | Híbrido (guest + claim opcional) | Sem atrito no agendamento; histórico estruturado via dedup por `(tenantId, phone)`; conta criada via magic link se cliente quiser área pessoal. |
| Auth | JWT (access 15min + refresh 7d) | Stateless, rotação de refresh. Senhas com argon2id. |
| Hospedagem | Railway (Postgres + Redis + Node managed) | Decisão do autor. Migra pra VPS/Fly/AWS quando volume justificar. |
| Slug = | Tenant (barbearia) | Tenant é a barbearia, que pode ter N barbeiros (funcionários). |

---

## 4. Fases de construção

Cada fase é encerrada por um critério verificável. Cada fase ganhará seu próprio plano de implementação detalhado (via skill `writing-plans`) quando chegar a vez. **Este documento descreve todas, mas a próxima ação é gerar o plano da Fase 1.**

### Fase 0 — Fundação
- Setup do projeto NestJS, Prisma, ESLint, Prettier, Jest.
- Docker Compose dev (Postgres, Redis).
- CI básico (GitHub Actions): lint + test + build em PR.
- Deploy automatizado no Railway a partir do `main`.
- Observabilidade mínima: logging estruturado, healthchecks, Sentry.
- `.env` schema validado, secrets fora do repo.

**Pronto quando:** repositório roda local com 1 comando, pipeline de CI verde, deploy automático funciona com endpoint `/health/ready` respondendo 200.

### Fase 1 — Identity + Multi-tenancy
- Módulos: `auth`, `tenants`, common (TenantGuard, RolesGuard, PrismaMiddleware).
- Entidades: `User`, `Tenant`, `Subscription` (criada já em `trialing` no signup).
- Endpoints `/auth/*` completos (register/owner, login, refresh, verify-email, forgot/reset password).
- Endpoint `GET /admin/tenant` autenticado.
- Tenant isolation testada (teste de regressão obrigatório).

**Pronto quando:** dois tenants criados separadamente; cada um só vê os próprios dados; testes de isolation passam.

### Fase 2 — Painel do barbeiro (admin privado, sem público nem pagamento)
- Módulos: `barbers`, `catalog` (services + photos), `storage`.
- CRUD do perfil da barbearia, horários de funcionamento.
- CRUD de barbeiros (convite por email, time-off).
- CRUD de serviços (cortes), com vínculo a barbeiros via `ServiceBarber`.
- Upload de fotos (presigned URL para R2).

**Pronto quando:** um barbeiro consegue, via endpoints autenticados, configurar sua barbearia completa (perfil, horário, 3 barbeiros, 5 serviços, 10 fotos).

### Fase 3 — Storefront pública + Agendamento
- Módulos: `scheduling`, `customers`, `notifications`.
- Endpoints `/public/{slug}/*` read-only (catálogo, fotos, barbeiros).
- `AvailabilityService` com slots calculados.
- Endpoint de criação de agendamento (com guest), cancelamento via magic link.
- Email de confirmação (Resend) + claim link de customer.
- Endpoints `/admin/appointments` (agenda do barbeiro).

**Pronto quando:** cliente faz booking ponta a ponta sem login, recebe email, consegue cancelar pelo link. Barbeiro vê o agendamento na agenda.

### Fase 4 — Billing (Asaas via polling; MP fallback)
- Módulo: `billing`.
- Integração Asaas como provider primário (criar customer + subscription, sync de status) — aceita PIX/cartão/boleto recorrentes.
- Mercado Pago mantido por trás da mesma interface `BillingProvider` (env `BILLING_PROVIDER=mercadopago`) pra rollback.
- Endpoint `/admin/billing/checkout` e `/admin/billing/sync`.
- Cron `billing-sync` 2x/dia + cron `trial-check` diário (continua polling-based).
- Middleware que bloqueia storefront pública e admin se subscription `cancelled`/`past_due` > N dias.

**Pronto quando:** barbeiro completa fluxo de pagamento (PIX **ou** cartão), status local sincroniza, gating de tenant inativo funciona.

> **Nota terminológica**: a interface `BillingProvider` usa nomenclatura herdada do MP (`preapprovalId`, `createPreapproval`). Para Asaas isso é semanticamente `subscriptionId` / `createSubscription`. Mantemos o nome pra evitar churn em colunas DB (`Subscription.mpPreapprovalId`) e callsites. Trate como identifier opaco do provider corrente.

### Fase 5 — Dashboard do dono do SaaS
- Módulo: `saas-admin`.
- Endpoints `/saas/*` (dashboard, tenants, ai-usage, audit-log).
- Métricas: MRR, ARR, churn mensal, conversão trial→paid, tenants ativos.
- Ações administrativas: suspender/reativar tenant.

**Pronto quando:** dono do SaaS consegue auditar a plataforma e tomar ações sobre tenants.

### Fase 6 — IA Visagismo (diferencial)
- Módulo: `ai-visagism`.
- Upload de foto com consentimento LGPD.
- Job de análise (OpenAI vision com sys prompt curado, tool use para JSON estruturado).
- Job de geração de imagem (gpt-image-1).
- Polling de status pelo front.
- Cron de cleanup de fotos vencidas (LGPD).
- Métricas de custo por tenant.

**Pronto quando:** cliente sobe foto, recebe análise + 2-3 sugestões em < 30s, e pode opcionalmente gerar foto com corte. Custos rastreados.

---

## 5. Arquitetura de alto nível

```
┌─────────────────────────────────────────────────────┐
│           kairobarber-api (NestJS monolito)         │
├─────────────────────────────────────────────────────┤
│  Módulos                                            │
│  • auth        • tenants      • catalog            │
│  • barbers     • scheduling   • customers          │
│  • billing     • ai-visagism  • saas-admin         │
│  • storage     • notifications                     │
│                                                     │
│  Cross-cutting: TenantGuard, PrismaMiddleware,     │
│  RolesGuard, RateLimit, AuditLog                   │
└─────────────────────────────────────────────────────┘
         │              │                │
         ▼              ▼                ▼
   ┌──────────┐   ┌──────────┐    ┌──────────────┐
   │ Postgres │   │  Redis   │    │  Providers   │
   │ (Prisma) │   │ (BullMQ) │    │  externos    │
   └──────────┘   └──────────┘    └──────────────┘
                       │            • OpenAI
                       ▼            • Mercado Pago
                  ┌──────────┐     • Resend
                  │ Workers  │     • Cloudflare R2
                  └──────────┘
```

### Princípios estruturantes

1. **Módulos por feature, não por camada técnica.** Cada módulo Nest tem controller, service, repository, DTOs, eventos próprios.
2. **Tenant isolation por padrão.** `TenantGuard` extrai tenant do JWT (ou do slug em rotas públicas) e injeta no request scope. Prisma middleware aplica `WHERE tenant_id = ?` automaticamente.
3. **Operações sensíveis vão pra fila.** IA, geração de imagem, envio de email, sync de billing, cleanup LGPD — tudo via BullMQ.
4. **Endpoints em 3 níveis de auth:**
   - **Públicos** (`/public/{slug}/...`) — storefront
   - **Tenant-scoped** (`/admin/...`) — barbeiro/dono da barbearia
   - **SaaS-admin** (`/saas/...`) — dono do SaaS
5. **Eventos de domínio internos.** Quando algo importante acontece (`AppointmentCreated`, `SubscriptionActivated`, `AiConsultationCompleted`), emite evento. Módulos escutam sem acoplamento direto.

### Estrutura de pastas

```
src/
├── modules/
│   ├── auth/
│   ├── tenants/
│   ├── catalog/        # serviços (cortes), fotos
│   ├── barbers/        # barbeiros da barbearia
│   ├── scheduling/     # horários, slots, agendamentos
│   ├── customers/      # clientes finais (híbrido guest/conta)
│   ├── billing/        # MP, assinatura, trial, gating
│   ├── ai-visagism/    # análise + geração
│   ├── saas-admin/     # dashboard do dono do SaaS
│   ├── notifications/  # email
│   └── storage/        # R2 abstraction
├── common/
│   ├── guards/         # TenantGuard, RolesGuard
│   ├── decorators/     # @CurrentTenant, @Roles
│   ├── middleware/     # Prisma tenant filter
│   ├── events/         # event bus interno
│   └── audit/
├── infra/
│   ├── prisma/
│   ├── queues/         # BullMQ config
│   └── providers/      # OpenAI, MP, Resend, R2 — implementações
└── main.ts
```

---

## 6. Modelo de dados

Princípios:
- Toda tabela de domínio tem `tenantId` (exceto `User` global e tabelas do SaaS).
- Dinheiro em centavos (`Int`), nunca `Float`.
- Datas em UTC; timezone fica no `Tenant`.
- IDs: `cuid()`. Slugs e tokens curtos para URLs públicas.
- Soft delete via `deletedAt` em `Tenant`, `Barber`, `Service`, `Customer`, `Photo`. Hard delete em logs e eventos.

### Entidades principais (representação conceitual — schema Prisma exato será derivado na implementação)

**User** (autenticação global)
- `id`, `email` (unique), `passwordHash` (argon2id), `name`
- `role`: `saas_owner | tenant_owner | barber_member | customer`
- `emailVerifiedAt`
- **Simplificação consciente do MVP:** um User tem um único `role`. Se a mesma pessoa é barbeiro numa barbearia e cliente em outra, usa duas contas (emails diferentes). Cobertura de múltiplos papéis por User entra em parking lot.

**Tenant** (a barbearia)
- `id`, `slug` (unique, regex `^[a-z0-9-]{3,30}$`, blocklist de reservadas)
- `ownerUserId` → User
- `name`, `bio`, `address`, `phone`, `avatarUrl`, `timezone`
- `businessHours` (Json — array por dia da semana, slots de funcionamento)
- `deletedAt`

**Barber** (profissional que corta cabelo)
- `id`, `tenantId`, `userId?` (nullable — só preenchido se o barbeiro loga)
- `displayName`, `bio`, `avatarUrl`, `active`
- `deletedAt`

**TimeOff** (folgas/férias de um barbeiro)
- `id`, `tenantId`, `barberId`, `startsAt`, `endsAt`, `reason?`

**Service** (corte oferecido)
- `id`, `tenantId`, `name`, `description?`, `durationMin`, `priceCents`, `active`, `deletedAt`

**ServiceBarber** (junction — quem faz o quê)
- `serviceId`, `barberId` (PK composta)

**Photo** (galeria)
- `id`, `tenantId`, `r2Key`, `caption?`, `serviceId?` (vinculada a um corte específico, opcional), `barberId?` (autoria, opcional)

**Customer** (cliente final, modelo híbrido)
- `id`, `tenantId`, `name`, `phone`, `email?`
- `userId?` (preenchido após claim de conta)
- `UNIQUE (tenantId, phone)` — chave de deduplicação
- `claimToken?`, `claimTokenExpiresAt?`
- **Comportamento em re-booking com mesmo telefone:** se nome/email vierem diferentes, atualiza os campos no Customer existente e registra no `AuditLog` (`customer.identity_updated`). Não cria novo Customer.

**Appointment**
- `id`, `tenantId`, `barberId`, `serviceId`, `customerId`
- `startsAt` (UTC), `endsAt` (UTC)
- `status`: `pending | confirmed | completed | cancelled | no_show`
- `priceCentsSnapshot`, `durationMinSnapshot`
- `cancellationToken` (único, longo)
- `source`: `public_storefront | admin`
- `cancellationReason?`, `cancelledAt?`

**Subscription** (1:1 com Tenant)
- `id`, `tenantId` (unique)
- `status`: `trialing | active | past_due | cancelled`
- `trialEndsAt`, `currentPeriodEnd`
- `mpPreapprovalId?` (id da assinatura no Mercado Pago)
- `lastSyncedAt`, `nextSyncAt`
- `aiQuotaUsedThisMonth` (Int, default 0)

**AiConsultation** (LGPD-aware)
- `id`, `tenantId`, `customerId?`, `barberId?`
- `inputPhotoR2Key`, `outputPhotoR2Key?`
- `analysisJson?` (formato rosto, recomendações, raciocínio)
- `status`: `queued | processing | completed | failed`
- `providerCostCents` (rastreio de custo)
- `viewToken` (pra cliente acessar resultado sem login)
- `consentAcceptedAt` (LGPD — obrigatório)
- `expiresAt` (default `now() + 90 days`, política de retenção)

**AuditLog** (append-only, hard storage)
- `id`, `tenantId?`, `actorUserId?`, `action` (ex: `appointment.created`)
- `targetType`, `targetId`, `diff` (Json), `ip?`, `userAgent?`, `createdAt`

### Índices críticos

- `Tenant.slug` UNIQUE
- `User.email` UNIQUE
- `Customer (tenantId, phone)` UNIQUE
- `Appointment (tenantId, barberId, startsAt)` — query mais quente
- `Appointment (tenantId, customerId, startsAt DESC)` — histórico
- `Subscription.mpPreapprovalId` UNIQUE
- `Subscription (status, nextSyncAt)` — varredura do cron de sync

### Concorrência

- **Booking race**: criação de `Appointment` roda em transação com `SELECT ... FOR UPDATE` no range de slots do barbeiro. Segundo cliente que tenta o mesmo slot recebe 409.
- **Quota IA**: incremento de `aiQuotaUsedThisMonth` é otimista (na criação do job). Se job falhar, decrementa de volta em compensação.

---

## 7. Endpoints

### `/auth` — sem auth prévia

```
POST   /auth/register/owner          — cria User + Tenant + Subscription(trialing)
POST   /auth/login
POST   /auth/refresh
POST   /auth/logout
POST   /auth/forgot-password
POST   /auth/reset-password
POST   /auth/verify-email
POST   /auth/customers/claim         — magic link do cliente reivindicar conta
```

### `/public/{slug}` — storefront (sem auth, tenant ativo)

```
GET    /public/{slug}                — dados da barbearia
GET    /public/{slug}/barbers
GET    /public/{slug}/services
GET    /public/{slug}/photos
GET    /public/{slug}/availability/by-barber/{barberId}?serviceId&from&to
GET    /public/{slug}/availability/by-service/{serviceId}?from&to
POST   /public/{slug}/appointments   — guest checkout: { serviceId, barberId, startsAt, customer:{name,phone,email} }
GET    /public/appointments/{id}?token=
POST   /public/appointments/{id}/cancel?token=

POST   /public/{slug}/ai/visagism/consultations
                                     — multipart: photo + { consentAcceptedAt, customerId? }
GET    /public/ai/visagism/consultations/{id}?token=
POST   /public/ai/visagism/consultations/{id}/generate-image?token=
```

### `/admin` — barbeiro/dono da barbearia (JWT com tenantId)

**Tenant**
```
GET    /admin/tenant
PATCH  /admin/tenant                       [owner]
PATCH  /admin/tenant/business-hours        [owner]
```

**Barbers**
```
GET    /admin/barbers
POST   /admin/barbers                      [owner]
GET    /admin/barbers/{id}
PATCH  /admin/barbers/{id}                 — barber edita próprio; owner edita qualquer
DELETE /admin/barbers/{id}                 [owner]
POST   /admin/barbers/{id}/time-off
DELETE /admin/barbers/{id}/time-off/{tid}
```

**Services**
```
GET    /admin/services
POST   /admin/services                     [owner]
PATCH  /admin/services/{id}                [owner]
DELETE /admin/services/{id}                [owner]
PUT    /admin/services/{id}/barbers        — substitui lista de barbeiros que fazem o serviço
```

**Photos**
```
GET    /admin/photos
POST   /admin/photos/upload-url            — presigned URL pro R2
POST   /admin/photos                       — confirma upload
DELETE /admin/photos/{id}
```

**Appointments**
```
GET    /admin/appointments?from&to&barberId&status
POST   /admin/appointments                 — walk-in manual
PATCH  /admin/appointments/{id}            — remarcar
POST   /admin/appointments/{id}/confirm
POST   /admin/appointments/{id}/complete
POST   /admin/appointments/{id}/cancel
POST   /admin/appointments/{id}/no-show
```

**Customers**
```
GET    /admin/customers?search
GET    /admin/customers/{id}
GET    /admin/customers/{id}/appointments
```

**Billing**
```
GET    /admin/billing/subscription
POST   /admin/billing/checkout
POST   /admin/billing/sync                 — front chama após retorno do checkout
POST   /admin/billing/cancel
GET    /admin/billing/invoices
```

**Dashboard do barbeiro**
```
GET    /admin/dashboard/summary?from&to
```

### `/saas` — dono do SaaS (role saas_owner)

```
GET    /saas/dashboard                     — MRR, ARR, churn, conv trial→paid
GET    /saas/tenants?status&search&page
GET    /saas/tenants/{id}
POST   /saas/tenants/{id}/suspend
POST   /saas/tenants/{id}/unsuspend
GET    /saas/ai-usage?from&to
GET    /saas/users
GET    /saas/audit-log?actor&action&from&to
```

### Filas BullMQ (internas, não HTTP)

- `ai-visagism-analysis` — OpenAI vision
- `ai-visagism-generation` — gpt-image-1
- `billing-sync` — cron 2x/dia + on-demand
- `notification-email` — Resend
- `ai-photo-cleanup` — diário (LGPD)
- `monthly-quota-reset` — primeiro dia do mês

---

## 8. Fluxos críticos

### 8.1 Onboarding do barbeiro dono

1. `POST /auth/register/owner` valida slug único, cria `User` + `Tenant` + `Subscription{status:trialing, trialEndsAt:now+14d}`.
2. Emite `OwnerRegistered` → email de verificação.
3. Owner pode operar admin imediatamente (trial liberado).
4. Banner no front pede checkout antes do trial acabar.

### 8.2 Cliente marca corte (guest)

1. `GET /public/{slug}/availability/by-service/{id}?from&to` — `AvailabilityService` calcula slots a partir de business hours, schedule + time-off do barbeiro, appointments existentes, duração do serviço.
2. `POST /public/{slug}/appointments` em transação:
   - `findOrCreate` Customer por `(tenantId, phone)`; se cria, gera `claimToken`.
   - Revalida slot com `SELECT FOR UPDATE` (race condition guard).
   - INSERT Appointment com `cancellationToken` e snapshots de preço/duração.
3. Emite `AppointmentCreated` → email cliente (cancel link + claim link se novo), email barbeiro, audit.

### 8.3 Cliente reivindica conta

1. Email tem `app.kairobarber.com/claim?token=...`.
2. `POST /auth/customers/claim { token, password }` valida token (expira 7d), cria `User(role:customer)`, vincula `Customer.userId`.

### 8.4 Consulta de IA visagismo

1. Front coleta consentimento LGPD explícito.
2. `POST /public/{slug}/ai/visagism/consultations` (multipart):
   - Valida subscription ativa.
   - Valida `aiQuotaUsedThisMonth < limite`.
   - Sobe foto pro R2 (signed URL).
   - Cria `AiConsultation{status:queued, expiresAt:now+90d}`.
   - Enfileira `ai-visagism-analysis`.
   - Incrementa cota (otimista).
3. Worker baixa foto, chama OpenAI vision com sys prompt cacheado (tool use força JSON estruturado), grava `analysisJson` e `providerCostCents`, status=`completed`. Falha definitiva → status=`failed` + refund de cota.
4. Front faz polling em `GET /public/ai/visagism/consultations/{id}?token=` a cada 2s.
5. Opcional: `POST .../generate-image` enfileira `ai-visagism-generation`, gera imagem com gpt-image-1, salva no R2.
6. Cron `ai-photo-cleanup` (diário): apaga fotos e zera campos sensíveis em consultas com `expiresAt < now`.

### 8.5 Ciclo de billing (polling)

**Checkout:**
1. `POST /admin/billing/checkout` chama MP API criando preapproval, salva `mpPreapprovalId`, retorna `initPoint`.
2. Front redireciona barbeiro pro MP.
3. Barbeiro paga, MP redireciona pra `/admin/billing/return`.
4. Front chama `POST /admin/billing/sync`: `BillingProvider.fetch(mpPreapprovalId)`, atualiza `Subscription{status:active, currentPeriodEnd, lastSyncedAt}`. Emite `SubscriptionActivated`.

**Cron `billing-sync` (2x/dia):**
- Pega subscriptions com `nextSyncAt <= now`.
- Frequência por status: `trialing` 1x/dia, `active` 1x/dia, `past_due` a cada 2h, `cancelled` para.

**Cron `trial-check` (diário):**
- Subscriptions `trialing` com `trialEndsAt < now` → `past_due`.

**Tratamento de inadimplência:**
- `past_due` por > 7 dias → `cancelled`. Storefront retorna 404; admin bloqueado exceto endpoint de novo checkout.

### 8.6 Cancelamento via magic link

1. `POST /public/appointments/{id}/cancel?token=` valida `cancellationToken`.
2. Regra: bloqueia se `startsAt - now < 2h` (configurável por tenant futuro; valor default no MVP).
3. Status → `cancelled`. Emite `AppointmentCancelled` → email barbeiro, audit.

---

## 9. Tratamento de erros

**Formato de resposta:**
```json
{
  "code": "APPOINTMENT_SLOT_TAKEN",
  "message": "Esse horário já foi reservado.",
  "details": { "slotStartsAt": "2026-05-12T14:00:00Z" },
  "traceId": "abc123"
}
```

**Hierarquia de exceptions:**
- `DomainException` (4xx) — `SlotTakenException`, `QuotaExceededException`, `SubscriptionInactiveException`, `CancellationTooLateException`...
- `ValidationException` (400) — vinda do `class-validator`.
- `AuthException` (401/403)
- `NotFoundException` (404)
- Demais → 500 com `INTERNAL_ERROR`, sem stack pro cliente.

`GlobalExceptionFilter` mapeia tudo. Sem `try/catch` espalhado nos controllers.

**Idempotência:**
- `POST /admin/billing/sync` — naturalmente idempotente.
- `POST /public/{slug}/appointments` — header opcional `Idempotency-Key` (mesmo valor em 24h retorna mesma resposta).

---

## 10. Observabilidade

- **Logging:** `pino` em JSON, com `traceId`, `tenantId`, `userId`, `requestId`. Nunca logar senha, token, cartão, foto base64.
- **Métricas:** endpoint `/metrics` Prometheus.
  - Counters: `appointments_created_total`, `ai_consultations_total{status}`, `mp_sync_total{result}`.
  - Histograms: `http_request_duration_seconds`, `ai_provider_latency_seconds{provider,operation}`.
  - Gauges: `subscriptions_active`, `ai_quota_used_per_tenant`.
- **Tracing:** OpenTelemetry (opcional Fase 0, obrigatório quando IA escalar).
- **Alertas (Sentry):**
  - Qualquer 500 → Sentry.
  - `mp_sync` falhando > 50% por 1h.
  - Quota IA do SaaS estourada.

---

## 11. Estratégia de testes

**Unit (Jest, sem banco):**
- `AvailabilityService` (várias edge cases — slot no limite, time-off, overlap).
- Regras de negócio (cancelamento ≥ 2h, gating de plano, cota).
- Mapping de DTOs.

**Integration (Jest + testcontainers Postgres + Redis):**
- Cada repositório.
- Criação de Appointment com `SELECT FOR UPDATE` (race simulada com dois clientes).
- **Crítico:** middleware Prisma de tenant filtering — teste explícito que tenant A não enxerga dados de tenant B.
- Idempotência do sync de billing.

**E2E (supertest, providers mockados):**
- Onboarding completo.
- Booking guest com claim.
- Sync billing após "pagamento" mockado.
- Visagismo com OpenAI mockado (fixture).

**Não testar:** wrapper do Prisma, getters triviais, validação já coberta por `class-validator`.

**Cobertura mínima:** 70% geral; 90% em `scheduling/` e `billing/`.

---

## 12. Segurança e LGPD

- **Senhas:** argon2id.
- **JWT:** access 15min, refresh 7d com rotação. Refresh hashado no banco.
- **Rate limit (`nestjs-throttler` + Redis):**
  - `/auth/login` — 5/min por IP.
  - `/public/{slug}/appointments` — 10/min por IP.
  - `/public/{slug}/ai/visagism/*` — 3/min por IP + cota mensal por tenant.
- **CORS:** allowlist por env.
- **Helmet** + CSP básica.
- **Validação:** `class-validator` em toda entrada. `whitelist: true, forbidNonWhitelisted: true`.
- **Slug:** regex restrito, blocklist (`admin`, `api`, `saas`, `auth`, `public`, `static`, etc).
- **Upload:** valida MIME real, tamanho máx 10MB, dimensões mínimas, sanitiza nome.
- **LGPD foto IA:**
  - Consentimento explícito obrigatório (log com timestamp).
  - Retenção 90 dias default, configurável.
  - Endpoint de export de dados pessoais (Fase 5+).
  - Direito de deleção: cliente solicita → job apaga `Customer` + dados relacionados. `Appointment` **não** sofre soft/hard delete (preserva integridade financeira/histórica do barbeiro); em vez disso, campos pessoais são **anonimizados** (`customerName → "Cliente removido"`, `customerPhone → null`, vínculo `customerId` mantido para joins de relatório).
- **Secrets:** `.env` + `@nestjs/config` com schema validation. Em prod: variáveis do Railway.

---

## 13. Migrations e deploy

- **Prisma Migrate** versionado em git, aplicado em CI antes do deploy.
- **Sem migrations destrutivas no deploy.** Coluna NOT NULL nova → adiciona nullable → backfill em job → tornar NOT NULL em deploy seguinte. Sempre.
- **Seeds:** `seed.ts` cria `saas_owner` default + tenant de demo só em dev/staging. Bloqueado em prod.
- **Health checks:**
  - `/health/live` — 200 se processo vivo.
  - `/health/ready` — 200 só se Postgres + Redis respondem.
- **Graceful shutdown:** `app.enableShutdownHooks()`, BullMQ drain antes de exit.

---

## 14. Features fora do MVP (parking lot)

Para referência futura. Não entram em nenhuma das Fases 0-6:

- Reviews/avaliações de barbeiro pelo cliente.
- Programa de fidelidade / cupons.
- Domínio próprio do barbeiro (CNAME).
- Push notification / WhatsApp.
- Cliente final pagando o corte adiantado (antecipação/sinal).
- Integração Google Calendar.
- Internacionalização.
- Webhook do Mercado Pago (substituiria polling).
- App mobile.
- Marketplace (cliente busca barbearias por região).
- Múltiplos planos com feature gating diferenciada.
- IA: histórico de cortes do cliente influenciando sugestões futuras.

---

## 15. Riscos conhecidos e mitigações

| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| OpenAI image edit gerar foto ruim, prejudicando diferencial | Média | Alto | Interface `VisagismProvider` abstrai. Trocar pra Replicate (flux-kontext) é 1 classe. Início focar em **qualidade da análise**, não na geração. |
| Polling de MP atrasar ativação após pagamento | Alta | Médio | Sync on-demand pós-checkout resolve 95% dos casos. Cron pega o resto em < 12h. |
| Race condition em booking (dois clientes mesmo slot) | Média | Alto | Transação com `SELECT FOR UPDATE`. Teste integration obrigatório. |
| Vazamento de dados entre tenants | Baixa | Crítico | Prisma middleware aplica filtro automaticamente. Teste de regressão dedicado. Code review obrigatório em qualquer alteração de middleware. |
| LGPD: vazamento de foto facial | Baixa | Crítico | Storage privado (R2 com signed URLs), retenção limitada, consentimento auditado, plano de deleção pronto. |
| Custo de IA explodir | Média | Médio | Cota mensal por tenant (hard limit). Métrica de custo total. Alerta quando passa de teto SaaS. |
| Webhook do MP necessário no futuro | Alta | Baixo | Interface `BillingProvider` permite trocar implementação sem mexer em negócio. |

---

## 16. Próximos passos

1. Esta spec será revisada pelo autor.
2. Após aprovação, invocar a skill `superpowers:writing-plans` para criar o **plano de implementação detalhado da Fase 0 + Fase 1** (Fases 2-6 ganham planos próprios quando chegar a vez — não tudo de uma vez).
3. Implementação roda em ciclos curtos com TDD em módulos de risco (scheduling, billing).
