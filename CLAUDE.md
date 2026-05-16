# CLAUDE.md — KairoBarber API

> Este arquivo é **auto-carregado** pelo Claude Code em toda sessão aberta neste diretório.
> **Leia por inteiro antes de qualquer ação.** Detalhes vivem no spec.

---

## 1. Sobre o projeto

**KairoBarber API** é o backend do SaaS KairoBarber — sistema multi-tenant pra barbearias brasileiras. Resolve a dor de "barbeiro que ainda agenda no caderninho ou no WhatsApp": dá uma vitrine pública com agenda inteligente e um **chat de IA visagismo** como diferencial (cliente sobe foto, IA sugere cortes baseado no formato de rosto, opcional gera prévia visual).

Três audiências consomem a API:

- **SaaS-owner** (Gustavo, único) — `role=saas_owner`, opera plataforma via `/saas/*`. Vê MRR/ARR/churn, gerencia tenants, audita IA usage, suspende/reativa barbearias.
- **Barbeiro** (`role=owner` ou `role=barber`) — usa `/admin/*` autenticado. Owner assina via Mercado Pago, configura barbearia, contrata funcionários. Barbeiros funcionários operam agenda do dia-a-dia.
- **Cliente final** — sem `User` por padrão. Acessa storefront pública `/public/{slug}/*` (sem auth), agenda, recebe email com magic link pra cancelar. Pode opcionalmente fazer claim via `/auth/customers/claim`.

### Diferencial: chat de visagismo (Fase 6)

Storefront em `/public/{slug}/ai/visagism/consultations` — cliente sobe foto multipart com consentimento LGPD, polling em `/public/ai/visagism/consultations/{id}`. Análise via AI SDK + Groq + Llama 4 Scout 17B; geração opt-in via gpt-image-1. Cota: 100/mês/tenant. Retenção LGPD: 7 dias (cron `ai-photo-cleanup`). Provider abstraído (`VisagismProvider`) pra troca futura.

### Modelo de negócio

Plano único Mercado Pago (R$ 49,90/mês), trial 14 dias. **Sem webhook MP** (decisão arquitetural): polling on-demand via `/admin/billing/sync` + cron 2x/dia (`billing-sync`) + cron diário (`trial-check`). Gating: tenant `cancelled` ou `suspended` → storefront `/public/*` retorna 404 (não vaza), `/admin/*` (exceto `/admin/billing`) retorna 402.

### Estado atual

**Fases 0–6 todas em produção** (Railway, branch `main` → CI verde → deploy auto). Próxima evolução é maintenance + extensões pontuais. Detalhes por fase no [README.md](README.md).

### Front pareado

`../kairobarber-web/` (irmão) é o front Next.js 15 que consome 100% destes endpoints. Spec do front: [`../kairobarber-web/docs/superpowers/specs/2026-05-16-kairobarber-web-design.md`](../kairobarber-web/docs/superpowers/specs/2026-05-16-kairobarber-web-design.md). Mapa exato URL ↔ endpoint na §6 daquela spec.

---

## 2. Source of truth: o spec

**TUDO sobre arquitetura, escopo, decisões, fases e requisitos está em:**

📄 [`docs/superpowers/specs/2026-05-11-kairobarber-backend-design.md`](docs/superpowers/specs/2026-05-11-kairobarber-backend-design.md)

Cobre: contexto/objetivo, escopo, decisões arquiteturais (tabela), fases 0–6, arquitetura de alto nível, estrutura de pastas, modelo de dados Prisma conceitual, endpoints por módulo nos 3 níveis de auth, fluxos críticos, tratamento de erros, observabilidade, testes, segurança/LGPD.

---

## 3. Protocolo obrigatório antes de qualquer mudança

### 3.1 Spec primeiro

Antes de codar qualquer mudança não trivial:

1. **Ler do spec:** seção relevante + decisões arquiteturais relacionadas
2. **Se a mudança contradiz o spec:** PARE. Atualize o spec primeiro (decisão registrada), depois implemente
3. **Se a mudança estende o spec:** OK; abra plano via `superpowers:writing-plans` antes de codar mais que 50 linhas

### 3.2 Skills do superpowers (use sempre que couber)

- `superpowers:brainstorming` — antes de **qualquer** mudança criativa (feature nova, refactor com decisão de design)
- `superpowers:writing-plans` — antes de codar mudança não-trivial
- `superpowers:executing-plans` — ao executar plano em sessão separada (com checkpoints)
- `superpowers:test-driven-development` — ao implementar feature/bugfix
- `superpowers:systematic-debugging` — em todo bug, falha de teste, comportamento inesperado
- `superpowers:verification-before-completion` — antes de declarar "pronto", commit, ou PR
- `superpowers:receiving-code-review` — ao receber feedback

