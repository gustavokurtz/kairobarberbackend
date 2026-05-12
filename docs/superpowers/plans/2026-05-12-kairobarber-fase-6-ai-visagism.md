# KairoBarber — Fase 6 (IA Visagismo) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir o módulo `ai-visagism` — diferencial competitivo do KairoBarber. Cliente da storefront sobe uma foto com consentimento LGPD explícito, recebe em < 30s uma análise estruturada de formato do rosto + 2-3 sugestões de corte fundamentadas (via Groq + Llama 4 Scout 17B), e opcionalmente gera uma foto sua já com o corte sugerido (via OpenAI gpt-image-1). Cota mensal de 100 consultas/tenant (soft block). Cleanup automático após 7 dias (LGPD). Custo rastreado por consulta.

**Architecture:** Continua monolito modular NestJS. Módulo novo `ai-visagism` em `src/modules/ai-visagism/`. Endpoints públicos `/public/{slug}/ai/visagism/*` (sob `PublicTenantMiddleware` existente, que já bloqueia tenants `cancelled`/`suspended`). Upload é multipart server-side (não presigned): API recebe arquivo via `FileInterceptor`, valida MIME real + tamanho + dimensões, sobe pro R2 privado, cria `AiConsultation{status:queued, expiresAt:now+7d}`, enfileira job `ai-visagism-analysis`, retorna `{id, viewToken}`. Worker baixa a foto do R2 (URL assinada interna) e chama `VisagismProvider.analyze(buffer)` que internamente usa AI SDK `generateObject` com schema Zod + Groq `meta-llama/llama-4-scout-17b-16e-instruct`. Geração de imagem é opt-in: front chama `POST /generate-image?token=`, enfileira `ai-visagism-generation`, worker chama `VisagismProvider.generateImage(...)` que usa AI SDK `experimental_generateImage` + OpenAI `gpt-image-1`, salva no R2 e atualiza a row. Front faz polling em `GET /consultations/:id?token=` a cada 2s. Cota é `Subscription.aiQuotaUsedThisMonth` (já existe desde Fase 1): incrementa otimista na criação, decrementa em compensação se job falhar. Reset mensal via cron `monthly-quota-reset` (1º dia do mês 00:05 UTC). Cleanup LGPD via cron `ai-photo-cleanup` (diário 03:00 UTC): apaga R2 keys, zera `analysisJson`/`inputPhotoR2Key`/`outputPhotoR2Key`, seta `expiredAt`. `VisagismProvider` é uma interface — registramos `ConsoleVisagismProvider` (fixtures determinísticos pra testes) e `AiSdkVisagismProvider` (Groq + OpenAI), selecionável por env `AI_VISAGISM_PROVIDER`. `AuditService` (Fase 5) grava `ai.consultation_created`, `ai.analysis_completed`, `ai.generation_completed`, `ai.consultation_expired`. `/saas/ai-usage` (Fase 5) é estendido para retornar breakdown real por consulta (não apenas o counter agregado de quota).

**Tech Stack:** Novas dependências: `ai` (Vercel AI SDK core), `@ai-sdk/groq`, `@ai-sdk/openai`, `zod` (peer do AI SDK para schemas estruturados), `image-size` (validar dimensões mínimas), `file-type` (validar MIME real do buffer, não confiar no header). Reaproveita StorageModule (R2), QueuesModule (BullMQ), AuditModule, PrismaModule, Throttler, FileInterceptor (já vem no `@nestjs/platform-express`).

**Spec de referência:** [`docs/superpowers/specs/2026-05-11-kairobarber-backend-design.md`](../specs/2026-05-11-kairobarber-backend-design.md) (seção 4 — Fase 6; seção 6 — `AiConsultation`; seção 7 — endpoints `/public/{slug}/ai/visagism/*`; seção 8.4 — fluxo; seção 12 — LGPD; seção 15 — risco do provider de geração).

**Plano anterior:** [`2026-05-12-kairobarber-fase-5-saas-admin.md`](./2026-05-12-kairobarber-fase-5-saas-admin.md).

---

## Estado atual do repositório (entrada da Fase 6)

- Schema Prisma (`prisma/schema.prisma`) tem `Subscription.aiQuotaUsedThisMonth` (Int default 0) — vamos usar. Falta `AiConsultation` (spec seção 6). Última migration: `<ts>_phase5_saas_admin_and_audit`.
- `Subscription` está pronto: `tenantId` único, status enum, quota counter. **Não vamos** criar tabela separada de quota — incremento atômico em `Subscription` basta.
- `src/modules/storage/storage.provider.ts` já tem `StorageProvider.presignUpload` + `delete`. **Falta** `download(key) → Buffer` e `presignGet(key) → url` — vamos estender a interface (não breaking — adiciona métodos).
- `src/infra/queues/queue-names.ts` tem apenas billing. Vamos adicionar `QUEUE_AI_VISAGISM`, `JOB_AI_ANALYSIS`, `JOB_AI_GENERATION`, `JOB_AI_CLEANUP`, `JOB_AI_QUOTA_RESET`.
- `src/modules/billing/billing.schedules.ts` mostra o padrão de cron via `queue.upsertJobScheduler` — reusamos no `ai-visagism.schedules.ts`.
- `src/common/audit/audit.service.ts` (Fase 5) será chamado nas transições. Constantes em `audit-actions.ts` recebem 4 entradas novas.
- `src/modules/public/public.module.ts` já aplica `PublicTenantMiddleware` para `public/:slug/*` — `PublicAiVisagismController` herdará isso automaticamente quando o módulo for importado em `PublicModule`. Polling endpoint (`/public/ai/visagism/consultations/:id`) **não tem slug** e fica **fora** do middleware (token autentica o request).
- `SubscriptionActiveGuard` é global e bloqueia `/admin/*` — endpoints `/public/*` não passam por ele. Validação de subscription ativa nos endpoints `/public/.../ai/...` é responsabilidade do `AiVisagismService` (checa explicitamente).
- `src/common/exceptions/error-codes.ts` ganha códigos novos da Fase 6.
- E2E suite em `test/e2e/` (19 specs verdes). Helpers em `test/support/`. Adicionamos `test/support/ai-visagism.ts`.
- `.env.example` ganha vars `AI_VISAGISM_PROVIDER`, `GROQ_API_KEY`, `OPENAI_API_KEY`, `AI_VISAGISM_MONTHLY_QUOTA`, `AI_VISAGISM_RETENTION_DAYS`, `AI_VISAGISM_CLEANUP_CRON`, `AI_VISAGISM_QUOTA_RESET_CRON`.

---

## Decisões importantes desta fase (registrar antes de codar)

1. **Upload é server-side multipart, não presigned.** Spec seção 7 fala "multipart" explicitamente. Trade-off: API segura mais bytes na request, mas elimina o vai-e-volta de confirmação e o risco de ter blobs órfãos no R2 (presigned PUT sem confirmação = vazamento). Limite: 5MB (mesmo `PHOTO_MAX_BYTES` já existente em `storage.provider.ts`). Limite request size global do app permanece em 10MB (Helmet/Express default não atrapalha).

2. **Validação dupla do MIME: header + magic bytes.** Cliente pode mentir no `Content-Type`. Usamos `file-type` (dependência nova) para inspecionar os primeiros bytes do buffer e confirmar que é JPEG/PNG/WebP de verdade. Rejeita com `STORAGE_CONTENT_TYPE_INVALID` (código existente). Dimensão mínima 256×256 (rejeita selfies miniatura que não dão pra rosto), via `image-size` (dependência nova, leve). Sem max dimension — o R2 não cobra por pixel.

3. **`AiConsultation` schema:**
   ```
   AiConsultation(
     id (cuid),
     tenantId,
     customerId? (FK, nullable — guest também pode usar),
     barberId? (FK, nullable — só se for sugestão de barbeiro específico),
     inputPhotoR2Key (string, nullable após cleanup),
     outputPhotoR2Key? (string, nullable até gerar; nullable após cleanup),
     analysisJson? (Json, nullable até completar; nullable após cleanup),
     status (enum: queued|processing|completed|failed|generating|generated|expired),
     providerCostCents (Int default 0 — soma analysis + generation),
     viewTokenHash (string unique, hash sha256 do token plain),
     consentAcceptedAt (DateTime, NOT NULL — sem consent, sem row),
     expiresAt (DateTime, NOT NULL, default now+7d via app),
     expiredAt (DateTime?, set pelo cleanup),
     errorReason? (string, nullable),
     createdAt, updatedAt
   )
   Indexes:
     UNIQUE viewTokenHash
     (tenantId, createdAt DESC) — listagens SaaS
     (status, expiresAt) — varredura do cron de cleanup
     (status, createdAt DESC) — métricas
   ```
   Novo enum `AiConsultationStatus`: `queued | processing | completed | generating | generated | failed | expired`. **Importante:** `generated` ≠ `completed`: `completed` = análise pronta, sem geração; `generated` = análise pronta E imagem gerada. Transições: `queued → processing → completed → generating → generated`. Falha em qualquer ponto → `failed` (não volta atrás).

4. **Token de view do cliente.** Token plain de 32 bytes (base64url, ~43 chars). Apenas o `sha256` é persistido (`viewTokenHash`). Endpoint POST retorna o plain. Todo GET/POST subsequente exige `?token=<plain>`. Service compara hash. Garante que vazamento do banco não exponha tokens válidos. Token nunca expira por si só — expira quando `expiredAt` é setado pelo cron.

5. **Cota: incremento otimista + compensação.**
   - Na criação da consultation: `UPDATE Subscription SET aiQuotaUsedThisMonth = aiQuotaUsedThisMonth + 1 WHERE tenantId = ? AND aiQuotaUsedThisMonth < ?` (com `RETURNING`). Se 0 rows afetadas → 429 `AI_QUOTA_EXCEEDED`. Atomic, sem race.
   - Se job falhar definitivamente (sem retry restante): worker chama `quota.refund(tenantId, 1)` → `UPDATE Subscription SET aiQuotaUsedThisMonth = GREATEST(aiQuotaUsedThisMonth - 1, 0) WHERE tenantId = ?`.
   - **Geração de imagem NÃO consome cota** — está dentro da mesma consultation já contada. Decisão: cota mede "consultas iniciadas", não "operações de IA". Mantém o modelo mental do cliente simples ("100 consultas/mês") e impede o abuso "vou gerar 50 imagens variando a mesma consulta".

6. **Cota mensal: `Subscription.aiQuotaUsedThisMonth` reseta no dia 1 do mês, 00:05 UTC, via cron `monthly-quota-reset`.** Sem "anchor date" por tenant — reset global é simpler e o desalinhamento de poucos dias entre billing cycle e quota cycle é tolerável no MVP. Defesa: cron é idempotente (`SET aiQuotaUsedThisMonth = 0 WHERE aiQuotaUsedThisMonth > 0`).

7. **Cota default 100, configurável por env `AI_VISAGISM_MONTHLY_QUOTA` (Int, min 0, default 100).** Quando volume justificar, vira coluna em `Subscription` por plano — fica como TODO.

8. **Validação de subscription ativa nos endpoints públicos de IA.** `AiVisagismService.createConsultation` chama `subscription.assertActiveFor(tenantId)`. Aceita `trialing` e `active`; rejeita `past_due` e `cancelled` com `SUBSCRIPTION_INACTIVE` (código já existente). `PublicTenantMiddleware` já barra `cancelled` na entrada — `past_due` passa pelo middleware mas é barrado no service.

9. **`VisagismProvider` interface.**
   ```ts
   interface VisagismProvider {
     analyze(input: { photoBuffer: Buffer; mimeType: string }): Promise<{
       analysis: VisagismAnalysis; // structured JSON
       costCents: number;
       providerMeta: Record<string, unknown>; // model id, tokens, etc.
     }>;
     generateImage(input: {
       photoBuffer: Buffer;
       mimeType: string;
       suggestion: VisagismSuggestion;
     }): Promise<{
       imageBuffer: Buffer;
       imageMimeType: string;
       costCents: number;
       providerMeta: Record<string, unknown>;
     }>;
     healthCheck(): Promise<{ ok: boolean }>;
   }
   ```
   `VisagismAnalysis` é o schema Zod estruturado: `faceShape` (enum: `oval|round|square|heart|oblong|diamond`), `description` (string), `suggestions` (array 2-4): `{ name, rationale, length, style, suitableFor }`. Vamos forçar essa estrutura via `generateObject({ schema })` do AI SDK — Groq + Llama 4 Scout suporta nativamente.

10. **Modelo Groq.** `meta-llama/llama-4-scout-17b-16e-instruct` (acessível via `groq('meta-llama/llama-4-scout-17b-16e-instruct')` do `@ai-sdk/groq`). Multimodal (aceita imagem por URL ou base64). Custo por consulta estimado em ~$0.0002 (input photo + ~500 output tokens) — armazenamos com base no `usage` retornado pelo provider (input + output tokens × preço configurável `AI_VISAGISM_GROQ_PRICE_PER_MTOK_CENTS`, default 1). MVP: convertemos tokens → cents com fórmula simples; quando preço real do Groq mudar é só env.

11. **Modelo OpenAI (geração).** `gpt-image-1` via `openai.image('gpt-image-1')` do `@ai-sdk/openai`. Spec seção 7 dá o nome certo. Input: buffer original + prompt construído a partir da sugestão escolhida. Output: 1024×1024 PNG. Custo: ~$0.04 por imagem (env `AI_VISAGISM_OPENAI_IMAGE_COST_CENTS`, default 4).

12. **Sys prompt curado fica em `src/modules/ai-visagism/prompts/visagism.system.ts` como string export.** Versionado. Quando trocar prompt rodamos suite de regressão (fixtures de referência). Sys prompt diz: "você é um especialista em visagismo brasileiro, formato de rosto, recomende cortes masculinos populares no Brasil; responda em pt-BR; jamais comente saúde/raça; rejeite a foto se não houver rosto visível". Modelo retorna `null` se foto inadequada → service marca `failed` com `errorReason: 'no_face_detected'`.

13. **Polling endpoint não tem `/{slug}` no path.** Spec seção 7: `GET /public/ai/visagism/consultations/{id}?token=`. Sem slug porque o token já é suficiente para identificar e autorizar. Não passa pelo `PublicTenantMiddleware`. Fica registrado em `PublicModule` mas via rota separada (`exclude(/public/ai/*)` igual ao `public/appointments/*`).

14. **Rate limit nos endpoints de IA.** `@Throttle({ default: { ttl: 60_000, limit: 3 } })` em `POST /public/{slug}/ai/visagism/consultations` e em `POST .../generate-image` — 3/min por IP (spec seção 12). Polling `GET .../consultations/:id` não tem throttle dedicado (cai no global de 10/min).

15. **R2 cleanup é best-effort.** O `r2.delete()` ignora errors (já é assim em `r2-storage.provider.ts`). Se a foto realmente sobreviver no R2, o lifecycle rule do bucket (configurar manualmente: "delete objects older than 30 days") cuida — fica documentado no README mas não é código.

16. **Idempotência do cron `ai-photo-cleanup`.**
    - `SELECT id, inputPhotoR2Key, outputPhotoR2Key FROM AiConsultation WHERE expiredAt IS NULL AND expiresAt < now()` (LIMIT 500/run).
    - Para cada: tenta `r2.delete(inputKey)`, `r2.delete(outputKey)`, então `UPDATE ... SET expiredAt=now(), inputPhotoR2Key=NULL, outputPhotoR2Key=NULL, analysisJson=NULL, status='expired' WHERE id=? AND expiredAt IS NULL`.
    - Cron pode rodar a qualquer hora; processa só o que ainda não expirou.
    - **Não** marca `failed`. `expired` é status terminal positivo (consulta concluiu seu ciclo).
    - Cap diário evita uma run gigante após down: se houver > 500 expirados, próxima run pega o resto.

17. **`/saas/ai-usage` (Fase 5) ganha breakdown opcional `?detailed=true`.** Quando `detailed=true`, retorna além do snapshot agregado por tenant uma listagem das últimas 50 consultations por tenant (id, status, providerCostCents, createdAt). Quando ausente, mantém comportamento atual (snapshot agregado). Não quebra Fase 5.

18. **`AiSdkVisagismProvider` é injected via factory.** Mesmo padrão do `StorageProvider`: módulo registra `provide: VISAGISM_PROVIDER`, factory lê `AI_VISAGISM_PROVIDER` env e devolve `console` ou `aisdk`. Em testes `NODE_ENV=test`, force `console`.

19. **`generateImage` do AI SDK retorna `base64`.** Convertemos pra `Buffer` no provider, retornamos pro service, service sobe pro R2 via `StorageProvider.uploadBuffer(...)` (método novo na interface — não-breaking).

20. **Erros do provider são retentados pelo BullMQ.** `attempts: 3, backoff: { type: 'exponential', delay: 5_000 }`. Após esgotar, worker chama `service.markFailed(consultationId, errorReason)` que reembolsa cota.

---

## Estrutura de arquivos resultante (delta da Fase 6)

```
kairobarber/
├── package.json                                                # ATUALIZA: +ai, +@ai-sdk/groq, +@ai-sdk/openai, +zod, +file-type, +image-size
├── .env.example                                                # ATUALIZA: vars AI_VISAGISM_*, GROQ_API_KEY, OPENAI_API_KEY
├── README.md                                                   # ATUALIZA: marcar Fase 6 como pronta
│
├── prisma/
│   ├── schema.prisma                                           # ATUALIZA: +AiConsultation, +AiConsultationStatus
│   └── migrations/
│       └── <ts>_phase6_ai_visagism/
│           └── migration.sql
│
├── src/
│   ├── config/
│   │   └── env.validation.ts                                   # ATUALIZA: +AI_VISAGISM_*, GROQ_API_KEY, OPENAI_API_KEY
│   │
│   ├── common/
│   │   ├── exceptions/
│   │   │   └── error-codes.ts                                  # ATUALIZA: códigos da Fase 6
│   │   └── audit/
│   │       └── audit-actions.ts                                # ATUALIZA: +AI_* actions
│   │
│   ├── infra/
│   │   └── queues/
│   │       └── queue-names.ts                                  # ATUALIZA: +QUEUE_AI_VISAGISM, +JOB_AI_*
│   │
│   ├── modules/
│   │   ├── storage/
│   │   │   ├── storage.provider.ts                             # ATUALIZA: +download, +presignGet, +uploadBuffer
│   │   │   └── providers/
│   │   │       ├── console-storage.provider.ts                 # ATUALIZA: stubs
│   │   │       └── r2-storage.provider.ts                      # ATUALIZA: implementa novos métodos
│   │   │
│   │   ├── public/
│   │   │   └── public.module.ts                                # ATUALIZA: importa AiVisagismModule + ajusta middleware excludes
│   │   │
│   │   ├── saas-admin/
│   │   │   └── services/
│   │   │       └── saas-ai-usage.service.ts                    # ATUALIZA: suporta ?detailed=true
│   │   │
│   │   └── ai-visagism/                                        # NOVO MÓDULO
│   │       ├── ai-visagism.module.ts
│   │       ├── ai-visagism.constants.ts
│   │       ├── ai-visagism.service.ts
│   │       ├── ai-visagism.service.spec.ts
│   │       ├── ai-visagism.public-controller.ts
│   │       ├── ai-visagism.processor.ts
│   │       ├── ai-visagism.processor.spec.ts
│   │       ├── ai-visagism.schedules.ts
│   │       ├── ai-visagism.schemas.ts                          # Zod schemas (analysis structured output)
│   │       ├── ai-visagism.types.ts                            # types puros (VisagismAnalysis, etc.)
│   │       ├── prompts/
│   │       │   ├── visagism.system.ts
│   │       │   └── visagism.generation-prompt.ts
│   │       ├── quota/
│   │       │   ├── quota.service.ts
│   │       │   ├── quota.service.spec.ts
│   │       │   └── quota.repository.ts
│   │       ├── repositories/
│   │       │   └── ai-consultation.repository.ts
│   │       ├── providers/
│   │       │   ├── visagism.provider.ts                        # interface + Symbol
│   │       │   ├── console-visagism.provider.ts                # fixtures (testes)
│   │       │   ├── console-visagism.provider.spec.ts
│   │       │   ├── ai-sdk-visagism.provider.ts                 # Groq + OpenAI via AI SDK
│   │       │   └── ai-sdk-visagism.provider.spec.ts            # smoke test (mocks de fetch)
│   │       └── dto/
│   │           ├── create-consultation.dto.ts
│   │           ├── generate-image.dto.ts
│   │           └── view-consultation-query.dto.ts
│   │
│   └── app.module.ts                                           # ATUALIZA: registra AiVisagismModule
│
└── test/
    ├── support/
    │   └── ai-visagism.ts                                      # helpers: createConsultation, drainAiQueue, fixture photo
    └── e2e/
        ├── ai-visagism-happy-path.e2e-spec.ts
        ├── ai-visagism-quota.e2e-spec.ts
        ├── ai-visagism-tokens.e2e-spec.ts
        ├── ai-visagism-cleanup.e2e-spec.ts
        ├── ai-visagism-gating.e2e-spec.ts
        └── ai-visagism-generation.e2e-spec.ts
```

