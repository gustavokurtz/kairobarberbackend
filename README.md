# KairoBarber API

Backend do SaaS KairoBarber (multi-tenant, NestJS + Prisma + Postgres).

## Pré-requisitos

- Node 20 (use `.nvmrc`: `nvm use`)
- Docker + Docker Compose
- npm 10+

## Setup local

```bash
nvm use
npm install
cp .env.example .env
docker compose up -d postgres redis
npx prisma migrate dev
npm run start:dev
```

API sobe em `http://localhost:3000`. Healthcheck: `GET /health/ready`.

## Comandos úteis

| Comando                       | Descrição                                  |
|-------------------------------|---------------------------------------------|
| `npm run start:dev`           | Dev server com watch                       |
| `npm run build`               | Build de produção                          |
| `npm test`                    | Testes unitários                           |
| `npm run test:cov`            | Testes com cobertura                       |
| `npm run test:e2e`            | Testes E2E (precisa Postgres)              |
| `npm run lint`                | ESLint                                     |
| `npm run format`              | Prettier                                   |
| `npm run prisma:migrate:dev`  | Aplicar/gerar migration (dev)              |
| `npm run prisma:studio`       | Prisma Studio (GUI do banco)               |

## Estrutura

Veja [`docs/superpowers/specs/2026-05-11-kairobarber-backend-design.md`](docs/superpowers/specs/2026-05-11-kairobarber-backend-design.md) pro design completo.

## Fases

### Fase 0 — Infra base ✅
Projeto NestJS + Prisma + Postgres, healthcheck, Docker Compose, CI.

### Fase 1 — Auth & multi-tenant ✅
JWT (access + refresh), verificação de e-mail, reset de senha, tenants/barbeiros, convites.

### Fase 2 — Catálogo & disponibilidade ✅
Serviços, galeria de fotos (R2 + console), horários de funcionamento, exceções de agenda.

### Fase 3 — Storefront pública + Agendamento ✅
- `/public/{slug}/(barbers|services|photos|availability/*|appointments)`
- `/admin/appointments` (lista, walk-in, confirm/complete/cancel/no-show, reschedule)
- `/auth/customers/claim` (magic link de cliente)
- Email de confirmação via Resend (ou console em dev)
- Cancelamento por magic link com janela mínima de 2h
- Race-condition guard via `pg_advisory_xact_lock` + `SELECT FOR UPDATE`

### Fase 4 — Billing (Mercado Pago via polling) ✅
- `/admin/billing/(subscription|checkout|sync|cancel|invoices)`
- Provider abstraído (`BillingProvider`): `ConsoleBillingProvider` em dev, `MercadopagoBillingProvider` em prod
- Crons BullMQ:
  - `billing-sync` (default `0 6,18 * * *` UTC) — polling de estado por status
  - `trial-check` (default `15 6 * * *` UTC) — `trialing → past_due` e `past_due → cancelled` após graça
- Gating: tenant `cancelled` ganha 402 em `/admin/*` (exceto billing) e 404 na storefront
- Sem webhook MP — sync on-demand via `/admin/billing/sync` resolve 95% dos casos pós-checkout

## Deploy

Push em `main` → CI verde → deploy automático no Railway. Healthcheck em `/health/ready`.