### 3.3 Context7 MCP — quando **incerto** sobre lib/API

Use `mcp__plugin_context7_context7__resolve-library-id` + `query-docs` **ANTES** de codar quando:

- Não tem certeza da sintaxe atual de uma API (NestJS 11, Prisma 5, BullMQ 5, AI SDK 6, AWS SDK v3)
- Vai usar feature que sabe que mudou recentemente
- Migração de versão (ex.: Prisma 5 → 6 quando vier)
- Hooks/APIs de libs externas (zod v4, luxon)

**Não chute.** Treino tem cutoff; libs mudam toda semana. Bibliotecas usadas em produção aqui: NestJS, Prisma, BullMQ, AI SDK (Vercel ai + @ai-sdk/groq + @ai-sdk/openai), @aws-sdk/client-s3, argon2, helmet, nestjs-pino, ioredis, joi, luxon, resend, zod.

### 3.4 Não desvie sem registrar

Se uma decisão arquitetural do spec parece errada hoje:
1. Pare antes de implementar diferente
2. Atualize o spec (decisão + razão)
3. Depois implemente

---

## 4. Stack travada (resumo)

| Camada | Escolha |
|---|---|
| Framework | NestJS 11 |
| Linguagem | TypeScript estrito |
| ORM | Prisma 5 |
| DB | Postgres |
| Cache/Queue | Redis + BullMQ |
| Auth | JWT (access 15min + refresh 7d), argon2id |
| Storage | Cloudflare R2 (S3-compatible) via @aws-sdk/client-s3 |
| Email | Resend (console em dev) |
| Billing | Mercado Pago (polling, sem webhook) |
| IA visagismo | AI SDK + Groq (Llama 4 Scout 17B) + OpenAI (gpt-image-1 opt-in) |
| Datas | luxon |
| Validação | zod + class-validator |
| Logger | nestjs-pino (structured) |
| Monitoring | Sentry (opcional via `SENTRY_DSN`) |
| Deploy | Railway, branch `main` → CI verde → auto |

Multi-tenancy: shared DB + coluna `tenantId`. Tenant isolation via TenantGuard + Prisma middleware (impossível esquecer).

---

## 5. Fases (todas done — ver README.md)

| Fase | Entrega | Status |
|---|---|---|
| F0 | Infra base | ✅ |
| F1 | Auth & multi-tenant | ✅ |
| F2 | Catálogo & disponibilidade | ✅ |
| F3 | Storefront pública + agendamento | ✅ |
| F4 | Billing Mercado Pago (polling) | ✅ |
| F5 | SaaS dashboard | ✅ |
| F6 | IA visagismo | ✅ |

Mudanças futuras = maintenance ou extensão pontual; cada uma com plano próprio quando justificar (não improvise).

---

## 6. Comandos comuns

```bash
# Dev
nvm use
corepack enable
pnpm install
cp .env.example .env
docker compose up -d postgres redis
pnpm exec prisma migrate dev
pnpm start:dev               # porta 3000

# Build / testes
pnpm build
pnpm test
pnpm test:cov
pnpm test:e2e                # precisa Postgres
pnpm lint
pnpm format

# Prisma
pnpm prisma:migrate:dev
pnpm prisma:studio

# QA
pnpm qa:smoke
pnpm qa:ui

# Seed (bootstrap saas_owner)
pnpm prisma:seed             # bloqueado em prod sem ALLOW_PROD_SEED=true
```

Healthcheck: `GET /health/ready`.

---

## 7. Onde achar respostas

| Dúvida | Onde |
|---|---|
| "Como funciona feature X?" | Spec + código do módulo em `src/modules/<feature>/` |
| "Pode usar lib Y?" | Spec §3 (decisões arquiteturais) — stack travada |
| "Por que escolhemos Z?" | Spec §3 (decisões) + commit history |
| "O que cada fase entregou?" | README.md (resumo) + spec §4 (detalhado) |
| "Sintaxe atual de lib X?" | **Context7 MCP** (resolve-library-id + query-docs) |
| "Como o front consome essa API?" | `../kairobarber-web/docs/superpowers/specs/2026-05-16-kairobarber-web-design.md` §6 (tabela URL ↔ endpoint) |
| "QA / test plan" | `docs/qa/*.md` |
| "Mudança nova?" | `superpowers:brainstorming` → atualiza spec → `writing-plans` |

---

## 8. Histórico

| Data | Mudança |
|---|---|
| 2026-05-16 | Versão inicial deste CLAUDE.md (projeto já estava em prod nas Fases 0–6). Adicionado em paralelo ao kairobarber-web/CLAUDE.md e ~/.claude/CLAUDE.md global. |