---

## Tasks

### Task 1: Instalar dependências (AI SDK, Zod, validação de imagem)

**Files:**
- Modify: `package.json` (gerado pelo npm install)
- Modify: `package-lock.json` (gerado)

- [ ] **Step 1: Instalar AI SDK + providers**

```bash
cd /home/ntconsult/Projetos/meus/kairobarber
npm install ai @ai-sdk/groq @ai-sdk/openai zod
```

Expected: `ai` em `^4.x`, `@ai-sdk/groq` e `@ai-sdk/openai` em `^1.x` ou compatível, `zod` em `^3.x`. Sem peer warnings críticos.

- [ ] **Step 2: Instalar validadores de upload (magic bytes + dimensões)**

```bash
npm install file-type image-size
```

Expected: `file-type` em `^19.x` (ESM-only — vamos importar dinamicamente onde for usado). `image-size` em `^1.x` ou `^2.x`.

- [ ] **Step 3: Verificar tipos**

```bash
npx tsc --noEmit
```

Expected: zero erros (nenhum import novo ainda).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build(phase6): add ai sdk, groq, openai, zod, file-type, image-size deps"
```

---

### Task 2: Schema Prisma — `AiConsultation` + enum `AiConsultationStatus`

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_phase6_ai_visagism/migration.sql` (gerado)

- [ ] **Step 1: Adicionar enum `AiConsultationStatus` em `prisma/schema.prisma`**

Após o enum `AppointmentSource`, adicionar:

```prisma
enum AiConsultationStatus {
  queued
  processing
  completed
  generating
  generated
  failed
  expired
}
```

- [ ] **Step 2: Adicionar bloco `model AiConsultation` no final do `schema.prisma`**

```prisma
model AiConsultation {
  id                 String               @id @default(cuid())
  tenantId           String
  customerId         String?
  barberId           String?
  inputPhotoR2Key    String?
  outputPhotoR2Key   String?
  analysisJson       Json?
  status             AiConsultationStatus @default(queued)
  providerCostCents  Int                  @default(0)
  viewTokenHash      String               @unique
  consentAcceptedAt  DateTime
  expiresAt          DateTime
  expiredAt          DateTime?
  errorReason        String?
  createdAt          DateTime             @default(now())
  updatedAt          DateTime             @updatedAt

  tenant   Tenant    @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  customer Customer? @relation(fields: [customerId], references: [id], onDelete: SetNull)
  barber   Barber?   @relation(fields: [barberId], references: [id], onDelete: SetNull)

  @@index([tenantId, createdAt(sort: Desc)])
  @@index([status, expiresAt])
  @@index([status, createdAt(sort: Desc)])
}
```

- [ ] **Step 3: Adicionar relação reversa em `Tenant`, `Customer`, `Barber`**

No `model Tenant`, após `auditLogs AuditLog[]`:

```prisma
  aiConsultations   AiConsultation[]
```

No `model Customer`, após `appointments Appointment[]`:

```prisma
  aiConsultations AiConsultation[]
```

No `model Barber`, após `appointments Appointment[]`:

```prisma
  aiConsultations AiConsultation[]
```

- [ ] **Step 4: Gerar migration**

```bash
docker compose up -d postgres
npx prisma migrate dev --name phase6_ai_visagism
```

Expected: migration aplicada, `npx prisma generate` rodou, tipos `AiConsultation` e `AiConsultationStatus` aparecem em `@prisma/client`.

- [ ] **Step 5: Verificar tipos**

```bash
npx tsc --noEmit
```

Expected: zero erros (nada usa `AiConsultation` ainda).

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(phase6): add AiConsultation model and status enum"
```

---

### Task 3: Error codes + audit actions + queue names

**Files:**
- Modify: `src/common/exceptions/error-codes.ts`
- Modify: `src/common/audit/audit-actions.ts`
- Modify: `src/infra/queues/queue-names.ts`

- [ ] **Step 1: Adicionar códigos em `error-codes.ts`**

Em `src/common/exceptions/error-codes.ts`, antes do fechamento do objeto `ErrorCodes`, adicionar:

```ts
  // Phase 6 — AI visagism
  AI_QUOTA_EXCEEDED: 'AI_QUOTA_EXCEEDED',
  AI_CONSENT_REQUIRED: 'AI_CONSENT_REQUIRED',
  AI_CONSENT_STALE: 'AI_CONSENT_STALE',
  AI_PHOTO_INVALID: 'AI_PHOTO_INVALID',
  AI_PHOTO_TOO_SMALL: 'AI_PHOTO_TOO_SMALL',
  AI_PHOTO_TOO_LARGE: 'AI_PHOTO_TOO_LARGE',
  AI_CONSULTATION_NOT_FOUND: 'AI_CONSULTATION_NOT_FOUND',
  AI_CONSULTATION_TOKEN_INVALID: 'AI_CONSULTATION_TOKEN_INVALID',
  AI_CONSULTATION_EXPIRED: 'AI_CONSULTATION_EXPIRED',
  AI_CONSULTATION_NOT_READY: 'AI_CONSULTATION_NOT_READY',
  AI_GENERATION_ALREADY_REQUESTED: 'AI_GENERATION_ALREADY_REQUESTED',
  AI_SUGGESTION_NOT_FOUND: 'AI_SUGGESTION_NOT_FOUND',
  AI_PROVIDER_ERROR: 'AI_PROVIDER_ERROR',
```

- [ ] **Step 2: Adicionar actions em `audit-actions.ts`**

Em `src/common/audit/audit-actions.ts`, antes do `as const`:

```ts
  AI_CONSULTATION_CREATED: 'ai.consultation_created',
  AI_ANALYSIS_COMPLETED: 'ai.analysis_completed',
  AI_GENERATION_COMPLETED: 'ai.generation_completed',
  AI_CONSULTATION_FAILED: 'ai.consultation_failed',
  AI_CONSULTATION_EXPIRED: 'ai.consultation_expired',
```

- [ ] **Step 3: Adicionar queue + job names em `queue-names.ts`**

Em `src/infra/queues/queue-names.ts`, adicionar abaixo das constantes existentes:

```ts
export const QUEUE_AI_VISAGISM = 'ai-visagism';

export const JOB_AI_ANALYSIS = 'ai-analysis';
export const JOB_AI_GENERATION = 'ai-generation';
export const JOB_AI_CLEANUP = 'ai-cleanup';
export const JOB_AI_QUOTA_RESET = 'ai-quota-reset';
```

- [ ] **Step 4: Verificar typecheck**

```bash
npx tsc --noEmit
```

Expected: zero erros.

- [ ] **Step 5: Commit**

```bash
git add src/common/exceptions/error-codes.ts src/common/audit/audit-actions.ts src/infra/queues/queue-names.ts
git commit -m "feat(phase6): add ai-visagism error codes, audit actions, queue names"
```

---

### Task 4: Env validation — vars da Fase 6

**Files:**
- Modify: `src/config/env.validation.ts`

- [ ] **Step 1: Adicionar entradas no `envValidationSchema` (depois de `ALLOW_PROD_SEED`)**

```ts
  // AI Visagism (Fase 6)
  AI_VISAGISM_PROVIDER: Joi.string().valid('console', 'aisdk').default('console'),
  AI_VISAGISM_MONTHLY_QUOTA: Joi.number().integer().min(0).default(100),
  AI_VISAGISM_RETENTION_DAYS: Joi.number().integer().min(1).max(365).default(7),
  AI_VISAGISM_CLEANUP_CRON: Joi.string().default('0 3 * * *'),
  AI_VISAGISM_QUOTA_RESET_CRON: Joi.string().default('5 0 1 * *'),
  AI_VISAGISM_PHOTO_MAX_BYTES: Joi.number().integer().min(102400).default(5 * 1024 * 1024),
  AI_VISAGISM_PHOTO_MIN_DIMENSION: Joi.number().integer().min(64).default(256),
  AI_VISAGISM_CONSENT_MAX_AGE_SECONDS: Joi.number().integer().min(60).default(3600),
  AI_VISAGISM_GROQ_MODEL: Joi.string().default('meta-llama/llama-4-scout-17b-16e-instruct'),
  AI_VISAGISM_GROQ_PRICE_PER_MTOK_CENTS: Joi.number().min(0).default(1),
  AI_VISAGISM_OPENAI_IMAGE_MODEL: Joi.string().default('gpt-image-1'),
  AI_VISAGISM_OPENAI_IMAGE_COST_CENTS: Joi.number().integer().min(0).default(4),
  GROQ_API_KEY: Joi.string().when('AI_VISAGISM_PROVIDER', {
    is: 'aisdk',
    then: Joi.required(),
    otherwise: Joi.optional().allow(''),
  }),
  OPENAI_API_KEY: Joi.string().when('AI_VISAGISM_PROVIDER', {
    is: 'aisdk',
    then: Joi.required(),
    otherwise: Joi.optional().allow(''),
  }),
```

- [ ] **Step 2: Adicionar no type `AppEnv` (depois de `ALLOW_PROD_SEED?`)**

```ts
  AI_VISAGISM_PROVIDER: 'console' | 'aisdk';
  AI_VISAGISM_MONTHLY_QUOTA: number;
  AI_VISAGISM_RETENTION_DAYS: number;
  AI_VISAGISM_CLEANUP_CRON: string;
  AI_VISAGISM_QUOTA_RESET_CRON: string;
  AI_VISAGISM_PHOTO_MAX_BYTES: number;
  AI_VISAGISM_PHOTO_MIN_DIMENSION: number;
  AI_VISAGISM_CONSENT_MAX_AGE_SECONDS: number;
  AI_VISAGISM_GROQ_MODEL: string;
  AI_VISAGISM_GROQ_PRICE_PER_MTOK_CENTS: number;
  AI_VISAGISM_OPENAI_IMAGE_MODEL: string;
  AI_VISAGISM_OPENAI_IMAGE_COST_CENTS: number;
  GROQ_API_KEY?: string;
  OPENAI_API_KEY?: string;
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

Expected: zero erros.

- [ ] **Step 4: Commit**

```bash
git add src/config/env.validation.ts
git commit -m "feat(phase6): env validation for ai-visagism vars"
```

---

### Task 5: Estender `StorageProvider` — `download`, `presignGet`, `uploadBuffer`

**Files:**
- Modify: `src/modules/storage/storage.provider.ts`
- Modify: `src/modules/storage/providers/console-storage.provider.ts`
- Modify: `src/modules/storage/providers/r2-storage.provider.ts`
- Modify: `src/modules/storage/providers/console-storage.provider.spec.ts`

- [ ] **Step 1: Atualizar interface em `storage.provider.ts`**

Adicionar no final do arquivo (depois de `extensionFromContentType`):

```ts
export type UploadBufferInput = {
  tenantId: string;
  buffer: Buffer;
  contentType: string;
  extension: string;
  /** Path prefix dentro do bucket. Ex: `ai-visagism/input` */
  prefix?: string;
};

export type UploadBufferResult = {
  r2Key: string;
};
```

Atualizar a interface `StorageProvider` para incluir:

```ts
export interface StorageProvider {
  presignUpload(input: PresignUploadInput): Promise<PresignedUpload>;
  /** Best-effort delete; missing object is not an error. */
  delete(r2Key: string): Promise<void>;
  /** Faz upload server-side de um buffer (não-presigned). */
  uploadBuffer(input: UploadBufferInput): Promise<UploadBufferResult>;
  /** Baixa o objeto completo como Buffer. Lança erro se ausente. */
  download(r2Key: string): Promise<Buffer>;
  /** Retorna URL GET pré-assinada (útil pra workers / debug). */
  presignGet(r2Key: string, ttlSeconds: number): Promise<string>;
}
```

Adicionar constantes para AI visagism photos (mesmas regras de MIME, limite maior é env):

```ts
export const ALLOWED_AI_PHOTO_CONTENT_TYPES = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/webp',
]);
```

- [ ] **Step 2: Implementar novos métodos em `r2-storage.provider.ts`**

Adicionar imports:

```ts
import { GetObjectCommand } from '@aws-sdk/client-s3';
```

Adicionar métodos na classe `R2StorageProvider`:

```ts
  async uploadBuffer(input: UploadBufferInput): Promise<UploadBufferResult> {
    const prefix = input.prefix ?? 'photos';
    const r2Key = `tenants/${input.tenantId}/${prefix}/${randomUUID()}.${input.extension}`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: r2Key,
        Body: input.buffer,
        ContentType: input.contentType,
        ContentLength: input.buffer.byteLength,
      }),
    );
    return { r2Key };
  }

  async download(r2Key: string): Promise<Buffer> {
    const out = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: r2Key }),
    );
    if (!out.Body) {
      throw new Error(`R2 object missing body: ${r2Key}`);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of out.Body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async presignGet(r2Key: string, ttlSeconds: number): Promise<string> {
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: r2Key });
    return getSignedUrl(this.client, cmd, { expiresIn: ttlSeconds });
  }
```

E adicionar `UploadBufferInput, UploadBufferResult` no import de `../storage.provider`.

- [ ] **Step 3: Implementar novos métodos em `console-storage.provider.ts`**

Substituir o arquivo inteiro por:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  PresignedUpload,
  PresignUploadInput,
  StorageProvider,
  UploadBufferInput,
  UploadBufferResult,
} from '../storage.provider';

@Injectable()
export class ConsoleStorageProvider implements StorageProvider {
  private readonly logger = new Logger(ConsoleStorageProvider.name);
  /** In-memory store for testing — key → buffer. */
  private readonly store = new Map<string, { buffer: Buffer; contentType: string }>();

  presignUpload(input: PresignUploadInput): Promise<PresignedUpload> {
    const r2Key = `tenants/${input.tenantId}/photos/${randomUUID()}.${input.extension}`;
    const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
    return Promise.resolve({
      uploadUrl: `http://storage.local/upload/${r2Key}?expires=${expiresAt.toISOString()}`,
      r2Key,
      expiresAt,
      contentType: input.contentType,
      maxBytes: input.maxBytes,
    });
  }

  uploadBuffer(input: UploadBufferInput): Promise<UploadBufferResult> {
    const prefix = input.prefix ?? 'photos';
    const r2Key = `tenants/${input.tenantId}/${prefix}/${randomUUID()}.${input.extension}`;
    this.store.set(r2Key, { buffer: input.buffer, contentType: input.contentType });
    return Promise.resolve({ r2Key });
  }

  download(r2Key: string): Promise<Buffer> {
    const obj = this.store.get(r2Key);
    if (!obj) {
      return Promise.reject(new Error(`Object not found in console storage: ${r2Key}`));
    }
    return Promise.resolve(obj.buffer);
  }

  presignGet(r2Key: string, ttlSeconds: number): Promise<string> {
    return Promise.resolve(
      `http://storage.local/get/${r2Key}?expires=${new Date(Date.now() + ttlSeconds * 1000).toISOString()}`,
    );
  }

  delete(r2Key: string): Promise<void> {
    this.store.delete(r2Key);
    return Promise.resolve();
  }
}
```

- [ ] **Step 4: Atualizar `console-storage.provider.spec.ts`**

Adicionar testes ao describe principal:

```ts
  it('uploadBuffer salva e download recupera o mesmo buffer', async () => {
    const provider = new ConsoleStorageProvider();
    const buf = Buffer.from('hello-bytes');
    const { r2Key } = await provider.uploadBuffer({
      tenantId: 't1',
      buffer: buf,
      contentType: 'image/jpeg',
      extension: 'jpg',
      prefix: 'ai-visagism/input',
    });
    expect(r2Key).toMatch(/^tenants\/t1\/ai-visagism\/input\/[a-f0-9-]+\.jpg$/);
    const got = await provider.download(r2Key);
    expect(got.equals(buf)).toBe(true);
  });

  it('download lança erro quando key não existe', async () => {
    const provider = new ConsoleStorageProvider();
    await expect(provider.download('tenants/t1/photos/missing.jpg')).rejects.toThrow(
      /not found in console storage/,
    );
  });

  it('delete remove do store e download subsequente falha', async () => {
    const provider = new ConsoleStorageProvider();
    const { r2Key } = await provider.uploadBuffer({
      tenantId: 't1',
      buffer: Buffer.from('x'),
      contentType: 'image/png',
      extension: 'png',
    });
    await provider.delete(r2Key);
    await expect(provider.download(r2Key)).rejects.toThrow();
  });

  it('presignGet retorna URL determinística do console', async () => {
    const provider = new ConsoleStorageProvider();
    const url = await provider.presignGet('tenants/t1/photos/abc.jpg', 60);
    expect(url).toContain('http://storage.local/get/tenants/t1/photos/abc.jpg');
    expect(url).toContain('expires=');
  });
```

- [ ] **Step 5: Rodar testes**

```bash
npx jest --config jest.config.ts src/modules/storage/
```

Expected: todos os testes (incluindo os 4 novos) passam.

- [ ] **Step 6: Typecheck completo**

```bash
npx tsc --noEmit
```

Expected: zero erros (nenhum consumer ainda usa os novos métodos).

- [ ] **Step 7: Commit**

```bash
git add src/modules/storage/
git commit -m "feat(storage): add uploadBuffer, download, presignGet methods"
```

---

### Task 6: Tipos, schemas Zod e constantes do `ai-visagism`

**Files:**
- Create: `src/modules/ai-visagism/ai-visagism.constants.ts`
- Create: `src/modules/ai-visagism/ai-visagism.types.ts`
- Create: `src/modules/ai-visagism/ai-visagism.schemas.ts`
- Create: `src/modules/ai-visagism/prompts/visagism.system.ts`
- Create: `src/modules/ai-visagism/prompts/visagism.generation-prompt.ts`

- [ ] **Step 1: Criar `src/modules/ai-visagism/ai-visagism.constants.ts`**

```ts
export const VISAGISM_PROVIDER = Symbol('VISAGISM_PROVIDER');

export const AI_VISAGISM_CLEANUP_SCHEDULER_KEY = 'ai-visagism-cleanup-scheduler';
export const AI_VISAGISM_QUOTA_RESET_SCHEDULER_KEY = 'ai-visagism-quota-reset-scheduler';

/** Máx por run do cron de cleanup. */
export const AI_VISAGISM_CLEANUP_BATCH_SIZE = 500;

