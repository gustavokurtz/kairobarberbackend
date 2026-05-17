# CLAUDE.md — KairoBarber API

> Auto-carregado em toda sessão do Claude Code aberta neste diretório.
> Leia antes de qualquer ação. Especificidades de fase/spec vivem em `docs/superpowers/`.

---

## 1. Sobre o projeto

**KairoBarber API** é o backend do SaaS KairoBarber — sistema multi-tenant pra barbearias brasileiras. Resolve a dor de "barbeiro que ainda agenda no caderninho ou no WhatsApp": vitrine pública com agenda inteligente e **chat de IA visagismo** como diferencial (cliente sobe foto, IA sugere cortes baseado no formato de rosto, opcional gera prévia visual).

Três audiências consomem a API:

- **SaaS-owner** (Gustavo, único) — `role=saas_owner`, opera plataforma via `/saas/*`. Vê MRR/ARR/churn, gerencia tenants, audita IA usage, suspende/reativa barbearias.
- **Barbeiro** (`role=tenant_owner` ou `role=barber_member`) — usa `/admin/*` autenticado. Owner assina via Mercado Pago, configura barbearia, contrata funcionários. Funcionários operam agenda do dia-a-dia.
- **Cliente final** — sem `User` por padrão. Acessa storefront pública `/public/{slug}/*` (sem auth), agenda, recebe email com magic link pra cancelar. Pode opcionalmente fazer claim via `/auth/customers/claim`.

### Diferencial: chat de visagismo

Storefront em `/public/{slug}/ai/visagism/consultations` — cliente sobe foto multipart com consentimento LGPD, polling em `/public/ai/visagism/consultations/{id}`. Análise via AI SDK + Groq; geração opt-in via gpt-image-1. Cota mensal por tenant. Retenção LGPD: 7 dias (cron de cleanup). Provider abstraído pra troca futura.

### Modelo de negócio

Plano único Mercado Pago, trial 14 dias. **Sem webhook MP** (decisão arquitetural): polling on-demand via `/admin/billing/sync` + cron de sync + cron diário pra trial. Gating: tenant `cancelled` ou `suspended` → storefront `/public/*` retorna 404 (não vaza), `/admin/*` (exceto `/admin/billing`) retorna 402.

### Front pareado

`../kairobarber-web/` (irmão) é o front Next.js (App Router) que consome 100% destes endpoints.

---

## 2. Source of truth: os specs

Especificações, decisões arquiteturais, escopo por fase, modelo de dados conceitual e tratamento de erros ficam em [`docs/superpowers/specs/`](docs/superpowers/specs/). Planos executáveis em [`docs/superpowers/plans/`](docs/superpowers/plans/).

Cada spec é **load-bearing** entre sessões — leia inteiro antes de qualquer ação que toque a área coberta por ele.

---

## 3. Protocolo obrigatório antes de qualquer mudança

### 3.1 Spec primeiro

Antes de codar qualquer mudança não trivial:

1. **Ler do spec relevante:** seção pertinente + decisões arquiteturais relacionadas.
2. **Se a mudança contradiz o spec:** PARE. Atualize o spec primeiro (decisão registrada), depois implemente.
3. **Se a mudança estende o spec:** OK; abra plano via `superpowers:writing-plans` antes de codar mais que 50 linhas.

### 3.2 Skills do superpowers (use sempre que couber)

- `superpowers:brainstorming` — antes de **qualquer** mudança criativa (feature nova, refactor com decisão de design).
- `superpowers:writing-plans` — antes de codar mudança não-trivial.
- `superpowers:executing-plans` — ao executar plano em sessão separada (com checkpoints).
- `superpowers:test-driven-development` — ao implementar feature/bugfix.
- `superpowers:systematic-debugging` — em todo bug, falha de teste, comportamento inesperado.
- `superpowers:verification-before-completion` — antes de declarar "pronto", commit, ou PR.
- `superpowers:receiving-code-review` — ao receber feedback.

### 3.3 Context7 MCP — quando **incerto** sobre lib/API

Use `mcp__plugin_context7_context7__resolve-library-id` + `query-docs` **ANTES** de codar quando:

- Não tem certeza da sintaxe atual de uma API (NestJS, Prisma, BullMQ, AI SDK, AWS SDK)
- Vai usar feature que sabe que mudou recentemente
- Migração de versão
- Hooks/APIs de libs externas (zod, luxon)

**Não chute.** Treino tem cutoff; libs mudam toda semana. Bibliotecas usadas em produção aqui: NestJS, Prisma, BullMQ, AI SDK (Vercel ai + @ai-sdk/groq + @ai-sdk/openai), @aws-sdk/client-s3, argon2, helmet, nestjs-pino, ioredis, joi, luxon, resend, zod.

### 3.4 Não desvie sem registrar

Se uma decisão arquitetural do spec parece errada hoje:
1. Pare antes de implementar diferente.
2. Atualize o spec (decisão + razão).
3. Depois implemente.

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
| IA visagismo | AI SDK + Groq (análise) + OpenAI (gpt-image-1 opt-in) |
| Datas | luxon |
| Validação | zod + class-validator |
| Logger | nestjs-pino (structured) |
| Monitoring | Sentry (opcional via `SENTRY_DSN`) |
| Deploy | Railway, branch `main` → CI verde → auto |

Multi-tenancy: shared DB + coluna `tenantId`. Tenant isolation via TenantGuard + Prisma middleware (impossível esquecer).

Troca exige nova linha no Decision log do spec.

---

## 5. Comandos comuns

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

## 6. Onde achar respostas

| Dúvida | Onde |
|---|---|
| "Como funciona feature X?" | Spec relevante + código do módulo em `src/modules/<feature>/` |
| "Pode usar lib Y?" | Spec § Invariants/Decisões — stack travada |
| "Por que escolhemos Z?" | Spec § Decision log + commit history |
| "Qual o estado do projeto?" | README.md + estado atual do código |
| "Sintaxe atual de lib X?" | **Context7 MCP** (resolve-library-id + query-docs) |
| "Como o front consome essa API?" | Spec do front em `../kairobarber-web/docs/superpowers/specs/` |
| "QA / test plan" | `docs/qa/*.md` |
| "Mudança nova?" | `superpowers:brainstorming` → atualiza/escreve spec → `writing-plans` |
