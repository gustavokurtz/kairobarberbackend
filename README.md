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
docker compose up -d postgres
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

## Deploy

Push em `main` → CI verde → deploy automático no Railway. Healthcheck em `/health/ready`.