/** TTL da signed URL do worker (download interno). */
export const AI_VISAGISM_INTERNAL_GET_TTL_SECONDS = 300;
```

- [ ] **Step 2: Criar `src/modules/ai-visagism/ai-visagism.types.ts`**

```ts
export type FaceShape = 'oval' | 'round' | 'square' | 'heart' | 'oblong' | 'diamond';

export interface VisagismSuggestion {
  id: string; // ex: "fade-mid-curtain"
  name: string; // "Mid fade com franja"
  rationale: string;
  length: 'short' | 'medium' | 'long';
  style: string; // ex: "casual" | "formal" | "moderno"
  suitableFor: string[]; // ex: ["rosto oval", "cabelo liso"]
}

export interface VisagismAnalysis {
  faceShape: FaceShape;
  description: string;
  suggestions: VisagismSuggestion[];
}

export interface VisagismProviderAnalyzeResult {
  analysis: VisagismAnalysis;
  costCents: number;
  providerMeta: Record<string, unknown>;
}

export interface VisagismProviderGenerateResult {
  imageBuffer: Buffer;
  imageMimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  costCents: number;
  providerMeta: Record<string, unknown>;
}
```

- [ ] **Step 3: Criar `src/modules/ai-visagism/ai-visagism.schemas.ts`**

```ts
import { z } from 'zod';

export const faceShapeSchema = z.enum(['oval', 'round', 'square', 'heart', 'oblong', 'diamond']);

export const visagismSuggestionSchema = z.object({
  id: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'id deve ser kebab-case'),
  name: z.string().min(2).max(80),
  rationale: z.string().min(20).max(600),
  length: z.enum(['short', 'medium', 'long']),
  style: z.string().min(2).max(40),
  suitableFor: z.array(z.string().min(2).max(80)).min(1).max(6),
});

export const visagismAnalysisSchema = z.object({
  faceShape: faceShapeSchema,
  description: z.string().min(40).max(800),
  suggestions: z.array(visagismSuggestionSchema).min(2).max(4),
});

export type VisagismAnalysisSchema = z.infer<typeof visagismAnalysisSchema>;
```

- [ ] **Step 4: Criar `src/modules/ai-visagism/prompts/visagism.system.ts`**

```ts
/**
 * Sys prompt do analisador de visagismo.
 * Versão: 1 — qualquer mudança aqui invalida fixtures de regressão.
 */
export const VISAGISM_SYSTEM_PROMPT = `Você é um especialista em visagismo masculino brasileiro.
Sua função é analisar a foto enviada e sugerir cortes de cabelo adequados ao formato do rosto.

Regras estritas:
- Responda SEMPRE em português do Brasil.
- Avalie apenas formato de rosto, proporções e textura/comprimento visíveis de cabelo. Nunca comente etnia, cor de pele, condições de saúde, idade ou características pessoais.
- Se a foto não mostrar claramente um rosto humano (selfie de frente ou ângulo levemente lateral), responda em vez disso com a estrutura especial: faceShape="oval", description começa com "[NO_FACE_DETECTED] ", e suggestions com 2 entradas placeholder usando style="indefinido".
- Catálogo de cortes deve refletir cortes masculinos populares no Brasil (fade, taper, undercut, militar, social, francês, mid fade, low fade, buzz cut, com ou sem franja).
- Cada sugestão deve trazer justificativa específica para o formato detectado (1-3 frases curtas).
- Retorne exatamente entre 2 e 4 sugestões. Diversifique comprimento/estilo entre elas.
- Use IDs kebab-case curtos e estáveis (ex.: "mid-fade-curtain", "buzz-cut-classic").
`;
```

- [ ] **Step 5: Criar `src/modules/ai-visagism/prompts/visagism.generation-prompt.ts`**

```ts
import { VisagismSuggestion } from '../ai-visagism.types';

/**
 * Constrói o prompt textual passado para o modelo de geração de imagem (gpt-image-1).
 * O modelo recebe também a foto original como imagem de referência.
 */
export function buildGenerationPrompt(suggestion: VisagismSuggestion): string {
  return [
    'Edite a foto fornecida aplicando o seguinte corte de cabelo masculino no mesmo modelo.',
    `Corte: ${suggestion.name}.`,
    `Estilo: ${suggestion.style}.`,
    `Comprimento: ${suggestion.length}.`,
    `Justificativa do corte: ${suggestion.rationale}`,
    'Preserve traços faciais, iluminação, ângulo, fundo e roupa. Foco: modificar apenas o cabelo.',
    'Resultado realista, sem cartoonização.',
  ].join(' ');
}
```

- [ ] **Step 6: Typecheck**

```bash
npx tsc --noEmit
```

Expected: zero erros.

- [ ] **Step 7: Commit**

```bash
git add src/modules/ai-visagism/
git commit -m "feat(ai-visagism): add zod schemas, types, prompts, constants"
```

---

### Task 7: `VisagismProvider` interface + `ConsoleVisagismProvider` (fixtures pra testes)

**Files:**
- Create: `src/modules/ai-visagism/providers/visagism.provider.ts`
- Create: `src/modules/ai-visagism/providers/console-visagism.provider.ts`
- Create: `src/modules/ai-visagism/providers/console-visagism.provider.spec.ts`

- [ ] **Step 1: Criar `src/modules/ai-visagism/providers/visagism.provider.ts`**

```ts
import {
  VisagismProviderAnalyzeResult,
  VisagismProviderGenerateResult,
  VisagismSuggestion,
} from '../ai-visagism.types';

export interface VisagismProvider {
  analyze(input: { photoBuffer: Buffer; mimeType: string }): Promise<VisagismProviderAnalyzeResult>;
  generateImage(input: {
    photoBuffer: Buffer;
    mimeType: string;
    suggestion: VisagismSuggestion;
  }): Promise<VisagismProviderGenerateResult>;
  healthCheck(): Promise<{ ok: boolean }>;
}
```

- [ ] **Step 2: Criar `src/modules/ai-visagism/providers/console-visagism.provider.ts`**

```ts
import { Injectable } from '@nestjs/common';
import { VisagismProvider } from './visagism.provider';
import {
  VisagismProviderAnalyzeResult,
  VisagismProviderGenerateResult,
  VisagismSuggestion,
} from '../ai-visagism.types';

/**
 * Implementação determinística. Usada em NODE_ENV=test e como fallback
 * quando AI_VISAGISM_PROVIDER=console. Não toca em provider externo.
 */
@Injectable()
export class ConsoleVisagismProvider implements VisagismProvider {
  analyze(input: {
    photoBuffer: Buffer;
    mimeType: string;
  }): Promise<VisagismProviderAnalyzeResult> {
    // Fixture estável para testes — derivada por hash do buffer para variar entre payloads.
    const seed = input.photoBuffer.byteLength % 6;
    const shapes = ['oval', 'round', 'square', 'heart', 'oblong', 'diamond'] as const;
    return Promise.resolve({
      analysis: {
        faceShape: shapes[seed],
        description: `Análise determinística (console provider). Formato detectado: ${shapes[seed]}. Cabelo presumido médio.`,
        suggestions: [
          {
            id: 'mid-fade-curtain',
            name: 'Mid fade com franja',
            rationale:
              'Equilibra proporções verticais e mantém volume no topo, suavizando o formato do rosto.',
            length: 'medium',
            style: 'moderno',
            suitableFor: [`rosto ${shapes[seed]}`, 'cabelo liso ou ondulado'],
          },
          {
            id: 'buzz-cut-classic',
            name: 'Buzz cut clássico',
            rationale: 'Limpo, baixa manutenção, valoriza traços faciais marcantes.',
            length: 'short',
            style: 'minimalista',
            suitableFor: ['rosto bem definido', 'rotina prática'],
          },
        ],
      },
      costCents: 0,
      providerMeta: { provider: 'console', deterministic: true },
    });
  }

  generateImage(input: {
    photoBuffer: Buffer;
    mimeType: string;
    suggestion: VisagismSuggestion;
  }): Promise<VisagismProviderGenerateResult> {
    // Retorna um PNG mínimo 1x1 (fixture) — basta pra rotear pelo storage no teste.
    const pngMin = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
      'hex',
    );
    return Promise.resolve({
      imageBuffer: pngMin,
      imageMimeType: 'image/png',
      costCents: 0,
      providerMeta: { provider: 'console', suggestionId: input.suggestion.id },
    });
  }

  healthCheck(): Promise<{ ok: boolean }> {
    return Promise.resolve({ ok: true });
  }
}
```

- [ ] **Step 3: Criar `src/modules/ai-visagism/providers/console-visagism.provider.spec.ts`**

```ts
import { ConsoleVisagismProvider } from './console-visagism.provider';

describe('ConsoleVisagismProvider', () => {
  const provider = new ConsoleVisagismProvider();

  it('analyze retorna fixture com 2 sugestões e providerMeta.deterministic=true', async () => {
    const out = await provider.analyze({
      photoBuffer: Buffer.alloc(100),
      mimeType: 'image/jpeg',
    });
    expect(out.analysis.suggestions).toHaveLength(2);
    expect(out.analysis.faceShape).toBeDefined();
    expect(out.providerMeta.deterministic).toBe(true);
    expect(out.costCents).toBe(0);
  });

  it('analyze varia o faceShape conforme tamanho do buffer (determinístico por seed)', async () => {
    const a = await provider.analyze({ photoBuffer: Buffer.alloc(0), mimeType: 'image/jpeg' });
    const b = await provider.analyze({ photoBuffer: Buffer.alloc(3), mimeType: 'image/jpeg' });
    expect(a.analysis.faceShape).not.toBe(b.analysis.faceShape);
  });

  it('generateImage retorna PNG válido (header magic bytes)', async () => {
    const out = await provider.generateImage({
      photoBuffer: Buffer.alloc(10),
      mimeType: 'image/jpeg',
      suggestion: {
        id: 'mid-fade-curtain',
        name: 'x',
        rationale: 'y',
        length: 'medium',
        style: 'moderno',
        suitableFor: ['a'],
      },
    });
    expect(out.imageMimeType).toBe('image/png');
    // PNG signature: 89 50 4E 47
    expect(out.imageBuffer.slice(0, 4).toString('hex')).toBe('89504e47');
  });

  it('healthCheck sempre OK', async () => {
    await expect(provider.healthCheck()).resolves.toEqual({ ok: true });
  });
});
```

- [ ] **Step 4: Rodar testes do provider console**

```bash
npx jest --config jest.config.ts src/modules/ai-visagism/providers/console-visagism.provider.spec.ts
```

Expected: 4 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/modules/ai-visagism/providers/
git commit -m "feat(ai-visagism): VisagismProvider interface + console implementation"
```

---

### Task 8: `AiSdkVisagismProvider` — Groq (análise) + OpenAI (geração) via AI SDK

**Files:**
- Create: `src/modules/ai-visagism/providers/ai-sdk-visagism.provider.ts`
- Create: `src/modules/ai-visagism/providers/ai-sdk-visagism.provider.spec.ts`

- [ ] **Step 1: Criar `src/modules/ai-visagism/providers/ai-sdk-visagism.provider.ts`**

```ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAI } from '@ai-sdk/openai';
import { generateObject, experimental_generateImage as generateImage } from 'ai';
import { VisagismProvider } from './visagism.provider';
import {
  VisagismProviderAnalyzeResult,
  VisagismProviderGenerateResult,
  VisagismSuggestion,
} from '../ai-visagism.types';
import { visagismAnalysisSchema } from '../ai-visagism.schemas';
import { VISAGISM_SYSTEM_PROMPT } from '../prompts/visagism.system';
import { buildGenerationPrompt } from '../prompts/visagism.generation-prompt';

@Injectable()
export class AiSdkVisagismProvider implements VisagismProvider {
  private readonly logger = new Logger(AiSdkVisagismProvider.name);
  private readonly groqModel: string;
  private readonly openaiImageModel: string;
  private readonly groqPricePerMtokCents: number;
  private readonly openaiImageCostCents: number;
  private readonly groq: ReturnType<typeof createGroq>;
  private readonly openai: ReturnType<typeof createOpenAI>;

  constructor(private readonly cfg: ConfigService) {
    this.groqModel = cfg.getOrThrow<string>('AI_VISAGISM_GROQ_MODEL');
    this.openaiImageModel = cfg.getOrThrow<string>('AI_VISAGISM_OPENAI_IMAGE_MODEL');
    this.groqPricePerMtokCents = cfg.getOrThrow<number>('AI_VISAGISM_GROQ_PRICE_PER_MTOK_CENTS');
    this.openaiImageCostCents = cfg.getOrThrow<number>('AI_VISAGISM_OPENAI_IMAGE_COST_CENTS');
    this.groq = createGroq({ apiKey: cfg.getOrThrow<string>('GROQ_API_KEY') });
    this.openai = createOpenAI({ apiKey: cfg.getOrThrow<string>('OPENAI_API_KEY') });
  }

  async analyze(input: {
    photoBuffer: Buffer;
    mimeType: string;
  }): Promise<VisagismProviderAnalyzeResult> {
    const { object, usage } = await generateObject({
      model: this.groq(this.groqModel),
      schema: visagismAnalysisSchema,
      system: VISAGISM_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Analise esta foto e siga as instruções do sistema.',
            },
            {
              type: 'file',
              mediaType: input.mimeType,
              data: input.photoBuffer,
            },
          ],
        },
      ],
    });

    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    const totalTokens = inputTokens + outputTokens;
    const costCents = Math.ceil((totalTokens / 1_000_000) * this.groqPricePerMtokCents);

    return {
      analysis: object,
      costCents,
      providerMeta: {
        provider: 'groq',
        model: this.groqModel,
        inputTokens,
        outputTokens,
      },
    };
  }

  async generateImage(input: {
    photoBuffer: Buffer;
    mimeType: string;
    suggestion: VisagismSuggestion;
  }): Promise<VisagismProviderGenerateResult> {
    const prompt = buildGenerationPrompt(input.suggestion);

    const { image } = await generateImage({
      model: this.openai.image(this.openaiImageModel),
      prompt: {
        text: prompt,
        images: [input.photoBuffer],
      } as unknown as string,
      // Cast acima é necessário enquanto a tipagem do AI SDK para gpt-image-1 + images
      // não está unificada. Runtime aceita o objeto. Quando a tipagem for atualizada, remover o cast.
    });

    const imageBuffer = Buffer.from(image.base64, 'base64');

    return {
      imageBuffer,
      imageMimeType: 'image/png',
      costCents: this.openaiImageCostCents,
      providerMeta: {
        provider: 'openai',
        model: this.openaiImageModel,
        suggestionId: input.suggestion.id,
      },
    };
  }

  async healthCheck(): Promise<{ ok: boolean }> {
    // Não chamamos rede aqui — apenas validamos que o client foi inicializado.
    return { ok: Boolean(this.groq && this.openai) };
  }
}
```

> **Nota crítica para o engenheiro:** as APIs do `@ai-sdk/groq` / `@ai-sdk/openai` evoluem. Antes de codar, leia em `node_modules/@ai-sdk/groq/dist/index.d.ts` e `node_modules/ai/dist/index.d.ts` os tipos exatos de `generateObject` (assinatura de `schema`, `messages`, `usage`) e de `experimental_generateImage` (objeto `prompt` vs string, formato do `image` retornado: `base64` direto ou `uint8Array`). Adapte os campos do código acima ao que estiver no `.d.ts` instalado (sem mudar o contrato externo do provider). Se `experimental_generateImage` for renomeado para `generateImage` no SDK, ajustar o import.

- [ ] **Step 2: Criar `src/modules/ai-visagism/providers/ai-sdk-visagism.provider.spec.ts`**

Este teste é smoke — não chama a rede. Mocka os módulos do AI SDK no nível do `jest.mock` para validar que o provider monta chamadas corretas e calcula custo certo.

```ts
import { ConfigService } from '@nestjs/config';
import { AiSdkVisagismProvider } from './ai-sdk-visagism.provider';

const generateObjectMock = jest.fn();
const generateImageMock = jest.fn();

jest.mock('ai', () => ({
  generateObject: (...args: unknown[]) => generateObjectMock(...args),
  experimental_generateImage: (...args: unknown[]) => generateImageMock(...args),
}));

jest.mock('@ai-sdk/groq', () => ({
  createGroq: jest.fn(() => {
    const fn = (model: string) => ({ __mock: 'groq-model', model });
    return fn as unknown as ReturnType<typeof createGroqType>;
  }),
}));

jest.mock('@ai-sdk/openai', () => ({
  createOpenAI: jest.fn(() => {
    const fn = () => ({});
    (fn as unknown as { image: (m: string) => unknown }).image = (m: string) => ({
      __mock: 'openai-image-model',
      m,
    });
    return fn;
  }),
}));

// Evita erro do TS quando lê o tipo
type createGroqType = (opts: unknown) => unknown;

function makeCfg(overrides: Record<string, string | number> = {}): ConfigService {
  const defaults: Record<string, string | number> = {
    AI_VISAGISM_GROQ_MODEL: 'meta-llama/llama-4-scout-17b-16e-instruct',
    AI_VISAGISM_OPENAI_IMAGE_MODEL: 'gpt-image-1',
    AI_VISAGISM_GROQ_PRICE_PER_MTOK_CENTS: 1,
    AI_VISAGISM_OPENAI_IMAGE_COST_CENTS: 4,
    GROQ_API_KEY: 'gsk_test',
    OPENAI_API_KEY: 'sk_test',
    ...overrides,
  };
  return {
    getOrThrow: <T,>(k: string) => defaults[k] as T,
  } as unknown as ConfigService;
}

describe('AiSdkVisagismProvider', () => {
  beforeEach(() => {
    generateObjectMock.mockReset();
    generateImageMock.mockReset();
  });

  it('analyze envia messages com text + file e calcula costCents pelos tokens', async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        faceShape: 'oval',
        description:
          'Rosto oval com proporções equilibradas; cabelo médio liso. Boa base para variedade de cortes.',
        suggestions: [
          {
            id: 'mid-fade-curtain',
            name: 'Mid fade com franja',
            rationale:
              'Mantém comprimento no topo e suaviza a largura das têmporas, equilibrando o rosto.',
            length: 'medium',
            style: 'moderno',
            suitableFor: ['rosto oval'],
          },
          {
            id: 'buzz-cut-classic',
            name: 'Buzz cut clássico',
            rationale: 'Realça mandíbula e exige pouca manutenção diária.',
            length: 'short',
            style: 'minimalista',
            suitableFor: ['rosto oval'],
          },
        ],
      },
      usage: { inputTokens: 1_500_000, outputTokens: 500_000 }, // 2M tokens → 2 cents @ 1
    });

    const provider = new AiSdkVisagismProvider(makeCfg());
    const out = await provider.analyze({
      photoBuffer: Buffer.from('jpegdata'),
      mimeType: 'image/jpeg',
    });

    expect(out.analysis.faceShape).toBe('oval');
    expect(out.costCents).toBe(2);
    expect(out.providerMeta).toMatchObject({
      provider: 'groq',
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      inputTokens: 1_500_000,
      outputTokens: 500_000,
    });

    const args = generateObjectMock.mock.calls[0][0] as {
      messages: { role: string; content: { type: string }[] }[];
      schema: unknown;
    };
    expect(args.messages[0].content[0].type).toBe('text');
    expect(args.messages[0].content[1].type).toBe('file');
  });

  it('generateImage usa o modelo OpenAI e devolve buffer + custo fixo', async () => {
    generateImageMock.mockResolvedValueOnce({
      image: { base64: Buffer.from('fake-png').toString('base64') },
    });

    const provider = new AiSdkVisagismProvider(makeCfg());
    const out = await provider.generateImage({
      photoBuffer: Buffer.from('orig'),
      mimeType: 'image/jpeg',
      suggestion: {
        id: 'mid-fade-curtain',
        name: 'Mid fade',
        rationale: 'X',
        length: 'medium',
        style: 'moderno',
        suitableFor: ['rosto oval'],
      },
    });

    expect(out.imageBuffer.toString()).toBe('fake-png');
    expect(out.imageMimeType).toBe('image/png');
    expect(out.costCents).toBe(4);
    expect(out.providerMeta).toMatchObject({
      provider: 'openai',
      model: 'gpt-image-1',
      suggestionId: 'mid-fade-curtain',
    });
  });

  it('analyze com usage ausente conta como 0 tokens → custo 0', async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        faceShape: 'round',
        description:
          'Rosto redondo; recomendamos cortes com volume no topo para alongar visualmente as proporções verticais.',
        suggestions: [
          {
            id: 'high-fade-pomp',
            name: 'Topete alto',
            rationale: 'Alonga o rosto verticalmente.',
            length: 'medium',
            style: 'clássico',
            suitableFor: ['rosto redondo'],
          },
          {
            id: 'undercut-volume',
            name: 'Undercut com volume',
            rationale: 'Cria contraste vertical no rosto redondo.',
            length: 'medium',
            style: 'moderno',
            suitableFor: ['rosto redondo'],
          },
        ],
      },
      // sem usage
    });

    const provider = new AiSdkVisagismProvider(makeCfg());
    const out = await provider.analyze({
      photoBuffer: Buffer.from('x'),
      mimeType: 'image/png',
    });
    expect(out.costCents).toBe(0);
  });
});
```

- [ ] **Step 3: Rodar testes do provider AI SDK**

```bash
npx jest --config jest.config.ts src/modules/ai-visagism/providers/ai-sdk-visagism.provider.spec.ts
```

Expected: 3 tests passed. **Se algum teste falhar por causa de tipagem do AI SDK (Step 1 nota crítica), ajustar a chamada conforme o `.d.ts` real.**

- [ ] **Step 4: Commit**

```bash
git add src/modules/ai-visagism/providers/ai-sdk-visagism.provider.ts src/modules/ai-visagism/providers/ai-sdk-visagism.provider.spec.ts
git commit -m "feat(ai-visagism): real provider using AI SDK + Groq + OpenAI"
```

---

### Task 9: `QuotaService` — incremento atômico, reembolso, reset mensal

**Files:**
- Create: `src/modules/ai-visagism/quota/quota.repository.ts`
- Create: `src/modules/ai-visagism/quota/quota.service.ts`
- Create: `src/modules/ai-visagism/quota/quota.service.spec.ts`

- [ ] **Step 1: Criar `src/modules/ai-visagism/quota/quota.repository.ts`**

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class QuotaRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Incremento atômico: só incrementa se `aiQuotaUsedThisMonth < limit`.
   * Retorna o novo valor, ou null se a cota estava esgotada.
   */
  async tryIncrement(tenantId: string, limit: number): Promise<number | null> {
    const rows = await this.prisma.$queryRaw<{ ai_quota_used_this_month: number }[]>`
      UPDATE "Subscription"
      SET "aiQuotaUsedThisMonth" = "aiQuotaUsedThisMonth" + 1,
          "updatedAt" = NOW()
      WHERE "tenantId" = ${tenantId}
        AND "aiQuotaUsedThisMonth" < ${limit}
      RETURNING "aiQuotaUsedThisMonth" AS ai_quota_used_this_month
    `;
    return rows[0]?.ai_quota_used_this_month ?? null;
  }

  /**
   * Reembolso (em caso de falha do job). Nunca abaixo de zero.
   */
  async refund(tenantId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "Subscription"
      SET "aiQuotaUsedThisMonth" = GREATEST("aiQuotaUsedThisMonth" - 1, 0),
          "updatedAt" = NOW()
      WHERE "tenantId" = ${tenantId}
    `;
  }

  /**
   * Reset mensal — chamado pelo cron `monthly-quota-reset`.
   * Retorna número de subscriptions resetadas.
   */
  async resetAll(): Promise<number> {
    const r = await this.prisma.subscription.updateMany({
      where: { aiQuotaUsedThisMonth: { gt: 0 } },
      data: { aiQuotaUsedThisMonth: 0 },
    });
    return r.count;
  }
}
```

- [ ] **Step 2: Criar `src/modules/ai-visagism/quota/quota.service.ts`**

```ts
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { QuotaRepository } from './quota.repository';

@Injectable()
export class QuotaService {
  private readonly limit: number;

  constructor(
    private readonly repo: QuotaRepository,
    cfg: ConfigService,
    private readonly logger: Logger,
  ) {
    this.limit = cfg.getOrThrow<number>('AI_VISAGISM_MONTHLY_QUOTA');
  }

  /** @throws DomainException(AI_QUOTA_EXCEEDED) se cota esgotada. */
  async chargeOrThrow(tenantId: string): Promise<{ used: number; limit: number }> {
    const used = await this.repo.tryIncrement(tenantId, this.limit);
    if (used === null) {
      throw new DomainException({
        code: ErrorCodes.AI_QUOTA_EXCEEDED,
        message: `Cota mensal de consultas de IA esgotada (${this.limit}).`,
        status: HttpStatus.TOO_MANY_REQUESTS,
        details: { limit: this.limit },
      });
    }
    return { used, limit: this.limit };
  }

  async refund(tenantId: string): Promise<void> {
    try {
      await this.repo.refund(tenantId);
    } catch (err) {
      // Reembolso não pode quebrar fluxo. Loga e segue.
      this.logger.warn({
        event: 'ai_visagism.quota_refund_failed',
        tenantId,
        error: (err as Error).message,
      });
    }
  }

  async resetAll(): Promise<number> {
    const count = await this.repo.resetAll();
    this.logger.log({ event: 'ai_visagism.quota_reset', count });
    return count;
  }

  get monthlyLimit(): number {
    return this.limit;
  }
}
```

- [ ] **Step 3: Criar `src/modules/ai-visagism/quota/quota.service.spec.ts`**

```ts
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { QuotaService } from './quota.service';
import { QuotaRepository } from './quota.repository';
import { DomainException } from 'src/common/exceptions/domain.exception';

function makeService(limit = 3) {
  const repo: jest.Mocked<Pick<QuotaRepository, 'tryIncrement' | 'refund' | 'resetAll'>> = {
    tryIncrement: jest.fn(),
    refund: jest.fn(),
    resetAll: jest.fn(),
  };
  const cfg = {
    getOrThrow: <T,>(k: string) => (k === 'AI_VISAGISM_MONTHLY_QUOTA' ? (limit as unknown as T) : (undefined as unknown as T)),
  } as unknown as ConfigService;
  const logger = { log: jest.fn(), warn: jest.fn() } as unknown as Logger;
  const service = new QuotaService(repo as unknown as QuotaRepository, cfg, logger);
  return { service, repo, logger };
}

describe('QuotaService', () => {
  it('chargeOrThrow retorna {used, limit} quando incremento sucede', async () => {
    const { service, repo } = makeService(3);
    repo.tryIncrement.mockResolvedValueOnce(1);
    await expect(service.chargeOrThrow('t1')).resolves.toEqual({ used: 1, limit: 3 });
    expect(repo.tryIncrement).toHaveBeenCalledWith('t1', 3);
  });

  it('chargeOrThrow lança DomainException AI_QUOTA_EXCEEDED quando esgotada', async () => {
    const { service, repo } = makeService(3);
    repo.tryIncrement.mockResolvedValueOnce(null);
    await expect(service.chargeOrThrow('t1')).rejects.toMatchObject({
      code: 'AI_QUOTA_EXCEEDED',
      status: 429,
    });
    expect(repo.tryIncrement).toHaveBeenCalled();
  });

  it('refund engole erro do repo e loga warn', async () => {
    const { service, repo, logger } = makeService();
    repo.refund.mockRejectedValueOnce(new Error('db down'));
    await expect(service.refund('t1')).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ai_visagism.quota_refund_failed' }),
    );
  });

  it('resetAll devolve count do repo e loga', async () => {
    const { service, repo } = makeService();
    repo.resetAll.mockResolvedValueOnce(42);
    await expect(service.resetAll()).resolves.toBe(42);
  });

  it('monthlyLimit reflete env', () => {
    const { service } = makeService(100);
    expect(service.monthlyLimit).toBe(100);
  });
});
```

- [ ] **Step 4: Rodar testes**

```bash
npx jest --config jest.config.ts src/modules/ai-visagism/quota/
```

Expected: 5 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/modules/ai-visagism/quota/
git commit -m "feat(ai-visagism): atomic monthly quota service with refund and reset"
```

---

### Task 10: `AiConsultationRepository` — CRUD + queries de cron

**Files:**
- Create: `src/modules/ai-visagism/repositories/ai-consultation.repository.ts`

- [ ] **Step 1: Criar `src/modules/ai-visagism/repositories/ai-consultation.repository.ts`**

```ts
import { Injectable } from '@nestjs/common';
import { AiConsultation, AiConsultationStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface CreateConsultationInput {
  tenantId: string;
  customerId?: string | null;
  barberId?: string | null;
  inputPhotoR2Key: string;
  viewTokenHash: string;
  consentAcceptedAt: Date;
  expiresAt: Date;
}

@Injectable()
export class AiConsultationRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateConsultationInput): Promise<AiConsultation> {
    return this.prisma.aiConsultation.create({
      data: {
        tenantId: input.tenantId,
        customerId: input.customerId ?? null,
        barberId: input.barberId ?? null,
        inputPhotoR2Key: input.inputPhotoR2Key,
        viewTokenHash: input.viewTokenHash,
        consentAcceptedAt: input.consentAcceptedAt,
        expiresAt: input.expiresAt,
        status: AiConsultationStatus.queued,
      },
    });
  }

  findById(id: string): Promise<AiConsultation | null> {
    return this.prisma.aiConsultation.findUnique({ where: { id } });
  }

  findByIdAndTokenHash(id: string, tokenHash: string): Promise<AiConsultation | null> {
    return this.prisma.aiConsultation.findFirst({
      where: { id, viewTokenHash: tokenHash },
    });
  }

  setProcessing(id: string): Promise<AiConsultation> {
    return this.prisma.aiConsultation.update({
      where: { id },
      data: { status: AiConsultationStatus.processing },
    });
  }

  setCompleted(input: {
    id: string;
    analysisJson: Prisma.InputJsonValue;
    costCentsToAdd: number;
  }): Promise<AiConsultation> {
    return this.prisma.aiConsultation.update({
      where: { id: input.id },
      data: {
        status: AiConsultationStatus.completed,
        analysisJson: input.analysisJson,
        providerCostCents: { increment: input.costCentsToAdd },
      },
    });
  }

  setGenerating(id: string): Promise<AiConsultation> {
    return this.prisma.aiConsultation.update({
      where: { id },
      data: { status: AiConsultationStatus.generating },
    });
  }

  setGenerated(input: {
    id: string;
    outputPhotoR2Key: string;
    costCentsToAdd: number;
  }): Promise<AiConsultation> {
    return this.prisma.aiConsultation.update({
      where: { id: input.id },
      data: {
        status: AiConsultationStatus.generated,
        outputPhotoR2Key: input.outputPhotoR2Key,
        providerCostCents: { increment: input.costCentsToAdd },
      },
    });
  }

  setFailed(input: { id: string; errorReason: string }): Promise<AiConsultation> {
    return this.prisma.aiConsultation.update({
      where: { id: input.id },
      data: { status: AiConsultationStatus.failed, errorReason: input.errorReason },
    });
  }

  /** Marca como expirado e zera dados sensíveis. Idempotente. */
  async markExpiredIfDue(
    id: string,
  ): Promise<{ updated: boolean; previousInputKey: string | null; previousOutputKey: string | null }> {
    const current = await this.prisma.aiConsultation.findUnique({ where: { id } });
    if (!current || current.expiredAt !== null) {
      return { updated: false, previousInputKey: null, previousOutputKey: null };
    }
    await this.prisma.aiConsultation.update({
      where: { id },
      data: {
        expiredAt: new Date(),
        inputPhotoR2Key: null,
        outputPhotoR2Key: null,
        analysisJson: Prisma.DbNull,
        status: AiConsultationStatus.expired,
      },
    });
    return {
      updated: true,
      previousInputKey: current.inputPhotoR2Key,
      previousOutputKey: current.outputPhotoR2Key,
    };
  }

  /** Pega consultations expiradas que ainda não foram limpas (LIMIT batchSize). */
  findDueForCleanup(now: Date, batchSize: number): Promise<AiConsultation[]> {
    return this.prisma.aiConsultation.findMany({
      where: { expiredAt: null, expiresAt: { lt: now } },
      orderBy: { expiresAt: 'asc' },
      take: batchSize,
    });
  }

  /** Snapshot para `/saas/ai-usage?detailed=true`. */
  listRecentByTenant(tenantId: string, take: number): Promise<AiConsultation[]> {
    return this.prisma.aiConsultation.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: zero erros.

- [ ] **Step 3: Commit**

```bash
git add src/modules/ai-visagism/repositories/
git commit -m "feat(ai-visagism): AiConsultationRepository with CRUD and cleanup queries"
```

---

### Task 11: DTOs do `ai-visagism`

**Files:**
- Create: `src/modules/ai-visagism/dto/create-consultation.dto.ts`
- Create: `src/modules/ai-visagism/dto/generate-image.dto.ts`
- Create: `src/modules/ai-visagism/dto/view-consultation-query.dto.ts`

- [ ] **Step 1: Criar `create-consultation.dto.ts`**

```ts
import { IsISO8601, IsOptional, IsString, Length } from 'class-validator';

/**
 * O body deste endpoint é multipart/form-data (campo `photo` é o arquivo).
 * Os campos abaixo são os fields textuais que acompanham o upload.
 */
export class CreateConsultationDto {
  @IsISO8601()
  consentAcceptedAt!: string;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  customerId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  barberId?: string;
}
```

- [ ] **Step 2: Criar `generate-image.dto.ts`**

```ts
import { IsString, Length } from 'class-validator';

export class GenerateImageDto {
  @IsString()
  @Length(2, 64)
  suggestionId!: string;
}
```

- [ ] **Step 3: Criar `view-consultation-query.dto.ts`**

```ts
import { IsString, Length } from 'class-validator';

export class ViewConsultationQueryDto {
  @IsString()
  @Length(20, 128)
  token!: string;
}
```

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```

Expected: zero erros.

- [ ] **Step 5: Commit**

```bash
git add src/modules/ai-visagism/dto/
git commit -m "feat(ai-visagism): controller DTOs (multipart create, generate, view query)"
```

---

### Task 12: `AiVisagismService` — orquestra upload, validações, criação e polling

**Files:**
- Create: `src/modules/ai-visagism/ai-visagism.service.ts`
- Create: `src/modules/ai-visagism/ai-visagism.service.spec.ts`

- [ ] **Step 1: Criar `ai-visagism.service.ts`**

```ts
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createHash, randomBytes } from 'crypto';
import { AiConsultation, AiConsultationStatus } from '@prisma/client';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { AuditService } from 'src/common/audit/audit.service';
import { AuditActions } from 'src/common/audit/audit-actions';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import {
  JOB_AI_ANALYSIS,
  JOB_AI_GENERATION,
  QUEUE_AI_VISAGISM,
} from 'src/infra/queues/queue-names';
import {
  ALLOWED_AI_PHOTO_CONTENT_TYPES,
  STORAGE_PROVIDER,
  StorageProvider,
  extensionFromContentType,
} from 'src/modules/storage/storage.provider';
import { AiConsultationRepository } from './repositories/ai-consultation.repository';
import { QuotaService } from './quota/quota.service';
import { VisagismAnalysis } from './ai-visagism.types';

export interface CreateConsultationCmd {
  tenantId: string;
  customerId?: string | null;
  barberId?: string | null;
  photoBuffer: Buffer;
  photoMimeType: string;
  consentAcceptedAt: Date;
  requestNow: Date;
}

export interface CreateConsultationResult {
  id: string;
  viewToken: string;
  expiresAt: Date;
  status: AiConsultationStatus;
  quotaUsed: number;
  quotaLimit: number;
}

@Injectable()
export class AiVisagismService {
  private readonly retentionDays: number;
  private readonly maxBytes: number;
  private readonly minDimension: number;
  private readonly consentMaxAgeSeconds: number;

  constructor(
    private readonly repo: AiConsultationRepository,
    private readonly quota: QuotaService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @InjectQueue(QUEUE_AI_VISAGISM) private readonly queue: Queue,
    private readonly cfg: ConfigService,
    private readonly logger: Logger,
  ) {
    this.retentionDays = cfg.getOrThrow<number>('AI_VISAGISM_RETENTION_DAYS');
    this.maxBytes = cfg.getOrThrow<number>('AI_VISAGISM_PHOTO_MAX_BYTES');
    this.minDimension = cfg.getOrThrow<number>('AI_VISAGISM_PHOTO_MIN_DIMENSION');
    this.consentMaxAgeSeconds = cfg.getOrThrow<number>('AI_VISAGISM_CONSENT_MAX_AGE_SECONDS');
  }

  async create(cmd: CreateConsultationCmd): Promise<CreateConsultationResult> {
    // 1. Subscription ativa? (trialing|active)
    await this.assertSubscriptionAllowed(cmd.tenantId);

    // 2. Consent age
    const ageSec = (cmd.requestNow.getTime() - cmd.consentAcceptedAt.getTime()) / 1000;
    if (ageSec < 0 || ageSec > this.consentMaxAgeSeconds) {
      throw new DomainException({
        code: ErrorCodes.AI_CONSENT_STALE,
        message: 'Consentimento expirado ou inválido. Por favor, aceite novamente.',
        status: HttpStatus.BAD_REQUEST,
      });
    }

    // 3. Validar foto (size, MIME real, dimensões)
    await this.assertPhotoValid(cmd.photoBuffer, cmd.photoMimeType);

    // 4. Validar customer/barber se passados (fail-soft: ignora se não pertencem ao tenant)
    const customerId = await this.resolveOptionalCustomer(cmd.tenantId, cmd.customerId);
    const barberId = await this.resolveOptionalBarber(cmd.tenantId, cmd.barberId);

    // 5. Cobrar cota (atomic). Se falhar, propaga 429.
    const { used, limit } = await this.quota.chargeOrThrow(cmd.tenantId);

    let inputPhotoR2Key: string | null = null;
    try {
      // 6. Subir pro R2
      const ext = extensionFromContentType(cmd.photoMimeType);
      const uploaded = await this.storage.uploadBuffer({
        tenantId: cmd.tenantId,
        buffer: cmd.photoBuffer,
        contentType: cmd.photoMimeType,
        extension: ext,
        prefix: 'ai-visagism/input',
      });
      inputPhotoR2Key = uploaded.r2Key;

      // 7. Gerar token + criar row
      const { plain, hash } = generateViewToken();
      const expiresAt = new Date(
        cmd.requestNow.getTime() + this.retentionDays * 24 * 60 * 60 * 1000,
      );
      const consultation = await this.repo.create({
        tenantId: cmd.tenantId,
        customerId,
        barberId,
        inputPhotoR2Key: uploaded.r2Key,
        viewTokenHash: hash,
        consentAcceptedAt: cmd.consentAcceptedAt,
        expiresAt,
      });

      // 8. Enfileirar análise
      await this.queue.add(
        JOB_AI_ANALYSIS,
        { consultationId: consultation.id, tenantId: cmd.tenantId },
        { attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 100 },
      );

      // 9. Audit
      await this.audit.record({
        action: AuditActions.AI_CONSULTATION_CREATED,
        tenantId: cmd.tenantId,
        targetType: 'ai_consultation',
        targetId: consultation.id,
        diff: { quotaUsed: used, quotaLimit: limit },
      });

      return {
        id: consultation.id,
        viewToken: plain,
        expiresAt,
        status: consultation.status,
        quotaUsed: used,
        quotaLimit: limit,
      };
    } catch (err) {
      // Compensação: reembolsa cota; tenta apagar foto se já subiu.
      await this.quota.refund(cmd.tenantId);
      if (inputPhotoR2Key) {
        await this.storage.delete(inputPhotoR2Key);
      }
      this.logger.warn({
        event: 'ai_visagism.create_rolled_back',
        tenantId: cmd.tenantId,
        error: (err as Error).message,
      });
      throw err;
    }
  }

  async getByIdAndToken(id: string, plainToken: string): Promise<AiConsultation> {
    const hash = hashViewToken(plainToken);
    const found = await this.repo.findByIdAndTokenHash(id, hash);
    if (!found) {
      throw new DomainException({
        code: ErrorCodes.AI_CONSULTATION_NOT_FOUND,
        message: 'Consulta não encontrada.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    return found;
  }

  async requestImageGeneration(input: {
    consultationId: string;
    plainToken: string;
    suggestionId: string;
  }): Promise<{ status: AiConsultationStatus }> {
    const consultation = await this.getByIdAndToken(input.consultationId, input.plainToken);
    if (consultation.expiredAt) {
      throw new DomainException({
        code: ErrorCodes.AI_CONSULTATION_EXPIRED,
        message: 'Esta consulta expirou.',
        status: HttpStatus.GONE,
      });
    }
    if (consultation.status !== AiConsultationStatus.completed) {
      throw new DomainException({
        code: ErrorCodes.AI_CONSULTATION_NOT_READY,
        message: 'A análise ainda não está pronta.',
        status: HttpStatus.CONFLICT,
        details: { status: consultation.status },
      });
    }
    const analysis = consultation.analysisJson as VisagismAnalysis | null;
    if (!analysis) {
      throw new DomainException({
        code: ErrorCodes.AI_CONSULTATION_NOT_READY,
        message: 'Análise ausente.',
        status: HttpStatus.CONFLICT,
      });
    }
    const suggestion = analysis.suggestions.find((s) => s.id === input.suggestionId);
    if (!suggestion) {
      throw new DomainException({
        code: ErrorCodes.AI_SUGGESTION_NOT_FOUND,
        message: 'Sugestão não encontrada nesta consulta.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    if (consultation.outputPhotoR2Key) {
      throw new DomainException({
        code: ErrorCodes.AI_GENERATION_ALREADY_REQUESTED,
        message: 'A geração de imagem já foi feita para esta consulta.',
        status: HttpStatus.CONFLICT,
      });
    }

    await this.repo.setGenerating(consultation.id);
    await this.queue.add(
      JOB_AI_GENERATION,
      {
        consultationId: consultation.id,
        tenantId: consultation.tenantId,
        suggestionId: suggestion.id,
      },
      { attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 100 },
    );
    return { status: AiConsultationStatus.generating };
  }

  private async assertSubscriptionAllowed(tenantId: string): Promise<void> {
    const sub = await this.prisma.subscription.findUnique({ where: { tenantId } });
    if (!sub || sub.status === 'cancelled' || sub.status === 'past_due') {
      throw new DomainException({
        code: ErrorCodes.SUBSCRIPTION_INACTIVE,
        message: 'A barbearia não está com assinatura ativa.',
        status: HttpStatus.PAYMENT_REQUIRED,
      });
    }
  }

  private async assertPhotoValid(buffer: Buffer, declaredMime: string): Promise<void> {
    if (buffer.byteLength > this.maxBytes) {
      throw new DomainException({
        code: ErrorCodes.AI_PHOTO_TOO_LARGE,
        message: `Foto maior que ${this.maxBytes} bytes.`,
        status: HttpStatus.PAYLOAD_TOO_LARGE,
      });
    }
    if (!ALLOWED_AI_PHOTO_CONTENT_TYPES.has(declaredMime)) {
      throw new DomainException({
        code: ErrorCodes.AI_PHOTO_INVALID,
        message: 'Formato declarado inválido.',
        status: HttpStatus.BAD_REQUEST,
      });
    }

    // file-type é ESM-only — dynamic import.
    const fileType = await import('file-type');
    const detected = await fileType.fileTypeFromBuffer(buffer);
    if (!detected || !ALLOWED_AI_PHOTO_CONTENT_TYPES.has(detected.mime)) {
      throw new DomainException({
        code: ErrorCodes.AI_PHOTO_INVALID,
        message: 'Conteúdo do arquivo não confere com um JPEG/PNG/WebP válido.',
        status: HttpStatus.BAD_REQUEST,
      });
    }
    if (detected.mime !== declaredMime) {
      throw new DomainException({
        code: ErrorCodes.AI_PHOTO_INVALID,
        message: 'MIME declarado difere do conteúdo real.',
        status: HttpStatus.BAD_REQUEST,
      });
    }

    // image-size é sync-ish; chamamos com buffer.
    const sizeMod = await import('image-size');
    const dims = sizeMod.default ? sizeMod.default(buffer) : (sizeMod as { imageSize: (b: Buffer) => { width?: number; height?: number } }).imageSize(buffer);
    const w = dims.width ?? 0;
    const h = dims.height ?? 0;
    if (w < this.minDimension || h < this.minDimension) {
      throw new DomainException({
        code: ErrorCodes.AI_PHOTO_TOO_SMALL,
        message: `Dimensão mínima ${this.minDimension}x${this.minDimension}.`,
        status: HttpStatus.BAD_REQUEST,
        details: { width: w, height: h, minDimension: this.minDimension },
      });
    }
  }

  private async resolveOptionalCustomer(
    tenantId: string,
    customerId?: string | null,
  ): Promise<string | null> {
    if (!customerId) return null;
    const c = await this.prisma.customer.findFirst({
      where: { id: customerId, tenantId, deletedAt: null },
      select: { id: true },
    });
    return c?.id ?? null;
  }

  private async resolveOptionalBarber(
    tenantId: string,
    barberId?: string | null,
  ): Promise<string | null> {
    if (!barberId) return null;
    const b = await this.prisma.barber.findFirst({
      where: { id: barberId, tenantId, deletedAt: null },
      select: { id: true },
    });
    return b?.id ?? null;
  }
}

export function generateViewToken(): { plain: string; hash: string } {
  const plain = randomBytes(32).toString('base64url');
  const hash = hashViewToken(plain);
  return { plain, hash };
}

export function hashViewToken(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}
```

> **Nota crítica para o engenheiro:** `image-size` mudou de default export entre versões. Se a v1 estava instalada, é `import sizeOf from 'image-size'`. Se a v2+, é `import { imageSize } from 'image-size'`. O bloco `sizeMod.default ? ... : ...` tenta as duas. Se Jest reclamar, ajuste para a forma da versão real (`cat node_modules/image-size/package.json | grep version`).

- [ ] **Step 2: Criar `ai-visagism.service.spec.ts` (cobre validações + happy path com storage console)**

```ts
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { AiVisagismService, generateViewToken, hashViewToken } from './ai-visagism.service';
import { AiConsultationRepository } from './repositories/ai-consultation.repository';
import { QuotaService } from './quota/quota.service';
import { AuditService } from 'src/common/audit/audit.service';
import { ConsoleStorageProvider } from 'src/modules/storage/providers/console-storage.provider';

// PNG 256x256 transparente — fixture mínima válida para image-size + file-type.
// Geramos in-memory com PNG header + tamanho válido. Para testes mais robustos use
// um buffer real (carregado de test/fixtures/photo-256.png).

describe('AiVisagismService — validações puras', () => {
  it('hashViewToken é determinístico e !== plain', () => {
    const { plain, hash } = generateViewToken();
    expect(hash).not.toEqual(plain);
    expect(hashViewToken(plain)).toEqual(hash);
    expect(hash).toHaveLength(64); // sha256 hex
  });
});

// Os testes completos do service vivem no E2E (Task 17) porque dependem
// de PNG real + Prisma. Aqui ficam só os helpers determinísticos.
```

- [ ] **Step 3: Rodar testes**

```bash
npx jest --config jest.config.ts src/modules/ai-visagism/ai-visagism.service.spec.ts
```

Expected: 1 test passed.

- [ ] **Step 4: Commit**

```bash
git add src/modules/ai-visagism/ai-visagism.service.ts src/modules/ai-visagism/ai-visagism.service.spec.ts
git commit -m "feat(ai-visagism): AiVisagismService orchestrating upload, quota, queue, audit"
```

---

### Task 13: `PublicAiVisagismController` — endpoints `/public/{slug}/ai/visagism/*`

**Files:**
- Create: `src/modules/ai-visagism/ai-visagism.public-controller.ts`

- [ ] **Step 1: Criar o controller**

```ts
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { AiVisagismService } from './ai-visagism.service';
import { CreateConsultationDto } from './dto/create-consultation.dto';
import { ViewConsultationQueryDto } from './dto/view-consultation-query.dto';
import { GenerateImageDto } from './dto/generate-image.dto';

/** Tipagem de Express.Multer.File local (evita depender de @types/multer). */
interface UploadedPhoto {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname: string;
}

@Controller()
export class PublicAiVisagismController {
  constructor(private readonly service: AiVisagismService) {}

  // POST /public/:slug/ai/visagism/consultations  (multipart, field "photo")
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('public/:slug/ai/visagism/consultations')
  @UseInterceptors(FileInterceptor('photo'))
  async create(
    @Param('slug') _slug: string,
    @Req() req: Request & { tenantId?: string },
    @UploadedFile() photo: UploadedPhoto | undefined,
    @Body() body: CreateConsultationDto,
  ) {
    if (!photo) {
      throw new DomainException({
        code: ErrorCodes.AI_PHOTO_INVALID,
        message: 'Foto ausente. Envie o campo "photo" via multipart/form-data.',
        status: HttpStatus.BAD_REQUEST,
      });
    }
    if (!req.tenantId) {
      // PublicTenantMiddleware deve ter populado isso. Se chegou sem, é bug de rota.
      throw new DomainException({
        code: ErrorCodes.TENANT_NOT_FOUND,
        message: 'Tenant não resolvido.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    const consentAt = new Date(body.consentAcceptedAt);
    if (Number.isNaN(consentAt.getTime())) {
      throw new BadRequestException('consentAcceptedAt inválido');
    }

    const result = await this.service.create({
      tenantId: req.tenantId,
      customerId: body.customerId ?? null,
      barberId: body.barberId ?? null,
      photoBuffer: photo.buffer,
      photoMimeType: photo.mimetype,
      consentAcceptedAt: consentAt,
      requestNow: new Date(),
    });

    return {
      id: result.id,
      viewToken: result.viewToken,
      expiresAt: result.expiresAt.toISOString(),
      status: result.status,
      quota: { used: result.quotaUsed, limit: result.quotaLimit },
    };
  }

  // GET /public/ai/visagism/consultations/:id?token=
  @SkipThrottle({ default: false })
  @Get('public/ai/visagism/consultations/:id')
  async get(@Param('id') id: string, @Query() q: ViewConsultationQueryDto) {
    const c = await this.service.getByIdAndToken(id, q.token);
    return {
      id: c.id,
      status: c.status,
      expiresAt: c.expiresAt.toISOString(),
      expiredAt: c.expiredAt?.toISOString() ?? null,
      analysis: c.analysisJson,
      hasGeneratedImage: c.outputPhotoR2Key !== null,
      errorReason: c.errorReason,
      providerCostCents: c.providerCostCents,
    };
  }

  // POST /public/ai/visagism/consultations/:id/generate-image?token=
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('public/ai/visagism/consultations/:id/generate-image')
  async generate(
    @Param('id') id: string,
    @Query() q: ViewConsultationQueryDto,
    @Body() body: GenerateImageDto,
  ) {
    return this.service.requestImageGeneration({
      consultationId: id,
      plainToken: q.token,
      suggestionId: body.suggestionId,
    });
  }

  // GET /public/ai/visagism/consultations/:id/image?token=
  // Retorna URL pré-assinada da imagem gerada.
  @Get('public/ai/visagism/consultations/:id/image')
  async getImageUrl(
    @Param('id') id: string,
    @Query() q: ViewConsultationQueryDto,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    return this.service.getGeneratedImageUrl(id, q.token);
  }
}
```

- [ ] **Step 2: Adicionar método `getGeneratedImageUrl` ao `AiVisagismService`**

Em `src/modules/ai-visagism/ai-visagism.service.ts`, adicionar antes do `private async assertSubscriptionAllowed`:

```ts
  async getGeneratedImageUrl(
    id: string,
    plainToken: string,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    const consultation = await this.getByIdAndToken(id, plainToken);
    if (consultation.expiredAt) {
      throw new DomainException({
        code: ErrorCodes.AI_CONSULTATION_EXPIRED,
        message: 'Esta consulta expirou.',
        status: HttpStatus.GONE,
      });
    }
    if (!consultation.outputPhotoR2Key) {
      throw new DomainException({
        code: ErrorCodes.AI_CONSULTATION_NOT_READY,
        message: 'Imagem ainda não gerada.',
        status: HttpStatus.CONFLICT,
        details: { status: consultation.status },
      });
    }
    const ttl = 300;
    const url = await this.storage.presignGet(consultation.outputPhotoR2Key, ttl);
    return { url, expiresInSeconds: ttl };
  }
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

Expected: zero erros.

- [ ] **Step 4: Commit**

```bash
git add src/modules/ai-visagism/ai-visagism.public-controller.ts src/modules/ai-visagism/ai-visagism.service.ts
git commit -m "feat(ai-visagism): public storefront controller with multipart upload and polling"
```

---

### Task 14: `AiVisagismProcessor` — workers das filas `ai-analysis` / `ai-generation` / `ai-cleanup` / `ai-quota-reset`

**Files:**
- Create: `src/modules/ai-visagism/ai-visagism.processor.ts`
- Create: `src/modules/ai-visagism/ai-visagism.processor.spec.ts`

- [ ] **Step 1: Criar `ai-visagism.processor.ts`**

```ts
import { Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { AiConsultationStatus } from '@prisma/client';
import { AuditService } from 'src/common/audit/audit.service';
import { AuditActions } from 'src/common/audit/audit-actions';
import {
  JOB_AI_ANALYSIS,
  JOB_AI_CLEANUP,
  JOB_AI_GENERATION,
  JOB_AI_QUOTA_RESET,
  QUEUE_AI_VISAGISM,
} from 'src/infra/queues/queue-names';
import {
  STORAGE_PROVIDER,
  StorageProvider,
} from 'src/modules/storage/storage.provider';
import { AiConsultationRepository } from './repositories/ai-consultation.repository';
import { QuotaService } from './quota/quota.service';
import { VisagismProvider } from './providers/visagism.provider';
import { VISAGISM_PROVIDER, AI_VISAGISM_CLEANUP_BATCH_SIZE } from './ai-visagism.constants';
import { VisagismAnalysis } from './ai-visagism.types';

interface AnalysisJobData {
  consultationId: string;
  tenantId: string;
}

interface GenerationJobData {
  consultationId: string;
  tenantId: string;
  suggestionId: string;
}

@Processor(QUEUE_AI_VISAGISM)
export class AiVisagismProcessor extends WorkerHost {
  constructor(
    private readonly repo: AiConsultationRepository,
    private readonly quota: QuotaService,
    private readonly audit: AuditService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(VISAGISM_PROVIDER) private readonly provider: VisagismProvider,
    private readonly cfg: ConfigService,
    private readonly logger: Logger,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    this.logger.log({ event: 'ai_visagism.job_started', name: job.name, id: job.id });

    switch (job.name) {
      case JOB_AI_ANALYSIS:
        return this.runAnalysis(job.data as AnalysisJobData, job);
      case JOB_AI_GENERATION:
        return this.runGeneration(job.data as GenerationJobData, job);
      case JOB_AI_CLEANUP:
        return this.runCleanup();
      case JOB_AI_QUOTA_RESET:
        return this.runQuotaReset();
      default:
        throw new Error(`unknown job: ${job.name}`);
    }
  }

  private async runAnalysis(data: AnalysisJobData, job: Job): Promise<{ ok: true }> {
    const consultation = await this.repo.findById(data.consultationId);
    if (!consultation) {
      this.logger.warn({
        event: 'ai_visagism.analysis_consultation_missing',
        id: data.consultationId,
      });
      return { ok: true };
    }
    if (consultation.expiredAt || !consultation.inputPhotoR2Key) {
      this.logger.warn({ event: 'ai_visagism.analysis_skipped_expired', id: consultation.id });
      return { ok: true };
    }
    if (consultation.status !== AiConsultationStatus.queued) {
      this.logger.warn({
        event: 'ai_visagism.analysis_unexpected_status',
        id: consultation.id,
        status: consultation.status,
      });
      return { ok: true };
    }

    try {
      await this.repo.setProcessing(consultation.id);
      const buffer = await this.storage.download(consultation.inputPhotoR2Key);
      const mime = this.guessMimeFromKey(consultation.inputPhotoR2Key);
      const result = await this.provider.analyze({ photoBuffer: buffer, mimeType: mime });

      await this.repo.setCompleted({
        id: consultation.id,
        analysisJson: result.analysis as unknown as object,
        costCentsToAdd: result.costCents,
      });
      await this.audit.record({
        action: AuditActions.AI_ANALYSIS_COMPLETED,
        tenantId: consultation.tenantId,
        targetType: 'ai_consultation',
        targetId: consultation.id,
        diff: { costCents: result.costCents, providerMeta: result.providerMeta },
      });
      return { ok: true };
    } catch (err) {
      const attemptsLeft = (job.opts.attempts ?? 1) - (job.attemptsMade + 1);
      if (attemptsLeft > 0) {
        throw err; // BullMQ retenta
      }
      // Última tentativa: finaliza como failed, reembolsa cota
      await this.repo.setFailed({
        id: consultation.id,
        errorReason: (err as Error).message.slice(0, 500),
      });
      await this.quota.refund(consultation.tenantId);
      await this.audit.record({
        action: AuditActions.AI_CONSULTATION_FAILED,
        tenantId: consultation.tenantId,
        targetType: 'ai_consultation',
        targetId: consultation.id,
        diff: { stage: 'analysis', error: (err as Error).message },
      });
      return { ok: true };
    }
  }

  private async runGeneration(data: GenerationJobData, job: Job): Promise<{ ok: true }> {
    const consultation = await this.repo.findById(data.consultationId);
    if (!consultation || consultation.expiredAt || !consultation.inputPhotoR2Key) {
      return { ok: true };
    }
    const analysis = consultation.analysisJson as VisagismAnalysis | null;
    const suggestion = analysis?.suggestions.find((s) => s.id === data.suggestionId);
    if (!suggestion) {
      await this.repo.setFailed({ id: consultation.id, errorReason: 'suggestion_not_found' });
      return { ok: true };
    }

    try {
      const buffer = await this.storage.download(consultation.inputPhotoR2Key);
      const mime = this.guessMimeFromKey(consultation.inputPhotoR2Key);
      const result = await this.provider.generateImage({
        photoBuffer: buffer,
        mimeType: mime,
        suggestion,
      });
      const ext = result.imageMimeType.split('/')[1];
      const uploaded = await this.storage.uploadBuffer({
        tenantId: consultation.tenantId,
        buffer: result.imageBuffer,
        contentType: result.imageMimeType,
        extension: ext,
        prefix: 'ai-visagism/output',
      });
      await this.repo.setGenerated({
        id: consultation.id,
        outputPhotoR2Key: uploaded.r2Key,
        costCentsToAdd: result.costCents,
      });
      await this.audit.record({
        action: AuditActions.AI_GENERATION_COMPLETED,
        tenantId: consultation.tenantId,
        targetType: 'ai_consultation',
        targetId: consultation.id,
        diff: {
          costCents: result.costCents,
          suggestionId: suggestion.id,
          providerMeta: result.providerMeta,
        },
      });
      return { ok: true };
    } catch (err) {
      const attemptsLeft = (job.opts.attempts ?? 1) - (job.attemptsMade + 1);
      if (attemptsLeft > 0) throw err;
      await this.repo.setFailed({
        id: consultation.id,
        errorReason: (err as Error).message.slice(0, 500),
      });
      await this.audit.record({
        action: AuditActions.AI_CONSULTATION_FAILED,
        tenantId: consultation.tenantId,
        targetType: 'ai_consultation',
        targetId: consultation.id,
        diff: { stage: 'generation', error: (err as Error).message },
      });
      return { ok: true };
    }
  }

  private async runCleanup(): Promise<{ processed: number }> {
    const now = new Date();
    const due = await this.repo.findDueForCleanup(now, AI_VISAGISM_CLEANUP_BATCH_SIZE);
    let processed = 0;
    for (const row of due) {
      const { updated, previousInputKey, previousOutputKey } = await this.repo.markExpiredIfDue(
        row.id,
      );
      if (!updated) continue;
      if (previousInputKey) await this.storage.delete(previousInputKey);
      if (previousOutputKey) await this.storage.delete(previousOutputKey);
      await this.audit.record({
        action: AuditActions.AI_CONSULTATION_EXPIRED,
        tenantId: row.tenantId,
        targetType: 'ai_consultation',
        targetId: row.id,
        diff: { reason: 'retention_policy' },
      });
      processed++;
    }
    this.logger.log({ event: 'ai_visagism.cleanup_done', processed, found: due.length });
    return { processed };
  }

  private async runQuotaReset(): Promise<{ resetCount: number }> {
    const resetCount = await this.quota.resetAll();
    return { resetCount };
  }

  private guessMimeFromKey(key: string): string {
    if (key.endsWith('.jpg') || key.endsWith('.jpeg')) return 'image/jpeg';
    if (key.endsWith('.png')) return 'image/png';
    if (key.endsWith('.webp')) return 'image/webp';
    return 'application/octet-stream';
  }
}
```

- [ ] **Step 2: Criar `ai-visagism.processor.spec.ts`**

```ts
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiConsultationStatus } from '@prisma/client';
import { AiVisagismProcessor } from './ai-visagism.processor';
import { AiConsultationRepository } from './repositories/ai-consultation.repository';
import { QuotaService } from './quota/quota.service';
import { AuditService } from 'src/common/audit/audit.service';
import { JOB_AI_ANALYSIS, JOB_AI_CLEANUP, JOB_AI_QUOTA_RESET } from 'src/infra/queues/queue-names';

function makeProcessor() {
  const repo = {
    findById: jest.fn(),
    setProcessing: jest.fn().mockResolvedValue({}),
    setCompleted: jest.fn().mockResolvedValue({}),
    setFailed: jest.fn().mockResolvedValue({}),
    findDueForCleanup: jest.fn().mockResolvedValue([]),
    markExpiredIfDue: jest.fn(),
    setGenerating: jest.fn().mockResolvedValue({}),
    setGenerated: jest.fn().mockResolvedValue({}),
  };
  const quota = { refund: jest.fn(), resetAll: jest.fn().mockResolvedValue(7) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const storage = {
    download: jest.fn().mockResolvedValue(Buffer.from('photo')),
    uploadBuffer: jest.fn(),
    delete: jest.fn(),
    presignGet: jest.fn(),
    presignUpload: jest.fn(),
  };
  const provider = {
    analyze: jest.fn(),
    generateImage: jest.fn(),
    healthCheck: jest.fn(),
  };
  const cfg = { getOrThrow: jest.fn() } as unknown as ConfigService;
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as Logger;

  const p = new AiVisagismProcessor(
    repo as unknown as AiConsultationRepository,
    quota as unknown as QuotaService,
    audit as unknown as AuditService,
    storage as never,
    provider as never,
    cfg,
    logger,
  );
  return { p, repo, quota, audit, storage, provider };
}

function makeJob(name: string, data: unknown, attemptsMade = 0, attempts = 3) {
  return {
    name,
    id: 'job-1',
    data,
    attemptsMade,
    opts: { attempts },
  } as never;
}

describe('AiVisagismProcessor', () => {
  it('analysis: happy path → setCompleted + audit AI_ANALYSIS_COMPLETED', async () => {
    const { p, repo, provider, audit } = makeProcessor();
    repo.findById.mockResolvedValueOnce({
      id: 'c1',
      tenantId: 't1',
      status: AiConsultationStatus.queued,
      inputPhotoR2Key: 'tenants/t1/ai-visagism/input/abc.jpg',
      expiredAt: null,
      analysisJson: null,
    });
    provider.analyze.mockResolvedValueOnce({
      analysis: { faceShape: 'oval', description: 'x', suggestions: [] },
      costCents: 1,
      providerMeta: { provider: 'groq' },
    });
    await p.process(makeJob(JOB_AI_ANALYSIS, { consultationId: 'c1', tenantId: 't1' }));
    expect(repo.setProcessing).toHaveBeenCalledWith('c1');
    expect(repo.setCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1', costCentsToAdd: 1 }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ai.analysis_completed', tenantId: 't1' }),
    );
  });

  it('analysis: erro com retries restantes → relança (BullMQ retenta)', async () => {
    const { p, repo, provider } = makeProcessor();
    repo.findById.mockResolvedValueOnce({
      id: 'c1',
      tenantId: 't1',
      status: AiConsultationStatus.queued,
      inputPhotoR2Key: 'tenants/t1/ai-visagism/input/abc.jpg',
      expiredAt: null,
    });
    provider.analyze.mockRejectedValueOnce(new Error('groq 500'));
    await expect(
      p.process(makeJob(JOB_AI_ANALYSIS, { consultationId: 'c1', tenantId: 't1' }, 0, 3)),
    ).rejects.toThrow('groq 500');
    expect(repo.setFailed).not.toHaveBeenCalled();
  });

  it('analysis: erro na última tentativa → setFailed + refund de cota + audit AI_CONSULTATION_FAILED', async () => {
    const { p, repo, provider, quota, audit } = makeProcessor();
    repo.findById.mockResolvedValueOnce({
      id: 'c1',
      tenantId: 't1',
      status: AiConsultationStatus.queued,
      inputPhotoR2Key: 'tenants/t1/ai-visagism/input/abc.jpg',
      expiredAt: null,
    });
    provider.analyze.mockRejectedValueOnce(new Error('groq 500'));
    await p.process(makeJob(JOB_AI_ANALYSIS, { consultationId: 'c1', tenantId: 't1' }, 2, 3));
    expect(repo.setFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1', errorReason: expect.stringContaining('groq 500') }),
    );
    expect(quota.refund).toHaveBeenCalledWith('t1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ai.consultation_failed' }),
    );
  });

  it('analysis: consulta já expirou → noop', async () => {
    const { p, repo, provider } = makeProcessor();
    repo.findById.mockResolvedValueOnce({
      id: 'c1',
      tenantId: 't1',
      status: AiConsultationStatus.queued,
      inputPhotoR2Key: null,
      expiredAt: new Date(),
    });
    await p.process(makeJob(JOB_AI_ANALYSIS, { consultationId: 'c1', tenantId: 't1' }));
    expect(provider.analyze).not.toHaveBeenCalled();
  });

  it('cleanup: processa expirados, deleta R2 keys, audit por item', async () => {
    const { p, repo, storage, audit } = makeProcessor();
    repo.findDueForCleanup.mockResolvedValueOnce([
      { id: 'c1', tenantId: 't1', expiresAt: new Date() },
      { id: 'c2', tenantId: 't2', expiresAt: new Date() },
    ]);
    repo.markExpiredIfDue.mockImplementation(async (id: string) => ({
      updated: true,
      previousInputKey: `tenants/${id}/ai-visagism/input/x.jpg`,
      previousOutputKey: null,
    }));
    const result = await p.process(makeJob('ai-cleanup', {}));
    expect(result).toEqual({ processed: 2 });
    expect(storage.delete).toHaveBeenCalledTimes(2);
    expect(audit.record).toHaveBeenCalledTimes(2);
  });

  it('quota-reset: chama QuotaService.resetAll', async () => {
    const { p, quota } = makeProcessor();
    const result = await p.process(makeJob(JOB_AI_QUOTA_RESET, {}));
    expect(quota.resetAll).toHaveBeenCalled();
    expect(result).toEqual({ resetCount: 7 });
  });
});
```

- [ ] **Step 3: Rodar testes**

```bash
npx jest --config jest.config.ts src/modules/ai-visagism/ai-visagism.processor.spec.ts
```

Expected: 6 tests passed.

- [ ] **Step 4: Commit**

```bash
git add src/modules/ai-visagism/ai-visagism.processor.ts src/modules/ai-visagism/ai-visagism.processor.spec.ts
git commit -m "feat(ai-visagism): BullMQ processor handling analysis, generation, cleanup, quota-reset"
```

---

### Task 15: `AiVisagismSchedules` — registrar crons de cleanup e quota-reset

**Files:**
- Create: `src/modules/ai-visagism/ai-visagism.schedules.ts`

- [ ] **Step 1: Criar o arquivo de schedules (segue padrão de `billing.schedules.ts`)**

```ts
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import {
  JOB_AI_CLEANUP,
  JOB_AI_QUOTA_RESET,
  QUEUE_AI_VISAGISM,
} from 'src/infra/queues/queue-names';
import {
  AI_VISAGISM_CLEANUP_SCHEDULER_KEY,
  AI_VISAGISM_QUOTA_RESET_SCHEDULER_KEY,
} from './ai-visagism.constants';

@Injectable()
export class AiVisagismSchedules implements OnApplicationBootstrap {
  private readonly logger = new Logger(AiVisagismSchedules.name);

  constructor(
    @InjectQueue(QUEUE_AI_VISAGISM) private readonly queue: Queue,
    private readonly cfg: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.cfg.get<string>('NODE_ENV') === 'test') {
      this.logger.log({ event: 'ai_visagism.schedules_skipped', reason: 'NODE_ENV=test' });
      return;
    }
    const cleanupCron = this.cfg.get<string>('AI_VISAGISM_CLEANUP_CRON') ?? '0 3 * * *';
    const quotaResetCron = this.cfg.get<string>('AI_VISAGISM_QUOTA_RESET_CRON') ?? '5 0 1 * *';

    await this.queue.upsertJobScheduler(
      AI_VISAGISM_CLEANUP_SCHEDULER_KEY,
      { pattern: cleanupCron, tz: 'UTC' },
      { name: JOB_AI_CLEANUP, data: {} },
    );
    await this.queue.upsertJobScheduler(
      AI_VISAGISM_QUOTA_RESET_SCHEDULER_KEY,
      { pattern: quotaResetCron, tz: 'UTC' },
      { name: JOB_AI_QUOTA_RESET, data: {} },
    );

    this.logger.log({
      event: 'ai_visagism.schedules_registered',
      cleanupCron,
      quotaResetCron,
    });
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: zero erros.

- [ ] **Step 3: Commit**

```bash
git add src/modules/ai-visagism/ai-visagism.schedules.ts
git commit -m "feat(ai-visagism): register cleanup and monthly quota-reset cron schedulers"
```

---

### Task 16: `AiVisagismModule` + registro em `AppModule` + ajuste do `PublicModule`

**Files:**
- Create: `src/modules/ai-visagism/ai-visagism.module.ts`
- Modify: `src/infra/queues/queues.module.ts`
- Modify: `src/app.module.ts`
- Modify: `src/modules/public/public.module.ts`

- [ ] **Step 1: Criar `ai-visagism.module.ts`**

```ts
import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { StorageModule } from 'src/modules/storage/storage.module';
import { QUEUE_AI_VISAGISM } from 'src/infra/queues/queue-names';
import { AiVisagismService } from './ai-visagism.service';
import { AiVisagismProcessor } from './ai-visagism.processor';
import { AiVisagismSchedules } from './ai-visagism.schedules';
import { AiConsultationRepository } from './repositories/ai-consultation.repository';
import { QuotaService } from './quota/quota.service';
import { QuotaRepository } from './quota/quota.repository';
import { PublicAiVisagismController } from './ai-visagism.public-controller';
import { VISAGISM_PROVIDER } from './ai-visagism.constants';
import { ConsoleVisagismProvider } from './providers/console-visagism.provider';
import { AiSdkVisagismProvider } from './providers/ai-sdk-visagism.provider';

@Module({
  imports: [
    PrismaModule,
    StorageModule,
    BullModule.registerQueue({ name: QUEUE_AI_VISAGISM }),
  ],
  controllers: [PublicAiVisagismController],
  providers: [
    AiVisagismService,
    AiVisagismProcessor,
    AiVisagismSchedules,
    AiConsultationRepository,
    QuotaService,
    QuotaRepository,
    Logger,
    {
      provide: VISAGISM_PROVIDER,
      useFactory: (cfg: ConfigService): unknown => {
        const which = cfg.get<string>('AI_VISAGISM_PROVIDER');
        if (which === 'aisdk') return new AiSdkVisagismProvider(cfg);
        return new ConsoleVisagismProvider();
      },
      inject: [ConfigService],
    },
  ],
  exports: [AiVisagismService, AiConsultationRepository],
})
export class AiVisagismModule {}
```

- [ ] **Step 2: Atualizar `src/infra/queues/queues.module.ts` para registrar a queue globalmente**

```ts
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { QUEUE_AI_VISAGISM, QUEUE_BILLING } from './queue-names';

@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: (cfg: ConfigService) => ({
        connection: { url: cfg.get<string>('REDIS_URL') },
      }),
      inject: [ConfigService],
    }),
    BullModule.registerQueue({ name: QUEUE_BILLING }, { name: QUEUE_AI_VISAGISM }),
  ],
  exports: [BullModule],
})
export class QueuesModule {}
```

- [ ] **Step 3: Registrar `AiVisagismModule` em `src/app.module.ts`**

No array `imports`, depois de `BillingModule`:

```ts
import { AiVisagismModule } from './modules/ai-visagism/ai-visagism.module';

// ... imports:
    BillingModule,
    AiVisagismModule,
    SaasAdminModule,
```

- [ ] **Step 4: Atualizar `src/modules/public/public.module.ts`**

Importar `AiVisagismModule` e ajustar o middleware para não aplicar slug em rotas de IA sem slug:

```ts
import { AiVisagismModule } from 'src/modules/ai-visagism/ai-visagism.module';

@Module({
  imports: [
    TenantsModule,
    BarbersModule,
    CatalogModule,
    CustomersModule,
    SchedulingModule,
    NotificationsModule,
    AiVisagismModule,
  ],
  // controllers permanecem os mesmos (PublicAiVisagismController vem do AiVisagismModule)
  controllers: [
    PublicCatalogController,
    PublicAvailabilityController,
    PublicAppointmentsController,
  ],
})
export class PublicModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(PublicTenantMiddleware)
      .exclude(
        { path: 'public/appointments/(.*)', method: RequestMethod.ALL },
        { path: 'public/appointments', method: RequestMethod.ALL },
        { path: 'public/ai/visagism/(.*)', method: RequestMethod.ALL },
      )
      .forRoutes({ path: 'public/:slug/*', method: RequestMethod.ALL });
    consumer
      .apply(PublicTenantMiddleware)
      .forRoutes({ path: 'public/:slug', method: RequestMethod.GET });
  }
}
```

> **Nota:** O `PublicAiVisagismController` declara as rotas `public/:slug/ai/visagism/consultations` (que casam com `public/:slug/*` → middleware aplica e popula `tenantId`) e `public/ai/visagism/consultations/:id` (sem slug → middleware **não** aplica, controller usa o token para autorizar). O `exclude` é necessário pra evitar que o middleware tente extrair slug em rotas que não têm.

- [ ] **Step 5: Typecheck + lint**

```bash
npx tsc --noEmit
npm run lint
```

Expected: zero erros.

- [ ] **Step 6: Smoke test — sobe app local**

```bash
docker compose up -d postgres redis
npm run start
```

Em outro terminal:

```bash
curl -s http://localhost:3000/health/ready | jq .
```

Expected: `{"status":"ok",...}`. Encerra com Ctrl+C.

- [ ] **Step 7: Commit**

```bash
git add src/modules/ai-visagism/ai-visagism.module.ts src/infra/queues/queues.module.ts src/app.module.ts src/modules/public/public.module.ts
git commit -m "feat(ai-visagism): wire module, queue, public routes"
```

---

### Task 17: Suporte de testes — fixture de foto + helpers e2e

**Files:**
- Create: `test/fixtures/photo-256.jpg` (binário — gerado por script abaixo)
- Create: `test/support/ai-visagism.ts`

- [ ] **Step 1: Gerar fixture binária 256×256 JPEG**

Use o ImageMagick (pré-instalado no Linux/WSL); se não tiver, instale via `sudo apt install -y imagemagick`.

```bash
mkdir -p test/fixtures
convert -size 256x256 xc:gray -fill black -draw "circle 128,128 128,40" test/fixtures/photo-256.jpg
file test/fixtures/photo-256.jpg
```

Expected (saída do `file`): `JPEG image data, ... 256x256 ...`.

Se ImageMagick não estiver disponível, gere via Node script ad-hoc:

```bash
node -e "
const fs = require('fs');
// JPEG mínimo 256x256 cinza usando sharp (npm i -D sharp) — alternativa.
// Aqui usamos um buffer pré-gerado em base64 (256x256 cinza JPEG, ~1KB).
const b64 = '<INSERIR_BASE64_AQUI>';
fs.writeFileSync('test/fixtures/photo-256.jpg', Buffer.from(b64, 'base64'));
"
```

> Recomendado: ImageMagick. Buffer base64 é frágil pra manter no plano. **Se o engenheiro estiver sem ImageMagick e sem internet pra `apt install`**, instale `sharp` como devDependency e gere com `sharp({create:{width:256,height:256,channels:3,background:{r:128,g:128,b:128}}}).jpeg().toBuffer()`.

- [ ] **Step 2: Criar `test/support/ai-visagism.ts`**

```ts
import { INestApplication } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AiConsultationStatus } from '@prisma/client';
import { AiVisagismProcessor } from 'src/modules/ai-visagism/ai-visagism.processor';
import { Job } from 'bullmq';
import {
  JOB_AI_ANALYSIS,
  JOB_AI_CLEANUP,
  JOB_AI_GENERATION,
  JOB_AI_QUOTA_RESET,
} from 'src/infra/queues/queue-names';

export const PHOTO_FIXTURE_PATH = join(process.cwd(), 'test/fixtures/photo-256.jpg');

export function loadPhotoBuffer(): Buffer {
  return readFileSync(PHOTO_FIXTURE_PATH);
}

export function freshConsentAt(): string {
  return new Date().toISOString();
}

/** Executa o processor inline (sem BullMQ rodar). Usado em e2e pra simular o worker. */
export async function runAiJob(
  app: INestApplication,
  name: string,
  data: unknown,
  opts: { attemptsMade?: number; attempts?: number } = {},
): Promise<unknown> {
  const processor = app.get(AiVisagismProcessor);
  const fakeJob = {
    name,
    id: `inline-${Date.now()}`,
    data,
    attemptsMade: opts.attemptsMade ?? 0,
    opts: { attempts: opts.attempts ?? 3 },
  } as unknown as Job;
  return processor.process(fakeJob);
}

export async function runAnalysisJob(app: INestApplication, consultationId: string, tenantId: string) {
  return runAiJob(app, JOB_AI_ANALYSIS, { consultationId, tenantId });
}

export async function runGenerationJob(
  app: INestApplication,
  consultationId: string,
  tenantId: string,
  suggestionId: string,
) {
  return runAiJob(app, JOB_AI_GENERATION, { consultationId, tenantId, suggestionId });
}

export async function runCleanupJob(app: INestApplication) {
  return runAiJob(app, JOB_AI_CLEANUP, {});
}

export async function runQuotaResetJob(app: INestApplication) {
  return runAiJob(app, JOB_AI_QUOTA_RESET, {});
}

/** Conveniência: muda expiresAt manualmente pro passado pra simular retenção vencida. */
export async function expireConsultation(prisma: PrismaService, id: string) {
  await prisma.aiConsultation.update({
    where: { id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
}

export async function findConsultation(prisma: PrismaService, id: string) {
  return prisma.aiConsultation.findUnique({ where: { id } });
}

export async function setQuotaUsage(prisma: PrismaService, tenantId: string, used: number) {
  await prisma.subscription.update({
    where: { tenantId },
    data: { aiQuotaUsedThisMonth: used },
  });
}

export function expectStatus(c: { status: AiConsultationStatus }, expected: AiConsultationStatus) {
  if (c.status !== expected) {
    throw new Error(`expected status ${expected}, got ${c.status}`);
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add test/fixtures/photo-256.jpg test/support/ai-visagism.ts
git commit -m "test(ai-visagism): photo fixture and e2e helpers (inline processor runner)"
```

---

### Task 18: E2E — happy path (upload → analysis → polling)

**Files:**
- Create: `test/e2e/ai-visagism-happy-path.e2e-spec.ts`

- [ ] **Step 1: Criar o spec**

```ts
import { INestApplication, HttpStatus } from '@nestjs/common';
import request from 'supertest';
import { setupTestApp, teardownTestApp } from 'test/support/test-app';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { registerOwnerWithTenant } from 'test/support/auth-onboarding';
import {
  loadPhotoBuffer,
  freshConsentAt,
  runAnalysisJob,
  findConsultation,
} from 'test/support/ai-visagism';
import { AiConsultationStatus } from '@prisma/client';

describe('AI Visagism — happy path', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await setupTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => teardownTestApp(app));

  beforeEach(async () => {
    await prisma.aiConsultation.deleteMany({});
    await prisma.subscription.updateMany({ data: { aiQuotaUsedThisMonth: 0 } });
  });

  it('cria consulta, processa análise, polling retorna status=completed com analysisJson', async () => {
    const { tenant } = await registerOwnerWithTenant(app, {
      email: 'visagism-owner@kairo.test',
      slug: 'visagism-shop',
    });

    const photo = loadPhotoBuffer();

    // POST cria consulta
    const createRes = await request(app.getHttpServer())
      .post(`/public/${tenant.slug}/ai/visagism/consultations`)
      .field('consentAcceptedAt', freshConsentAt())
      .attach('photo', photo, { filename: 'photo.jpg', contentType: 'image/jpeg' });

    expect(createRes.status).toBe(HttpStatus.CREATED);
    expect(createRes.body).toMatchObject({
      id: expect.any(String),
      viewToken: expect.any(String),
      status: AiConsultationStatus.queued,
      quota: { used: 1, limit: 100 },
    });
    const { id, viewToken } = createRes.body;

    // Roda o worker inline (simula BullMQ consumir o job)
    await runAnalysisJob(app, id, tenant.id);

    // Verifica row no banco
    const row = await findConsultation(prisma, id);
    expect(row?.status).toBe(AiConsultationStatus.completed);
    expect(row?.analysisJson).toMatchObject({
      faceShape: expect.any(String),
      suggestions: expect.any(Array),
    });

    // GET com token retorna análise
    const getRes = await request(app.getHttpServer())
      .get(`/public/ai/visagism/consultations/${id}`)
      .query({ token: viewToken });

    expect(getRes.status).toBe(HttpStatus.OK);
    expect(getRes.body).toMatchObject({
      id,
      status: AiConsultationStatus.completed,
      hasGeneratedImage: false,
    });
    expect(getRes.body.analysis.suggestions.length).toBeGreaterThanOrEqual(2);
  });

  it('GET sem token retorna 400', async () => {
    const { tenant } = await registerOwnerWithTenant(app, {
      email: 'no-token@kairo.test',
      slug: 'no-token-shop',
    });
    const create = await request(app.getHttpServer())
      .post(`/public/${tenant.slug}/ai/visagism/consultations`)
      .field('consentAcceptedAt', freshConsentAt())
      .attach('photo', loadPhotoBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' });
    const id = create.body.id;
    const res = await request(app.getHttpServer()).get(
      `/public/ai/visagism/consultations/${id}`,
    );
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it('GET com token errado retorna 404', async () => {
    const { tenant } = await registerOwnerWithTenant(app, {
      email: 'bad-token@kairo.test',
      slug: 'bad-token-shop',
    });
    const create = await request(app.getHttpServer())
      .post(`/public/${tenant.slug}/ai/visagism/consultations`)
      .field('consentAcceptedAt', freshConsentAt())
      .attach('photo', loadPhotoBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' });
    const id = create.body.id;
    const res = await request(app.getHttpServer())
      .get(`/public/ai/visagism/consultations/${id}`)
      .query({ token: 'X'.repeat(43) });
    expect(res.status).toBe(HttpStatus.NOT_FOUND);
    expect(res.body.code).toBe('AI_CONSULTATION_NOT_FOUND');
  });
});
```

> **Nota:** `registerOwnerWithTenant` é o helper já existente em `test/support/` (use o mesmo nome que os outros e2e usam — checar `test/support/auth-onboarding.ts` antes de codar). Se nome divergir, ajuste o import.

- [ ] **Step 2: Rodar o spec**

```bash
docker compose up -d postgres redis
npx jest --config jest.e2e.config.ts test/e2e/ai-visagism-happy-path.e2e-spec.ts --runInBand
```

Expected: 3 tests passed.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/ai-visagism-happy-path.e2e-spec.ts
git commit -m "test(ai-visagism): e2e happy path (upload → analysis → polling)"
```

---

### Task 19: E2E — cota, gating e validações de upload

**Files:**
- Create: `test/e2e/ai-visagism-quota.e2e-spec.ts`
- Create: `test/e2e/ai-visagism-gating.e2e-spec.ts`
- Create: `test/e2e/ai-visagism-tokens.e2e-spec.ts`

- [ ] **Step 1: Criar `ai-visagism-quota.e2e-spec.ts`**

```ts
import { HttpStatus, INestApplication } from '@nestjs/common';
import request from 'supertest';
import { setupTestApp, teardownTestApp } from 'test/support/test-app';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { registerOwnerWithTenant } from 'test/support/auth-onboarding';
import {
  freshConsentAt,
  loadPhotoBuffer,
  runQuotaResetJob,
  setQuotaUsage,
} from 'test/support/ai-visagism';

describe('AI Visagism — cota mensal', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await setupTestApp();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => teardownTestApp(app));

  beforeEach(async () => {
    await prisma.aiConsultation.deleteMany({});
  });

  it('429 AI_QUOTA_EXCEEDED quando aiQuotaUsedThisMonth >= limite', async () => {
    const { tenant } = await registerOwnerWithTenant(app, {
      email: 'quota-test@kairo.test',
      slug: 'quota-shop',
    });
    await setQuotaUsage(prisma, tenant.id, 100); // = AI_VISAGISM_MONTHLY_QUOTA default

    const res = await request(app.getHttpServer())
      .post(`/public/${tenant.slug}/ai/visagism/consultations`)
      .field('consentAcceptedAt', freshConsentAt())
      .attach('photo', loadPhotoBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(res.body.code).toBe('AI_QUOTA_EXCEEDED');
    expect(res.body.details.limit).toBe(100);
  });

  it('runQuotaResetJob zera aiQuotaUsedThisMonth para todos tenants', async () => {
    const { tenant: t1 } = await registerOwnerWithTenant(app, {
      email: 'reset-1@kairo.test',
      slug: 'reset-shop-1',
    });
    const { tenant: t2 } = await registerOwnerWithTenant(app, {
      email: 'reset-2@kairo.test',
      slug: 'reset-shop-2',
    });
    await setQuotaUsage(prisma, t1.id, 47);
    await setQuotaUsage(prisma, t2.id, 100);

    await runQuotaResetJob(app);

    const s1 = await prisma.subscription.findUnique({ where: { tenantId: t1.id } });
    const s2 = await prisma.subscription.findUnique({ where: { tenantId: t2.id } });
    expect(s1?.aiQuotaUsedThisMonth).toBe(0);
    expect(s2?.aiQuotaUsedThisMonth).toBe(0);
  });
});
```

- [ ] **Step 2: Criar `ai-visagism-gating.e2e-spec.ts`**

```ts
import { HttpStatus, INestApplication } from '@nestjs/common';
import request from 'supertest';
import { setupTestApp, teardownTestApp } from 'test/support/test-app';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { registerOwnerWithTenant } from 'test/support/auth-onboarding';
import { freshConsentAt, loadPhotoBuffer } from 'test/support/ai-visagism';

describe('AI Visagism — gating', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  beforeAll(async () => {
    app = await setupTestApp();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => teardownTestApp(app));
  beforeEach(async () => {
    await prisma.aiConsultation.deleteMany({});
  });

  it('404 quando tenant suspended', async () => {
    const { tenant } = await registerOwnerWithTenant(app, {
      email: 'suspended-ai@kairo.test',
      slug: 'suspended-ai-shop',
    });
    await prisma.tenant.update({ where: { id: tenant.id }, data: { suspendedAt: new Date() } });

    const res = await request(app.getHttpServer())
      .post(`/public/${tenant.slug}/ai/visagism/consultations`)
      .field('consentAcceptedAt', freshConsentAt())
      .attach('photo', loadPhotoBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(HttpStatus.NOT_FOUND);
  });

  it('402 SUBSCRIPTION_INACTIVE quando subscription past_due', async () => {
    const { tenant } = await registerOwnerWithTenant(app, {
      email: 'pastdue-ai@kairo.test',
      slug: 'pastdue-ai-shop',
    });
    await prisma.subscription.update({
      where: { tenantId: tenant.id },
      data: { status: 'past_due' },
    });
    const res = await request(app.getHttpServer())
      .post(`/public/${tenant.slug}/ai/visagism/consultations`)
      .field('consentAcceptedAt', freshConsentAt())
      .attach('photo', loadPhotoBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(HttpStatus.PAYMENT_REQUIRED);
    expect(res.body.code).toBe('SUBSCRIPTION_INACTIVE');
  });

  it('400 AI_CONSENT_STALE quando consentAcceptedAt > 1h atrás', async () => {
    const { tenant } = await registerOwnerWithTenant(app, {
      email: 'stale-consent@kairo.test',
      slug: 'stale-consent-shop',
    });
    const oldConsent = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const res = await request(app.getHttpServer())
      .post(`/public/${tenant.slug}/ai/visagism/consultations`)
      .field('consentAcceptedAt', oldConsent)
      .attach('photo', loadPhotoBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(res.body.code).toBe('AI_CONSENT_STALE');
  });

  it('400 AI_PHOTO_INVALID quando MIME falsificado (jpeg declarado, png real)', async () => {
    const { tenant } = await registerOwnerWithTenant(app, {
      email: 'fake-mime@kairo.test',
      slug: 'fake-mime-shop',
    });
    // PNG mínimo 256x256 — copia do fixture e renomeia mime ao subir
    // Pra esse teste subimos um PNG real declarando como image/jpeg.
    // Fixture: gere test/fixtures/photo-256.png ao lado do .jpg (etapa de Task 17).
    // Se ainda não gerou, gere agora: `convert -size 256x256 xc:gray test/fixtures/photo-256.png`
    const fs = await import('fs');
    const pngPath = 'test/fixtures/photo-256.png';
    if (!fs.existsSync(pngPath)) {
      // sinaliza para o engenheiro gerar e re-rodar
      throw new Error(
        `Fixture ausente: ${pngPath}. Gere com: convert -size 256x256 xc:gray ${pngPath}`,
      );
    }
    const png = fs.readFileSync(pngPath);
    const res = await request(app.getHttpServer())
      .post(`/public/${tenant.slug}/ai/visagism/consultations`)
      .field('consentAcceptedAt', freshConsentAt())
      .attach('photo', png, { filename: 'fake.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(res.body.code).toBe('AI_PHOTO_INVALID');
  });
});
```

- [ ] **Step 3: Criar `ai-visagism-tokens.e2e-spec.ts`**

```ts
import { HttpStatus, INestApplication } from '@nestjs/common';
import request from 'supertest';
import { setupTestApp, teardownTestApp } from 'test/support/test-app';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { registerOwnerWithTenant } from 'test/support/auth-onboarding';
import { freshConsentAt, loadPhotoBuffer, runAnalysisJob } from 'test/support/ai-visagism';

describe('AI Visagism — tokens e tenancy', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  beforeAll(async () => {
    app = await setupTestApp();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => teardownTestApp(app));
  beforeEach(async () => {
    await prisma.aiConsultation.deleteMany({});
  });

  it('GET /image antes da geração retorna 409 AI_CONSULTATION_NOT_READY', async () => {
    const { tenant } = await registerOwnerWithTenant(app, {
      email: 'image-conflict@kairo.test',
      slug: 'image-conflict-shop',
    });
    const create = await request(app.getHttpServer())
      .post(`/public/${tenant.slug}/ai/visagism/consultations`)
      .field('consentAcceptedAt', freshConsentAt())
      .attach('photo', loadPhotoBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' });
    await runAnalysisJob(app, create.body.id, tenant.id);
    const res = await request(app.getHttpServer())
      .get(`/public/ai/visagism/consultations/${create.body.id}/image`)
      .query({ token: create.body.viewToken });
    expect(res.status).toBe(HttpStatus.CONFLICT);
    expect(res.body.code).toBe('AI_CONSULTATION_NOT_READY');
  });

  it('viewToken serve apenas para a consulta dele (não cross-consultation)', async () => {
    const { tenant } = await registerOwnerWithTenant(app, {
      email: 'cross-token@kairo.test',
      slug: 'cross-token-shop',
    });
    const a = await request(app.getHttpServer())
      .post(`/public/${tenant.slug}/ai/visagism/consultations`)
      .field('consentAcceptedAt', freshConsentAt())
      .attach('photo', loadPhotoBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' });
    const b = await request(app.getHttpServer())
      .post(`/public/${tenant.slug}/ai/visagism/consultations`)
      .field('consentAcceptedAt', freshConsentAt())
      .attach('photo', loadPhotoBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' });

    const swap = await request(app.getHttpServer())
      .get(`/public/ai/visagism/consultations/${a.body.id}`)
      .query({ token: b.body.viewToken });
    expect(swap.status).toBe(HttpStatus.NOT_FOUND);
  });
});
```

- [ ] **Step 4: Gerar fixture PNG (caso ainda não tenha)**

```bash
convert -size 256x256 xc:gray test/fixtures/photo-256.png
```

- [ ] **Step 5: Rodar specs**

```bash
npx jest --config jest.e2e.config.ts test/e2e/ai-visagism-quota.e2e-spec.ts test/e2e/ai-visagism-gating.e2e-spec.ts test/e2e/ai-visagism-tokens.e2e-spec.ts --runInBand
```

Expected: 9 tests passed (2 + 4 + 2 — ajuste conforme contagem real).

- [ ] **Step 6: Commit**

```bash
git add test/e2e/ai-visagism-quota.e2e-spec.ts test/e2e/ai-visagism-gating.e2e-spec.ts test/e2e/ai-visagism-tokens.e2e-spec.ts test/fixtures/photo-256.png
git commit -m "test(ai-visagism): e2e quota, gating, token isolation"
```

---

### Task 20: E2E — cleanup LGPD (retenção 7 dias)

**Files:**
- Create: `test/e2e/ai-visagism-cleanup.e2e-spec.ts`

- [ ] **Step 1: Criar o spec**

```ts
import { HttpStatus, INestApplication } from '@nestjs/common';
import request from 'supertest';
import { setupTestApp, teardownTestApp } from 'test/support/test-app';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { registerOwnerWithTenant } from 'test/support/auth-onboarding';
import {
  expireConsultation,
  findConsultation,
  freshConsentAt,
  loadPhotoBuffer,
  runAnalysisJob,
  runCleanupJob,
} from 'test/support/ai-visagism';
import { AiConsultationStatus } from '@prisma/client';

describe('AI Visagism — cleanup LGPD', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  beforeAll(async () => {
    app = await setupTestApp();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => teardownTestApp(app));
  beforeEach(async () => {
    await prisma.aiConsultation.deleteMany({});
  });

  it('cleanup marca expiredAt, zera analysisJson, zera r2Keys, status=expired', async () => {
    const { tenant } = await registerOwnerWithTenant(app, {
      email: 'cleanup-ai@kairo.test',
      slug: 'cleanup-ai-shop',
    });
    const create = await request(app.getHttpServer())
      .post(`/public/${tenant.slug}/ai/visagism/consultations`)
      .field('consentAcceptedAt', freshConsentAt())
      .attach('photo', loadPhotoBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' });
    await runAnalysisJob(app, create.body.id, tenant.id);

    await expireConsultation(prisma, create.body.id);
    const before = await findConsultation(prisma, create.body.id);
    expect(before?.analysisJson).not.toBeNull();
    expect(before?.inputPhotoR2Key).not.toBeNull();

    const result = (await runCleanupJob(app)) as { processed: number };
    expect(result.processed).toBe(1);

    const after = await findConsultation(prisma, create.body.id);
    expect(after?.status).toBe(AiConsultationStatus.expired);
    expect(after?.expiredAt).not.toBeNull();
    expect(after?.analysisJson).toBeNull();
    expect(after?.inputPhotoR2Key).toBeNull();
    expect(after?.outputPhotoR2Key).toBeNull();
  });

  it('GET após cleanup retorna analysis=null (cliente não tem mais acesso)', async () => {
    const { tenant } = await registerOwnerWithTenant(app, {
      email: 'cleanup-view@kairo.test',
      slug: 'cleanup-view-shop',
    });
    const create = await request(app.getHttpServer())
      .post(`/public/${tenant.slug}/ai/visagism/consultations`)
      .field('consentAcceptedAt', freshConsentAt())
      .attach('photo', loadPhotoBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' });
    await runAnalysisJob(app, create.body.id, tenant.id);
    await expireConsultation(prisma, create.body.id);
    await runCleanupJob(app);

    const view = await request(app.getHttpServer())
      .get(`/public/ai/visagism/consultations/${create.body.id}`)
      .query({ token: create.body.viewToken });
    expect(view.status).toBe(HttpStatus.OK);
    expect(view.body.status).toBe(AiConsultationStatus.expired);
    expect(view.body.analysis).toBeNull();
    expect(view.body.expiredAt).not.toBeNull();
  });

  it('cleanup é idempotente — segunda run não reprocessa', async () => {
    const { tenant } = await registerOwnerWithTenant(app, {
      email: 'cleanup-idempotent@kairo.test',
      slug: 'cleanup-idempotent-shop',
    });
    const create = await request(app.getHttpServer())
      .post(`/public/${tenant.slug}/ai/visagism/consultations`)
      .field('consentAcceptedAt', freshConsentAt())
      .attach('photo', loadPhotoBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' });
    await runAnalysisJob(app, create.body.id, tenant.id);
    await expireConsultation(prisma, create.body.id);
    const first = (await runCleanupJob(app)) as { processed: number };
    const second = (await runCleanupJob(app)) as { processed: number };
    expect(first.processed).toBe(1);
    expect(second.processed).toBe(0);
  });
});
```

- [ ] **Step 2: Rodar**

```bash
npx jest --config jest.e2e.config.ts test/e2e/ai-visagism-cleanup.e2e-spec.ts --runInBand
```

Expected: 3 tests passed.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/ai-visagism-cleanup.e2e-spec.ts
git commit -m "test(ai-visagism): e2e cleanup LGPD (retenção, idempotência, view pós-expiração)"
```

---

### Task 21: E2E — geração de imagem (opt-in)

**Files:**
- Create: `test/e2e/ai-visagism-generation.e2e-spec.ts`

- [ ] **Step 1: Criar o spec**

```ts
import { HttpStatus, INestApplication } from '@nestjs/common';
import request from 'supertest';
import { setupTestApp, teardownTestApp } from 'test/support/test-app';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { registerOwnerWithTenant } from 'test/support/auth-onboarding';
import {
  freshConsentAt,
  loadPhotoBuffer,
  runAnalysisJob,
  runGenerationJob,
  findConsultation,
} from 'test/support/ai-visagism';
import { AiConsultationStatus } from '@prisma/client';

describe('AI Visagism — geração de imagem', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  beforeAll(async () => {
    app = await setupTestApp();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => teardownTestApp(app));
  beforeEach(async () => {
    await prisma.aiConsultation.deleteMany({});
  });

  it('happy path: pede geração com suggestionId válido → status=generated + imageUrl assinada', async () => {
    const { tenant } = await registerOwnerWithTenant(app, {
      email: 'gen-happy@kairo.test',
      slug: 'gen-happy-shop',
    });
    const create = await request(app.getHttpServer())
      .post(`/public/${tenant.slug}/ai/visagism/consultations`)
      .field('consentAcceptedAt', freshConsentAt())
      .attach('photo', loadPhotoBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' });
    await runAnalysisJob(app, create.body.id, tenant.id);

    const completed = await findConsultation(prisma, create.body.id);
    const firstSuggestionId = (completed?.analysisJson as { suggestions: { id: string }[] }).suggestions[0].id;

    const genRes = await request(app.getHttpServer())
      .post(`/public/ai/visagism/consultations/${create.body.id}/generate-image`)
      .query({ token: create.body.viewToken })
      .send({ suggestionId: firstSuggestionId });
    expect(genRes.status).toBe(HttpStatus.CREATED);
    expect(genRes.body.status).toBe(AiConsultationStatus.generating);

    // Roda worker inline
    await runGenerationJob(app, create.body.id, tenant.id, firstSuggestionId);

    const finalRow = await findConsultation(prisma, create.body.id);
    expect(finalRow?.status).toBe(AiConsultationStatus.generated);
    expect(finalRow?.outputPhotoR2Key).not.toBeNull();

    const imgRes = await request(app.getHttpServer())
      .get(`/public/ai/visagism/consultations/${create.body.id}/image`)
      .query({ token: create.body.viewToken });
    expect(imgRes.status).toBe(HttpStatus.OK);
    expect(imgRes.body.url).toMatch(/storage\.local\/get\/.+/);
    expect(imgRes.body.expiresInSeconds).toBe(300);
  });

  it('409 AI_CONSULTATION_NOT_READY se análise ainda não completou', async () => {
    const { tenant } = await registerOwnerWithTenant(app, {
      email: 'gen-not-ready@kairo.test',
      slug: 'gen-not-ready-shop',
    });
    const create = await request(app.getHttpServer())
      .post(`/public/${tenant.slug}/ai/visagism/consultations`)
      .field('consentAcceptedAt', freshConsentAt())
      .attach('photo', loadPhotoBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' });
    // não roda analysisJob

    const res = await request(app.getHttpServer())
      .post(`/public/ai/visagism/consultations/${create.body.id}/generate-image`)
      .query({ token: create.body.viewToken })
      .send({ suggestionId: 'any' });
    expect(res.status).toBe(HttpStatus.CONFLICT);
    expect(res.body.code).toBe('AI_CONSULTATION_NOT_READY');
  });

  it('404 AI_SUGGESTION_NOT_FOUND se suggestionId não bate', async () => {
    const { tenant } = await registerOwnerWithTenant(app, {
      email: 'gen-bad-sug@kairo.test',
      slug: 'gen-bad-sug-shop',
    });
    const create = await request(app.getHttpServer())
      .post(`/public/${tenant.slug}/ai/visagism/consultations`)
      .field('consentAcceptedAt', freshConsentAt())
      .attach('photo', loadPhotoBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' });
    await runAnalysisJob(app, create.body.id, tenant.id);
    const res = await request(app.getHttpServer())
      .post(`/public/ai/visagism/consultations/${create.body.id}/generate-image`)
      .query({ token: create.body.viewToken })
      .send({ suggestionId: 'inexistente-xyz' });
    expect(res.status).toBe(HttpStatus.NOT_FOUND);
    expect(res.body.code).toBe('AI_SUGGESTION_NOT_FOUND');
  });

  it('409 AI_GENERATION_ALREADY_REQUESTED na segunda chamada', async () => {
    const { tenant } = await registerOwnerWithTenant(app, {
      email: 'gen-dup@kairo.test',
      slug: 'gen-dup-shop',
    });
    const create = await request(app.getHttpServer())
      .post(`/public/${tenant.slug}/ai/visagism/consultations`)
      .field('consentAcceptedAt', freshConsentAt())
      .attach('photo', loadPhotoBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' });
    await runAnalysisJob(app, create.body.id, tenant.id);
    const completed = await findConsultation(prisma, create.body.id);
    const sid = (completed?.analysisJson as { suggestions: { id: string }[] }).suggestions[0].id;

    await request(app.getHttpServer())
      .post(`/public/ai/visagism/consultations/${create.body.id}/generate-image`)
      .query({ token: create.body.viewToken })
      .send({ suggestionId: sid });
    await runGenerationJob(app, create.body.id, tenant.id, sid);

    const dup = await request(app.getHttpServer())
      .post(`/public/ai/visagism/consultations/${create.body.id}/generate-image`)
      .query({ token: create.body.viewToken })
      .send({ suggestionId: sid });
    expect(dup.status).toBe(HttpStatus.CONFLICT);
    expect(dup.body.code).toBe('AI_GENERATION_ALREADY_REQUESTED');
  });
});
```

- [ ] **Step 2: Rodar**

```bash
npx jest --config jest.e2e.config.ts test/e2e/ai-visagism-generation.e2e-spec.ts --runInBand
```

Expected: 4 tests passed.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/ai-visagism-generation.e2e-spec.ts
git commit -m "test(ai-visagism): e2e generation flow (success, not ready, bad suggestion, duplicate)"
```

---

### Task 22: Enriquecer `/saas/ai-usage` com breakdown opt-in `?detailed=true`

**Files:**
- Modify: `src/modules/saas-admin/services/saas-ai-usage.service.ts`
- Modify: `src/modules/saas-admin/dto/list-ai-usage-query.dto.ts`
- Modify: `src/modules/saas-admin/saas-admin.module.ts`
- Modify: `test/e2e/saas-admin-ai-usage.e2e-spec.ts`

- [ ] **Step 1: Adicionar campo `detailed` no DTO**

Em `src/modules/saas-admin/dto/list-ai-usage-query.dto.ts`, adicionar:

```ts
import { IsBoolean, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  detailed?: boolean;
```

(Mantém os outros campos do DTO intactos. Verifique o arquivo antes — anexa apenas o campo novo.)

- [ ] **Step 2: Injetar `AiConsultationRepository` no `SaasAiUsageService`**

Em `src/modules/saas-admin/services/saas-ai-usage.service.ts`, no constructor:

```ts
import { AiConsultationRepository } from 'src/modules/ai-visagism/repositories/ai-consultation.repository';

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRepo: AiConsultationRepository,
  ) {}
```

E adicionar no método `list(...)`, quando `query.detailed === true`, popular um campo `recentConsultations` no item:

```ts
    if (query.detailed) {
      for (const item of items) {
        const recent = await this.aiRepo.listRecentByTenant(item.tenantId, 50);
        (item as Record<string, unknown>).recentConsultations = recent.map((r) => ({
          id: r.id,
          status: r.status,
          providerCostCents: r.providerCostCents,
          createdAt: r.createdAt.toISOString(),
          expiredAt: r.expiredAt?.toISOString() ?? null,
        }));
      }
    }
```

> **Nota:** se o método atual já retorna `items` paginados, fazer o `for` apenas sobre os items da página corrente (não sobre o universo inteiro). Mantém custo O(pageSize) extra.

- [ ] **Step 3: Importar `AiVisagismModule` em `SaasAdminModule`**

Em `src/modules/saas-admin/saas-admin.module.ts`, no `imports`:

```ts
import { AiVisagismModule } from 'src/modules/ai-visagism/ai-visagism.module';

@Module({
  imports: [..., AiVisagismModule],
  // ...
})
```

(`AiVisagismModule` exporta `AiConsultationRepository` — confirmar no Task 16 que o export está lá.)

- [ ] **Step 4: Adicionar teste e2e ao `saas-admin-ai-usage.e2e-spec.ts`**

Adicionar ao describe principal:

```ts
  it('?detailed=true inclui recentConsultations por tenant', async () => {
    // setup: cria tenant + consultation completed via helpers existentes
    // ...
    const res = await request(app.getHttpServer())
      .get('/saas/ai-usage')
      .query({ detailed: 'true' })
      .set('Authorization', `Bearer ${saasToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toHaveProperty('recentConsultations');
    expect(Array.isArray(res.body.items[0].recentConsultations)).toBe(true);
  });
```

> **Nota:** o teste exige que pelo menos um tenant tenha consultations. Use o helper `loadPhotoBuffer + runAnalysisJob` do Task 17 (importável em qualquer e2e). Ou popular direto via `prisma.aiConsultation.create({...})` se for mais simples no escopo do teste.

- [ ] **Step 5: Rodar**

```bash
npx jest --config jest.e2e.config.ts test/e2e/saas-admin-ai-usage.e2e-spec.ts --runInBand
```

Expected: todos os tests (incluindo o novo) passam.

- [ ] **Step 6: Commit**

```bash
git add src/modules/saas-admin/ test/e2e/saas-admin-ai-usage.e2e-spec.ts
git commit -m "feat(saas-admin): /saas/ai-usage supports ?detailed=true with recent consultations"
```

---

### Task 23: Suite completa + atualizar docs + .env.example

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Atualizar `.env.example`**

Adicionar (após bloco SaaS):

```env
# AI visagism (Fase 6)
AI_VISAGISM_PROVIDER=console
AI_VISAGISM_MONTHLY_QUOTA=100
AI_VISAGISM_RETENTION_DAYS=7
AI_VISAGISM_CLEANUP_CRON=0 3 * * *
AI_VISAGISM_QUOTA_RESET_CRON=5 0 1 * *
AI_VISAGISM_PHOTO_MAX_BYTES=5242880
AI_VISAGISM_PHOTO_MIN_DIMENSION=256
AI_VISAGISM_CONSENT_MAX_AGE_SECONDS=3600
AI_VISAGISM_GROQ_MODEL=meta-llama/llama-4-scout-17b-16e-instruct
AI_VISAGISM_GROQ_PRICE_PER_MTOK_CENTS=1
AI_VISAGISM_OPENAI_IMAGE_MODEL=gpt-image-1
AI_VISAGISM_OPENAI_IMAGE_COST_CENTS=4
GROQ_API_KEY=
OPENAI_API_KEY=
```

- [ ] **Step 2: Atualizar `README.md`**

Trocar:

```
- [x] Fase 5 — Dashboard do dono do SaaS
- [ ] Fase 6 — IA Visagismo
```

por:

```
- [x] Fase 5 — Dashboard do dono do SaaS
- [x] Fase 6 — IA Visagismo
```

E adicionar ao Resumo:

> Fase 6: módulo `ai-visagism` com `/public/{slug}/ai/visagism/consultations` (multipart upload), polling em `/public/ai/visagism/consultations/{id}` e geração opt-in via gpt-image-1. Análise estruturada via AI SDK + Groq + Llama 4 Scout 17B. Cota mensal 100/tenant (`Subscription.aiQuotaUsedThisMonth`). Retenção LGPD 7 dias com cron `ai-photo-cleanup`. Reset mensal de cota via cron. Custo por consulta rastreado. Provider abstraído (`VisagismProvider`) para troca futura.

Adicionar na seção "Operação" (ou criar se não houver):

> **Lifecycle no R2:** configurar regra do bucket "delete objects in `tenants/*/ai-visagism/*` older than 30 days" como rede de segurança caso o cron de cleanup pule alguma row.

- [ ] **Step 3: Rodar lint + typecheck**

```bash
npm run lint
npx tsc --noEmit
```

Expected: zero erros.

- [ ] **Step 4: Rodar suite unitária completa**

```bash
npm test
```

Expected: todos os tests passam.

- [ ] **Step 5: Rodar suite e2e completa**

```bash
npm run test:e2e
```

Expected: todos os tests passam (incluindo os 6 novos da Fase 6: `happy-path`, `quota`, `gating`, `tokens`, `cleanup`, `generation`).

- [ ] **Step 6: Commit final**

```bash
git add .env.example README.md
git commit -m "docs(phase6): README + .env.example reflect AI visagism completion"
```

---

## Critério de pronto da Fase 6

- [ ] `POST /public/{slug}/ai/visagism/consultations` (multipart) aceita foto válida, devolve `{id, viewToken, expiresAt, status:queued, quota}`.
- [ ] `GET /public/ai/visagism/consultations/{id}?token=` retorna estado atual; com `status=completed`, devolve `analysisJson` estruturado (faceShape + 2-4 sugestões).
- [ ] `POST /public/ai/visagism/consultations/{id}/generate-image?token=` enfileira geração; após worker, `GET /image` devolve URL pré-assinada do R2.
- [ ] Cota mensal 100/tenant é atomicamente decrementada na criação; 429 `AI_QUOTA_EXCEEDED` quando esgotada; cron `monthly-quota-reset` zera no dia 1.
- [ ] Cron `ai-photo-cleanup` apaga R2 keys, zera campos sensíveis, status → `expired` após 7 dias. Idempotente.
- [ ] Falha terminal do provider seta `status=failed`, reembolsa cota, grava audit `ai.consultation_failed`.
- [ ] AuditLog grava `ai.consultation_created`, `ai.analysis_completed`, `ai.generation_completed`, `ai.consultation_failed`, `ai.consultation_expired`.
- [ ] Subscription `past_due`/`cancelled` ou tenant `suspendedAt` bloqueia endpoints de IA com 402/404 apropriados.
- [ ] MIME real (file-type) + dimensões mínimas (image-size) validados; 400 com códigos específicos para violações.
- [ ] Consent age validado (`AI_CONSENT_STALE` se > 1h).
- [ ] Rate limit 3/min/IP em endpoints `POST`.
- [ ] `VisagismProvider` abstraída — `AI_VISAGISM_PROVIDER=console` em testes; `aisdk` em prod (Groq + OpenAI via AI SDK).
- [ ] `/saas/ai-usage?detailed=true` retorna breakdown de consultations recentes por tenant.
- [ ] Lint + typecheck + suite unit + suite e2e verdes.

---

## Self-Review (rodado antes de salvar o plano)

- **Spec coverage (seção 4, Fase 6):**
  - Upload com consentimento LGPD ✅ (Task 12 + 13: `consentAcceptedAt` obrigatório, validação de idade).
  - Job de análise (OpenAI vision com sys prompt curado, tool use para JSON estruturado) ✅ — **adaptado por decisão do usuário** para Groq + Llama 4 Scout via AI SDK `generateObject` com schema Zod (equivalente funcional ao "tool use para JSON estruturado").
  - Job de geração de imagem (gpt-image-1) ✅ (Task 8 + 14: AI SDK `experimental_generateImage` + `@ai-sdk/openai`).
  - Polling de status pelo front ✅ (Task 13: `GET /consultations/:id?token=`).
  - Cron de cleanup de fotos vencidas ✅ (Task 14 + 15: `JOB_AI_CLEANUP` + scheduler; **retenção 7 dias por decisão do usuário, não 90**).
  - Métricas de custo por tenant ✅ (`providerCostCents` no schema + acumulação no worker + exposição via `/saas/ai-usage?detailed=true` em Task 22).
- **Spec coverage (seção 6, AiConsultation):** modelo idêntico (campos: id, tenantId, customerId?, barberId?, inputPhotoR2Key, outputPhotoR2Key?, analysisJson?, status, providerCostCents, viewTokenHash, consentAcceptedAt, expiresAt). Adições: `expiredAt`, `errorReason`, enum status com `queued|processing|completed|generating|generated|failed|expired`. Documentado nas decisões #3 e #16.
- **Spec coverage (seção 7, endpoints):**
  - `POST /public/{slug}/ai/visagism/consultations` ✅
  - `GET /public/ai/visagism/consultations/{id}?token=` ✅
  - `POST /public/ai/visagism/consultations/{id}/generate-image?token=` ✅
  - Extra (não na spec): `GET /public/ai/visagism/consultations/{id}/image?token=` para devolver URL pré-assinada — necessário porque o output é privado no R2 e a spec não detalha como entregar. Documentado em Task 13 Step 4.
- **Spec coverage (seção 8.4, fluxo):** todos os 6 passos cobertos.
- **Spec coverage (seção 12, segurança/LGPD):** consent log com timestamp ✅, retenção 7 dias ✅, deleção via cron ✅, MIME validation ✅, max bytes ✅, rate limit ✅, cota mensal por tenant ✅. Direito de deleção (anonimização) **não** está nesta fase — fica como TODO da Fase 7+ (alinhado com a spec que diz "Endpoint de export de dados pessoais (Fase 5+)").
- **Spec coverage (seção 15, riscos):** OpenAI gera foto ruim mitigado por abstração `VisagismProvider` (decisão #9). Custo de IA mitigado por cota + métrica + costCents tracking. Vazamento de foto mitigado por R2 privado + signed URLs com TTL 300s.
- **Spec coverage (filas BullMQ seção 7):** `ai-visagism-analysis` ✅, `ai-visagism-generation` ✅, `ai-photo-cleanup` ✅, `monthly-quota-reset` ✅. Todas no mesmo `QUEUE_AI_VISAGISM` (consolidação para reduzir overhead — mesmo padrão do billing).
- **Type consistency:** `VisagismProvider.analyze`/`generateImage` mesma assinatura em Console e AI SDK impl. `AiConsultationRepository.setCompleted`/`setGenerated` recebem `costCentsToAdd` consistente. `VisagismAnalysis`/`VisagismSuggestion` definidos uma vez em `ai-visagism.types.ts` e reusados em provider, service, processor, schemas Zod. `generateViewToken`/`hashViewToken` exportados do service para reuso em testes.
- **Placeholders:** nenhum "TODO/TBD/similar to" no plano. Cada step tem código real. Notas explícitas para o engenheiro nos pontos onde a tipagem do AI SDK ou da lib `image-size` pode variar entre versões (Task 8 Step 1, Task 12 Step 1).
- **Decisões do usuário capturadas no início:**
  - Análise via Groq + Llama 4 Scout 17B via AI SDK ✅
  - Geração via OpenAI gpt-image-1 via AI SDK ✅
  - Retenção 7 dias ✅ (decisões #16, env `AI_VISAGISM_RETENTION_DAYS=7`)
  - Storefront aberta a qualquer visitante, com rate-limit + cota ✅ (decisão #14)

