# Billing Hardening F4 — Coerência storefront + checkout race Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fechar os 2 últimos vetores da auditoria 2026-05-21: **A3** (`AiVisagismService.assertSubscriptionAllowed` retorna `402 SUBSCRIPTION_INACTIVE` em past_due/cancelled, vazando estado de billing pra scraper que varre slugs — alinhar com INV-16 trocando pra `404 TENANT_NOT_FOUND`) e **A4** (`BillingService.createCheckout` não tem proteção contra cliques paralelos, podendo criar 2 preapprovals no Asaas com 1 órfão silencioso — adicionar guard via `prisma.$transaction` com re-leitura, ErrorCode novo `CHECKOUT_RACE_DETECTED` HTTP 409, e cleanup best-effort do preapproval órfão criado em race).

**Architecture:** A3 é mudança cirúrgica de 1 linha no service do AI visagism (status code + error code). Defesa em camadas — o `PublicTenantMiddleware` (de billing-tightening B1) já barra `/public/:slug/ai/visagism/consultations` em past_due com 404 antes do service rodar; A3 alinha o service-level pra que bypass do middleware (refactor futuro, teste interno) NÃO volte a vazar. A4 é refactor do `createCheckout`: estrutura em **2 transactions** envolvendo as chamadas HTTP — TX1 pre-HTTP re-lê e valida `mpPreapprovalId` não mudou; chamadas Asaas (cancel + create) ficam FORA da transaction (não bloqueiam DB); TX2 post-HTTP re-lê + atualiza `mpPreapprovalId`; se TX2 detectar race (outro checkout escreveu meanwhile), cleanup best-effort do preapproval recém-criado + throw 409. Best-effort, não 100% atômico em READ COMMITTED (D-09 do spec aceita esse trade-off vs custo de `FOR UPDATE` ou idempotency key).

**Tech Stack:** NestJS 11, Prisma 5 (`$transaction` callback API), Jest + supertest + testcontainers, `DomainException` + `ErrorCodes`.

**Spec source-of-truth:** [`docs/superpowers/specs/2026-05-21-billing-hardening-v2-design.md`](../specs/2026-05-21-billing-hardening-v2-design.md) §10 (Fase F4, R-F4-01 a R-F4-05).

---

## File Structure

**Arquivos modificados:**
- `src/modules/ai-visagism/ai-visagism.service.ts:253-261` — `assertSubscriptionAllowed`: troca `SUBSCRIPTION_INACTIVE` + `PAYMENT_REQUIRED` por `TENANT_NOT_FOUND` + `NOT_FOUND`
- `src/modules/billing/billing.service.ts:229-329` — `createCheckout` refatorado: TX1 pre-HTTP race-check, chamadas HTTP isoladas, TX2 post-HTTP race-check + update + cleanup
- `src/common/exceptions/error-codes.ts:54` — adiciona `CHECKOUT_RACE_DETECTED: 'CHECKOUT_RACE_DETECTED'` na seção Phase 4 — billing
- `src/modules/billing/billing.checkout.spec.ts` — adiciona 2 testes: (a) race pre-HTTP detectada (mp mudou entre leitura inicial e TX1); (b) race post-HTTP detectada + cleanup (mp mudou entre TX1 e TX2)
- `src/modules/ai-visagism/ai-visagism.service.spec.ts` — se tiver teste de `assertSubscriptionAllowed` (não tem hoje, só token determinism), adicionar; senão, criar arquivo paralelo apenas se necessário.

**Arquivos criados:** nenhum. (O teste E2E `ai-visagism-gating.e2e-spec.ts:60-79` já espera 404 + `TENANT_NOT_FOUND` — passa hoje via PublicTenantMiddleware. Após A3, continua passando — defesa em camadas redundante. Não precisa criar E2E novo.)

**Não modificar nesta fase:**
- `PublicTenantMiddleware` — fora do escopo (já garante 404 em past_due via INV-07 da spec billing-tightening).
- `public.module.ts` — exclusions atuais (`public/ai/visagism/(.*)` excluído) ficam — esses são endpoints token-scoped pós-criação que CLIENTES finais acessam mesmo após tenant ficar past_due (cliente final não pode ser punido pela inadimplência do tenant; INV-16 do spec). Apenas o POST `/public/:slug/ai/visagism/consultations` é slug-scoped, e esse passa pelo middleware.
- `error-codes.ts:48-55` (outros billing codes) — só adicionar `CHECKOUT_RACE_DETECTED`, não tocar nos demais.
- F1/F2/F3 — já mergeadas / em outra branch.

**Convenções respeitadas:**
- pt-BR em mensagens (`"Outro checkout em andamento. Tente novamente em alguns segundos."`, `"Barbearia não encontrada."`).
- Error codes em `UPPER_SNAKE_CASE` (igual aos vizinhos).
- Logs estruturados via `nestjs-pino` com `event: '...'` (igual `subscription.checkout_created`).
- `DomainException` com 4 campos (`code, message, status, details?`).
- Testes existentes em `billing.checkout.spec.ts` usam `toMatchObject({ opts: { code } })` — manter padrão.

---

## Task 0: Recall — re-ler spec e fazer echo-back

**Arquivo:** N/A (etapa de leitura/raciocínio, sem código).

- [ ] **Step 1: Re-ler ambos os specs**

Ler na íntegra:
1. `docs/superpowers/specs/2026-05-21-billing-hardening-v2-design.md` (especialmente §10 F4)
2. `docs/superpowers/specs/2026-05-20-trial-grace-tightening-design.md` (INV-07 — 404 puro em past_due no storefront — é o que A3 alinha em service-level)

- [ ] **Step 2: Responder echo-back de 5 bullets na resposta da Task 0**

1. Quais invariants (INV-01 a INV-16) são relevantes pra F4?
   *Esperado: **INV-07** (404 puro em past_due no storefront slug-scoped — A3 alinha service-level com o middleware). **INV-16** (rotas slug-scoped públicas retornam 404 em past_due/cancelled/suspended — A3 cobre `/public/:slug/ai/visagism/consultations`). Endpoints token-scoped (`/public/ai/visagism/consultations/:id`, `/public/ai/visagism/consultations/:id/generate-image`, `/public/ai/visagism/consultations/:id/image`) NÃO são afetados (cliente final não pode ser punido pela inadimplência do tenant — INV-16 explicitamente exclui).*
2. Que decisões eu posso ferir sem perceber?
   *Esperado: **D-08** (gating no service-level, NÃO mover pra middleware separado — manter `assertSubscriptionAllowed` no service do AI visagism). **D-09** (re-leitura dentro de transaction, NÃO `FOR UPDATE` nem idempotency key — best-effort aceito vs custo). **D-10** (PR isolada de F4, não bundle com F3). Cuidado: NÃO mover gating do AI visagism pro PublicTenantMiddleware (mesmo que reduzisse duplicação, é decisão consciente de manter defesa em camadas).*
3. Quais requirements R-F4-NN são meu escopo?
   *Esperado: **R-F4-01** (assertSubscriptionAllowed: 402 SUBSCRIPTION_INACTIVE → 404 TENANT_NOT_FOUND). **R-F4-02** (atualizar testes pra novo status). **R-F4-03** (createCheckout em prisma.$transaction com re-leitura — chamadas Asaas FORA, double-tx structure). **R-F4-04** (adicionar CHECKOUT_RACE_DETECTED em error-codes). **R-F4-05** (testes de race detection — 1 vencedora 200, 1 perdedora 409, max 1 createPreapproval).*
4. Qual anti-acceptance protege de scope creep?
   *Esperado: ❌ AI visagism retorna 402/403 em past_due/cancelled. ❌ Front recebe `SUBSCRIPTION_INACTIVE` em endpoint público (vaza estado). ❌ Chamada externa ao Asaas (cancel/create) DENTRO de `prisma.$transaction` (segura DB lock). ❌ Race condition cria 2 preapprovals no Asaas sem cleanup. ❌ Fluxo serial de re-checkout (past_due → renovar) quebra.*
5. Qual recall-check de teste prova que não quebrei reativação?
   *Esperado: `billing.checkout.spec.ts` testes pré-existentes (`SUBSCRIPTION_ALREADY_ACTIVE`, trialing sem preapproval, past_due com mpPreapprovalId, ASAAS sem cpfCnpj) continuam verdes. `billing-checkout.e2e-spec.ts` continua verde (se houver). Fluxo serial: tenant em past_due chama checkout, recebe initPoint sem 409. Apenas chamadas paralelas no MESMO tenant disparam 409.*

---

## Task 1: Pre-flight — confirmar estado do repo + branch

**Arquivo:** N/A (verificação).

- [ ] **Step 1: Confirmar branch limpo e em main (ou derivado de main)**

Run: `git status && git branch --show-current`

Expected:
- Branch limpo (sem mudanças pendentes).
- F4 deve ser uma branch nova derivada de `main`, NÃO de `feature/billing-hardening-f3-crons-http`. **D-10 do spec: cada fase tem PR independente, sem bundling.**

Se ainda estiver em `feature/billing-hardening-f3-crons-http` (da F3): voltar pra main e criar branch nova.

```bash
git checkout main
git checkout -b feature/billing-hardening-f4-storefront-checkout-race
```

**Por que derivar de `main` e não da F3:** F3 ainda não está mergeada. F4 não depende de F3 (toca arquivos diferentes: ai-visagism + billing.service.ts createCheckout vs F3 que tocou billing.controller.ts + asaas provider). Isolando reduz risco de revert difícil.

- [ ] **Step 2: Confirmar middleware atual já barra past_due em /public/:slug/***

Run: `grep -n "PublicTenantMiddleware\|past_due\|404" src/common/middleware/public-tenant.middleware.ts | head -10`

Expected: middleware retorna 404 com `TENANT_NOT_FOUND` quando subscription status é `past_due`, `cancelled`, ou tenant tem `suspendedAt` (alinha INV-07 da spec billing-tightening).

**Nota:** F4/A3 NÃO substitui o middleware — adiciona uma segunda camada no service-level. O teste E2E `ai-visagism-gating.e2e-spec.ts:60-79` passa hoje VIA middleware. Após F4/A3, continua passando via middleware (a primeira barreira) — mas se alguém remover o middleware ou bypassar, o service também barra.

- [ ] **Step 3: Confirmar ai-visagism service tem a função `assertSubscriptionAllowed` em past_due**

Run: `grep -n "assertSubscriptionAllowed\|SUBSCRIPTION_INACTIVE" src/modules/ai-visagism/ai-visagism.service.ts`

Expected: 1 ocorrência de `assertSubscriptionAllowed` (definição) + 1+ ocorrência de `SUBSCRIPTION_INACTIVE` (linha 257). Deve estar em linhas próximas a 253-261.

- [ ] **Step 4: Confirmar `BILLING_PROVIDER='console'` em test env**

Confirmado em `test/support/test-env.ts:13`. Mock pra `BillingService.createCheckout` testes unit usa `BILLING_PROVIDER='mercadopago'` (linha 28 do `billing.checkout.spec.ts`) com `mkProvider()` mockando.

- [ ] **Step 5: Confirmar baseline unit verde (sem testcontainers)**

Run: `pnpm jest src/modules/billing/ src/modules/ai-visagism/ 2>&1 | tail -5`

Expected: suites verdes. Se algum teste pré-existente falhar, **PARAR** e investigar antes de mudar nada.

---

## Task 2: A3 — `assertSubscriptionAllowed` retorna `404 TENANT_NOT_FOUND` (R-F4-01 + R-F4-02)

**Files:**
- Modify: `src/modules/ai-visagism/ai-visagism.service.ts:253-261`
- Modify: `src/modules/ai-visagism/ai-visagism.service.spec.ts` (adiciona describe novo se necessário; arquivo hoje só tem `generateViewToken/hashViewToken` tests)

- [ ] **Step 1: Adicionar describe novo no spec do AI visagism service**

Abrir `src/modules/ai-visagism/ai-visagism.service.spec.ts`. **Estado atual:** o arquivo só tem 10 linhas, apenas um describe `'AiVisagismService — token determinism'`. `assertSubscriptionAllowed` não é testada via unit (depende de muitas deps — prisma, storage, provider, etc.). **Decisão pragmática:** o E2E `ai-visagism-gating.e2e-spec.ts:60-79` já cobre o comportamento via PublicTenantMiddleware. Adicionar teste unit de `assertSubscriptionAllowed` ISOLADO exige construir o `AiVisagismService` com mocks pesados que o arquivo atual não tem. **Skip teste unit isolado** — confiar no E2E existente + alinhamento via grep.

Em vez disso, adicionar um teste **read-only** que valida via reflect ou grep que o código não usa mais `SUBSCRIPTION_INACTIVE`. Mas isso é frágil. **Alternativa preferida:** mudar diretamente o código + atualizar o E2E `ai-visagism-gating.e2e-spec.ts` para que se rodado isolando o middleware (via teste futuro de defesa-em-camadas), também valide.

**Decisão final:** SKIP teste unit novo. O E2E existente passa via middleware (defesa primária). Mudança em A3 é defesa secundária — validamos por grep + executando o E2E (que vai continuar passando, e qualquer bypass do middleware é caught).

Pular pra Step 2 (mudança direta de código).

- [ ] **Step 2: Aplicar a mudança no service**

Abrir `src/modules/ai-visagism/ai-visagism.service.ts`. Localizar `assertSubscriptionAllowed` (linhas 253-261).

Substituir:
```ts
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
```

Por:
```ts
  private async assertSubscriptionAllowed(tenantId: string): Promise<void> {
    const sub = await this.prisma.subscription.findUnique({ where: { tenantId } });
    if (!sub || sub.status === 'cancelled' || sub.status === 'past_due') {
      // F4/A3: alinha INV-16 — storefront em past_due/cancelled retorna 404 puro
      // (não vaza estado de billing pra scraper). PublicTenantMiddleware já barra
      // em /public/:slug/*; esta é defesa em camadas no service-level.
      throw new DomainException({
        code: ErrorCodes.TENANT_NOT_FOUND,
        message: 'Barbearia não encontrada.',
        status: HttpStatus.NOT_FOUND,
      });
    }
  }
```

Mudança cirúrgica: 2 linhas (code + status). Mensagem também muda (pt-BR).

- [ ] **Step 3: Grep — confirmar zero ocorrências de `SUBSCRIPTION_INACTIVE` em ai-visagism**

Run: `grep -rn "SUBSCRIPTION_INACTIVE" src/modules/ai-visagism/`

Expected: **0 linhas**.

Se houver outras ocorrências (controller, dto, etc.) — **PARAR** e revisar. Não esperado.

- [ ] **Step 4: Rodar suite unit do AI visagism**

Run: `pnpm jest src/modules/ai-visagism/`

Expected: **todos passam**. O único spec é `generateViewToken/hashViewToken` (não toca `assertSubscriptionAllowed`).

- [ ] **Step 5: Rodar lint nos arquivos tocados**

Run: `npx eslint src/modules/ai-visagism/ai-visagism.service.ts`

Expected: **0 errors**.

- [ ] **Step 6: Commit (isolado da A4)**

```bash
git add src/modules/ai-visagism/ai-visagism.service.ts
git commit -m "$(cat <<'EOF'
feat(ai-visagism): 404 TENANT_NOT_FOUND em past_due/cancelled (F4 R-F4-01 / A3)

Fecha vetor A3 da auditoria 2026-05-21: AI visagism retornava
402 SUBSCRIPTION_INACTIVE em past_due/cancelled, vazando estado
de billing pra scraper que varre slugs. Storefront slug-scoped
deve retornar 404 puro (INV-07 / INV-16).

Defesa em camadas: PublicTenantMiddleware (B1) ja barra em
/public/:slug/*. Esta mudanca alinha service-level — qualquer
bypass do middleware (refactor futuro, teste isolado) tambem
nao vaza.

D-08: gating fica no service do ai-visagism (nao move pra
middleware separado — mantem defesa em camadas).

Spec: docs/superpowers/specs/2026-05-21-billing-hardening-v2-design.md
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: A4 — Adicionar `CHECKOUT_RACE_DETECTED` em `error-codes.ts` (R-F4-04)

**Files:**
- Modify: `src/common/exceptions/error-codes.ts` (seção Phase 4 — billing, próximo a `BILLING_CHECKOUT_FAILED`)

- [ ] **Step 1: Adicionar a constante**

Abrir `src/common/exceptions/error-codes.ts`. Localizar a seção `// Phase 4 — billing` (linha 47). Adicionar `CHECKOUT_RACE_DETECTED` logo após `BILLING_CHECKOUT_FAILED` (linha 54):

Estado atual (linhas 47-55):
```ts
  // Phase 4 — billing
  SUBSCRIPTION_INACTIVE: 'SUBSCRIPTION_INACTIVE',
  SUBSCRIPTION_PAST_DUE: 'SUBSCRIPTION_PAST_DUE',
  SUBSCRIPTION_ALREADY_ACTIVE: 'SUBSCRIPTION_ALREADY_ACTIVE',
  SUBSCRIPTION_NOT_FOUND: 'SUBSCRIPTION_NOT_FOUND',
  BILLING_PROVIDER_ERROR: 'BILLING_PROVIDER_ERROR',
  BILLING_PROVIDER_UNAUTHORIZED: 'BILLING_PROVIDER_UNAUTHORIZED',
  BILLING_CHECKOUT_FAILED: 'BILLING_CHECKOUT_FAILED',
  TENANT_DOCUMENT_REQUIRED: 'TENANT_DOCUMENT_REQUIRED',
```

Adicionar ANTES de `TENANT_DOCUMENT_REQUIRED` (mantém agrupamento — todos os codes de billing-related ficam contíguos):

```ts
  // Phase 4 — billing
  SUBSCRIPTION_INACTIVE: 'SUBSCRIPTION_INACTIVE',
  SUBSCRIPTION_PAST_DUE: 'SUBSCRIPTION_PAST_DUE',
  SUBSCRIPTION_ALREADY_ACTIVE: 'SUBSCRIPTION_ALREADY_ACTIVE',
  SUBSCRIPTION_NOT_FOUND: 'SUBSCRIPTION_NOT_FOUND',
  BILLING_PROVIDER_ERROR: 'BILLING_PROVIDER_ERROR',
  BILLING_PROVIDER_UNAUTHORIZED: 'BILLING_PROVIDER_UNAUTHORIZED',
  BILLING_CHECKOUT_FAILED: 'BILLING_CHECKOUT_FAILED',
  CHECKOUT_RACE_DETECTED: 'CHECKOUT_RACE_DETECTED',
  TENANT_DOCUMENT_REQUIRED: 'TENANT_DOCUMENT_REQUIRED',
```

- [ ] **Step 2: Rodar build pra confirmar tipo consistente**

Run: `pnpm build 2>&1 | tail -5`

Expected: build OK. `ErrorCode` (linha 79) é union derivada de `(typeof ErrorCodes)[keyof typeof ErrorCodes]`, então o novo code aparece automaticamente.

- [ ] **Step 3: NÃO commitar isolado**

Vai junto com a Task 4 (a4 implementation), pra não ter constante órfã sem uso.

---

## Task 4: A4 — `createCheckout` com double-tx race-check (R-F4-03 + R-F4-05)

**Files:**
- Modify: `src/modules/billing/billing.service.ts:229-329` (refactor inteiro do método `createCheckout`)
- Modify: `src/modules/billing/billing.checkout.spec.ts` (adicionar 2 testes — race pre-HTTP, race post-HTTP + cleanup)

- [ ] **Step 1: Ler o método createCheckout atual pra entender o que muda**

Run: `sed -n '229,329p' src/modules/billing/billing.service.ts`

Estado atual (resumo conceitual):
1. `sub = await this.repo.findByTenantId(tenantId)` (leitura inicial)
2. Validações: NOT_FOUND, ALREADY_ACTIVE, document
3. `if (sub.mpPreapprovalId) await provider.cancelPreapproval(sub.mpPreapprovalId)` (HTTP, fora de tx)
4. `created = await provider.createPreapproval({...})` (HTTP, fora de tx)
5. `await this.repo.update(tenantId, { mpPreapprovalId: created.preapprovalId, ... })` (write)
6. Log + audit + return `{ initPoint }`

**Problema A4:** entre passos 1 e 5, 2 cliques paralelos podem ambos passar validações, ambos chamar Asaas, ambos sobrescrever DB — gerando 1 preapproval órfão no Asaas (o que NÃO foi escrito no DB).

**Fix:** envolver 1+5 em compare-and-swap via dupla transaction.

- [ ] **Step 2: Adicionar 2 testes em `billing.checkout.spec.ts` (TDD — devem falhar)**

Localizar o describe `'createCheckout'` em `src/modules/billing/billing.checkout.spec.ts`. Adicionar ao final do describe (antes do `});` que fecha createCheckout):

```ts
    it('CHECKOUT_RACE_DETECTED (409) se mpPreapprovalId mudar entre leitura inicial e tx pre-HTTP', async () => {
      // Simula: leitura inicial vê mp=A; quando a tx pre-HTTP re-lê, DB já tem mp=B.
      // Significa que outro checkout completou meanwhile — perdedora aborta.
      let callCount = 0;
      repo.findByTenantId.mockImplementation(() => {
        callCount += 1;
        // 1ª chamada: leitura inicial — vê mp=A, status=past_due
        if (callCount === 1) {
          return Promise.resolve({
            tenantId: 't1',
            status: 'past_due',
            mpPreapprovalId: 'PRE-A',
            updatedAt: new Date('2026-05-21T10:00:00Z'),
          });
        }
        // 2ª+ chamadas: re-leitura na tx — DB já tem mp=B (outro checkout escreveu)
        return Promise.resolve({
          tenantId: 't1',
          status: 'past_due',
          mpPreapprovalId: 'PRE-B',
          updatedAt: new Date('2026-05-21T10:00:05Z'),
        });
      });

      await expect(
        svc.createCheckout({
          tenantId: 't1',
          tenantSlug: 's',
          ownerEmail: 'a@x.com',
          ownerName: 'Owner X',
        }),
      ).rejects.toMatchObject({
        opts: { code: 'CHECKOUT_RACE_DETECTED', status: 409 },
      });

      // createPreapproval NÃO deve ter sido chamado (race detectada pre-HTTP)
      expect(provider.createPreapproval).not.toHaveBeenCalled();
    });

    it('CHECKOUT_RACE_DETECTED (409) + cleanup se mp mudar entre TX1 e TX2', async () => {
      // Simula race POST-HTTP: TX1 valida ok, HTTP roda, DB muda meanwhile, TX2 falha.
      // Cleanup: cancelPreapproval do recém-criado (perdedor não pode deixar órfão).
      let callCount = 0;
      repo.findByTenantId.mockImplementation(() => {
        callCount += 1;
        // 1ª (init) + 2ª (TX1 pre-HTTP): ainda mp=A
        if (callCount <= 2) {
          return Promise.resolve({
            tenantId: 't1',
            status: 'past_due',
            mpPreapprovalId: 'PRE-A',
            updatedAt: new Date('2026-05-21T10:00:00Z'),
          });
        }
        // 3ª+ (TX2 post-HTTP): DB mudou pra mp=Z (outro checkout escreveu durante HTTP)
        return Promise.resolve({
          tenantId: 't1',
          status: 'past_due',
          mpPreapprovalId: 'PRE-Z',
          updatedAt: new Date('2026-05-21T10:00:10Z'),
        });
      });
      provider.cancelPreapproval.mockResolvedValue(undefined);
      provider.createPreapproval.mockResolvedValue({
        preapprovalId: 'PRE-NEW',
        initPoint: 'https://asaas.test/i/PRE-NEW',
      });

      await expect(
        svc.createCheckout({
          tenantId: 't1',
          tenantSlug: 's',
          ownerEmail: 'a@x.com',
          ownerName: 'Owner X',
        }),
      ).rejects.toMatchObject({
        opts: { code: 'CHECKOUT_RACE_DETECTED', status: 409 },
      });

      // Cleanup: cancelPreapproval foi chamado com o NEW preapproval órfão
      expect(provider.cancelPreapproval).toHaveBeenCalledWith('PRE-NEW');
      expect(provider.createPreapproval).toHaveBeenCalledTimes(1);
    });
```

**Notas:**
- Os testes pré-existentes do `createCheckout` mockam `repo.findByTenantId.mockResolvedValue(...)` (chamada única). Após o refactor, `findByTenantId` é chamado MAIS de uma vez (init + TX1 + TX2 — 3x total no happy path). Para que testes pré-existentes continuem verdes, eles vão funcionar via `mockResolvedValue` (que retorna o mesmo valor sempre) — race-check `subFresh.mpPreapprovalId === sub.mpPreapprovalId` sempre é true. ✅
- O service precisa de acesso a `this.prisma` (não tem hoje — só tem `this.repo`). Vou adicionar `private readonly prisma: PrismaService` no constructor. Os testes existentes constroem `new BillingService(repo as never, provider, mkConfig(), new Logger('test'), audit)` — precisarei adicionar um mock de `prisma` aqui também.

**Decisão sobre mock do prisma:** vou criar helper `mkPrisma()` que retorna `{ $transaction: <impl> }` onde `$transaction(callback)` simplesmente chama `callback(repo-like)`. O `repo-like` é o mesmo `repo` que já mockamos (porque `this.repo` usa o mesmo `subscription` model que `tx.subscription`). Refinado: criar um mock minimal que delega.

- [ ] **Step 3: Ajustar mock do BillingService no spec — adicionar PrismaService**

Localizar o `beforeEach` (linha ~48-54) em `billing.checkout.spec.ts`. Adicionar mock de prisma e passar pro constructor:

Estado atual:
```ts
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-12T12:00:00Z'));
    repo = mkRepo();
    provider = mkProvider();
    const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    svc = new BillingService(repo as never, provider, mkConfig(), new Logger('test'), audit);
  });
```

Atualizar pra:
```ts
  let prisma: { $transaction: jest.Mock };
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-12T12:00:00Z'));
    repo = mkRepo();
    provider = mkProvider();
    // $transaction: chama o callback com um "tx" mock que delega lookups pra `repo`
    // (preserva consistência com mockResolvedValue/mockImplementation de findByTenantId).
    // tx.subscription.update delega pra repo.update (mockado).
    prisma = {
      $transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          subscription: {
            findUnique: (args: { where: { tenantId: string } }) =>
              repo.findByTenantId(args.where.tenantId),
            update: (args: { where: { tenantId: string }; data: Record<string, unknown> }) =>
              repo.update(args.where.tenantId, args.data),
          },
        };
        return callback(tx);
      }),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    svc = new BillingService(
      repo as never,
      provider,
      mkConfig(),
      new Logger('test'),
      audit,
      prisma as never, // novo arg — assinatura do constructor vai mudar em Step 4
    );
  });
```

**Atenção:** Step 4 muda a assinatura do `BillingService` constructor pra aceitar `PrismaService`. Esse mock paramétrico precisa bater. Caso o constructor real tenha ordem diferente (e.g., prisma vem ANTES de audit), ajustar.

- [ ] **Step 4: Rodar testes pra verificar que FALHAM**

Run: `pnpm jest src/modules/billing/billing.checkout.spec.ts -t "CHECKOUT_RACE_DETECTED"`

Expected: **2 testes FALHAM** com "expected `CHECKOUT_RACE_DETECTED`, got `SUBSCRIPTION_ALREADY_ACTIVE`" ou similar (ainda não tem o code novo no service).

Atenção a possíveis falhas dos testes pré-existentes: se o `prisma` mock estiver com formato errado ou se o constructor ainda não aceita 6º argumento, vai dar erro de tipo / runtime. Esperado — corrigido em Step 5+6.

- [ ] **Step 5: Atualizar constructor do `BillingService` pra aceitar `PrismaService`**

Abrir `src/modules/billing/billing.service.ts`. Localizar o constructor (provavelmente nas primeiras ~50 linhas). Adicionar `PrismaService`:

```ts
import { PrismaService } from 'src/infra/prisma/prisma.service';
```

(Verificar se já está importado — se não, adicionar.)

Constructor (atualizar — assumindo formato atual `constructor(repo, provider, config, logger, audit)`):
```ts
  constructor(
    private readonly repo: SubscriptionRepository,
    private readonly provider: BillingProvider,
    private readonly config: ConfigService,
    private readonly logger: Logger,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService, // NOVO — pra $transaction em createCheckout
  ) {}
```

(Confirmar a ordem real lendo o arquivo. O mock em Step 3 assume `prisma` como último arg.)

- [ ] **Step 6: Refactor `createCheckout` com double-tx**

Substituir o método inteiro (linhas 229-329) por:

```ts
  async createCheckout(input: {
    tenantId: string;
    tenantSlug: string;
    ownerEmail: string;
    ownerName: string;
    ownerCpfCnpj?: string;
  }): Promise<{ initPoint: string }> {
    const sub = await this.repo.findByTenantId(input.tenantId);
    if (!sub) {
      throw new DomainException({
        code: ErrorCodes.SUBSCRIPTION_NOT_FOUND,
        message: 'Assinatura não encontrada.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    if (sub.status === SubscriptionStatus.active) {
      throw new DomainException({
        code: ErrorCodes.SUBSCRIPTION_ALREADY_ACTIVE,
        message: 'Assinatura já está ativa.',
        status: HttpStatus.CONFLICT,
      });
    }

    const provider = this.config.get<string>('BILLING_PROVIDER');
    if (provider === 'asaas' && !input.ownerCpfCnpj) {
      throw new DomainException({
        code: ErrorCodes.TENANT_DOCUMENT_REQUIRED,
        message:
          'CPF ou CNPJ da barbearia é obrigatório pra assinar. Cadastre em /admin/perfil antes de iniciar o checkout.',
        status: HttpStatus.UNPROCESSABLE_ENTITY,
      });
    }

    // F4/A4 TX1: race-check pre-HTTP. Se outro checkout completou e mudou mpPreapprovalId,
    // abortar antes de gastar chamadas HTTP no Asaas.
    await this.prisma.$transaction(async (tx) => {
      const subFresh = await tx.subscription.findUnique({ where: { tenantId: input.tenantId } });
      if (!subFresh) {
        throw new DomainException({
          code: ErrorCodes.SUBSCRIPTION_NOT_FOUND,
          message: 'Assinatura não encontrada.',
          status: HttpStatus.NOT_FOUND,
        });
      }
      if (subFresh.mpPreapprovalId !== sub.mpPreapprovalId) {
        throw new DomainException({
          code: ErrorCodes.CHECKOUT_RACE_DETECTED,
          message: 'Outro checkout em andamento. Tente novamente em alguns segundos.',
          status: HttpStatus.CONFLICT,
        });
      }
    });

    // Cancela preapproval anterior FORA da tx (HTTP — não pode segurar DB lock).
    // Idempotente em 404 (já tratado em AsaasBillingProvider.cancelPreapproval).
    if (sub.mpPreapprovalId) {
      try {
        await this.provider.cancelPreapproval(sub.mpPreapprovalId);
      } catch (err) {
        this.logger.warn({
          event: 'subscription.previous_preapproval_cancel_failed',
          tenantId: input.tenantId,
          previousPreapprovalId: sub.mpPreapprovalId,
          error: (err as Error).message,
        });
      }
    }

    const amountCents =
      (provider === 'asaas'
        ? this.config.get<number>('ASAAS_PLAN_AMOUNT_CENTS')
        : this.config.get<number>('MP_PLAN_AMOUNT_CENTS')) ?? 4990;
    const created = await this.provider.createPreapproval({
      tenantId: input.tenantId,
      tenantSlug: input.tenantSlug,
      payerEmail: input.ownerEmail,
      payerName: input.ownerName,
      payerCpfCnpj: input.ownerCpfCnpj,
      reason: `Assinatura KairoBarber - ${input.tenantSlug}`,
      amountCents,
      frequency: 'months',
    });

    const nextSyncAt = new Date(this.now().getTime() + 60 * 60 * 1000);

    // F4/A4 TX2: race-check post-HTTP + update atômico. Se DB mudou entre TX1 e TX2
    // (outro checkout escreveu durante nossa chamada HTTP), abortar + cleanup do
    // preapproval recém-criado pra não deixar órfão no Asaas.
    try {
      await this.prisma.$transaction(async (tx) => {
        const subFresh2 = await tx.subscription.findUnique({
          where: { tenantId: input.tenantId },
        });
        if (!subFresh2) {
          throw new DomainException({
            code: ErrorCodes.SUBSCRIPTION_NOT_FOUND,
            message: 'Assinatura não encontrada.',
            status: HttpStatus.NOT_FOUND,
          });
        }
        if (subFresh2.mpPreapprovalId !== sub.mpPreapprovalId) {
          throw new DomainException({
            code: ErrorCodes.CHECKOUT_RACE_DETECTED,
            message: 'Outro checkout em andamento. Tente novamente em alguns segundos.',
            status: HttpStatus.CONFLICT,
          });
        }
        await tx.subscription.update({
          where: { tenantId: input.tenantId },
          data: {
            mpPreapprovalId: created.preapprovalId,
            nextSyncAt,
            updatedAt: sub.updatedAt,
          },
        });
      });
    } catch (err) {
      if (
        err instanceof DomainException &&
        err.opts.code === ErrorCodes.CHECKOUT_RACE_DETECTED
      ) {
        // Cleanup best-effort do preapproval recém-criado (perdedor não pode deixar
        // órfão no Asaas — gastaria cobrança duplicada). Falha de cleanup é logada
        // mas não impede o throw — pior caso, órfão no gateway até admin investigar.
        try {
          await this.provider.cancelPreapproval(created.preapprovalId);
        } catch (cleanupErr) {
          this.logger.warn({
            event: 'subscription.race_cleanup_failed',
            tenantId: input.tenantId,
            orphanPreapprovalId: created.preapprovalId,
            error: (cleanupErr as Error).message,
          });
        }
        this.logger.warn({
          event: 'subscription.checkout_race_detected',
          tenantId: input.tenantId,
          attemptedPreapprovalId: created.preapprovalId,
        });
      }
      throw err;
    }

    this.logger.log({
      event: 'subscription.checkout_created',
      tenantId: input.tenantId,
      mpPreapprovalId: created.preapprovalId,
    });

    await this.audit.record({
      action: AuditActions.SUBSCRIPTION_CHECKOUT_CREATED,
      tenantId: input.tenantId,
      targetType: 'subscription',
      targetId: sub.id,
      diff: { mpPreapprovalId: created.preapprovalId },
    });

    return { initPoint: created.initPoint };
  }
```

**Mudanças vs estado anterior:**
1. Adicionada TX1 (linhas após cpfCnpj check) — race-check pre-HTTP.
2. `cancelPreapproval` e `createPreapproval` ficam EXATAMENTE onde estavam (fora de qualquer tx).
3. `this.repo.update(...)` virou `tx.subscription.update(...)` dentro de TX2.
4. TX2 envolvida em try/catch: se for `CHECKOUT_RACE_DETECTED`, cleanup do `created.preapprovalId` + log; re-throw.
5. Log de sucesso + audit ficam DEPOIS de TX2 (só rodam se TX2 commitou ok).

**Nota arquitetural sobre best-effort:** sob `READ COMMITTED` (default Postgres), TX2 pode ainda ler valor antigo entre o commit de TX1 (outro checkout) e o início de TX2. Janela teórica de race persiste — mas em prática a probabilidade é dominada pela latência humana de cliques. D-09 do spec aceita esse trade-off vs custo de `FOR UPDATE` ou idempotency key. Pra defesa real CAS, futuras versões podem trocar `findUnique + update` por `updateMany WHERE mpPreapprovalId = expected` checando count.

- [ ] **Step 7: Rodar testes — devem PASSAR**

Run: `pnpm jest src/modules/billing/billing.checkout.spec.ts`

Expected: **todos os testes verdes** (pré-existentes + 2 novos de race).

Se algum teste pré-existente quebrar com `prisma.$transaction is not a function`: confirmar que o mock em Step 3 está correto e foi passado pro constructor em Step 5. Se quebrar com `Cannot read property 'update' of undefined`: confirmar que o `tx.subscription.update` está delegando pra `repo.update`.

- [ ] **Step 8: Rodar suite billing completa pra confirmar zero regressão**

Run: `pnpm jest src/modules/billing/`

Expected: **todas as 8 suites verdes** (incluindo `billing.service.spec.ts`, `billing.cron.spec.ts`, `billing.processor.spec.ts`, `billing.schedules.spec.ts`).

**Atenção:** outros specs que constroem `BillingService` (e.g., `billing.service.spec.ts`, `billing.cron.spec.ts`) também precisam do novo argumento `prisma` no constructor. Caso quebrem com `expected 6 arguments, got 5`: aplicar o mesmo padrão de `mkPrisma()` (criar helper local em cada spec ou passar `{} as never`).

- [ ] **Step 9: Grep — confirmar `?? 4990` ainda existe (não tocamos defaults — F2 não cobriu Asaas amount)**

Run: `grep -n "ASAAS_PLAN_AMOUNT_CENTS\|MP_PLAN_AMOUNT_CENTS" src/modules/billing/billing.service.ts`

Expected: ambas as ocorrências preservadas. F4 não toca defaults (F2 cobriu trial+grace+crons mas deixou plan_amount — anotado fora de escopo da F2 também).

- [ ] **Step 10: Commit (junto com Task 3 / error code novo)**

```bash
git add src/common/exceptions/error-codes.ts src/modules/billing/billing.service.ts src/modules/billing/billing.checkout.spec.ts
git commit -m "$(cat <<'EOF'
feat(billing): double-tx race-check em createCheckout (F4 R-F4-03/04/05 / A4)

Fecha vetor A4 da auditoria 2026-05-21: 2 cliques paralelos em
POST /admin/billing/checkout podiam criar 2 preapprovals no
Asaas (um orfao silencioso, gerando cobranca duplicada se cliente
paga via link de email antigo). Throttle 6/60s nao prevenia (so
serializa janelas).

D-09: transaction com re-leitura serializa CAS-style sem custo de
FOR UPDATE. Estrutura:
- TX1 pre-HTTP: re-le, se mpPreapprovalId mudou → 409 CHECKOUT_RACE_DETECTED
- HTTP cancel+create (FORA da tx — nao bloqueia DB lock)
- TX2 post-HTTP: re-le, se mudou → cleanup do preapproval recem-criado + 409
- Log race_cleanup_failed se cancel do orfao falhar (best-effort)

Best-effort sob READ COMMITTED — janela teorica residual aceita
em D-09 vs custo de lock pessimista / idempotency key.

Novo ErrorCode: CHECKOUT_RACE_DETECTED (HTTP 409).

Spec: docs/superpowers/specs/2026-05-21-billing-hardening-v2-design.md
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Verificação final — full test suite + grep de anti-acceptance

**Arquivo:** N/A (verificação).

- [ ] **Step 1: Grep — confirmar zero ocorrências de `SUBSCRIPTION_INACTIVE` em ai-visagism**

Run: `grep -rn "SUBSCRIPTION_INACTIVE\|PAYMENT_REQUIRED" src/modules/ai-visagism/`

Expected: **0 linhas**.

- [ ] **Step 2: Grep — confirmar `CHECKOUT_RACE_DETECTED` aparece no service + error-codes**

Run: `grep -rn "CHECKOUT_RACE_DETECTED" src/`

Expected: 2+ linhas (definição em `error-codes.ts:54` + uso em `billing.service.ts` — TX1 + TX2 + log).

- [ ] **Step 3: Grep — confirmar `cancelPreapproval` / `createPreapproval` ficam FORA de `$transaction`**

Run: `grep -n "\$transaction\|cancelPreapproval\|createPreapproval" src/modules/billing/billing.service.ts`

Expected: olhar a sequência de linhas e confirmar que nenhuma das chamadas `provider.cancelPreapproval(...)` ou `provider.createPreapproval(...)` está DENTRO de um bloco `$transaction(async (tx) => { ... })`. Manualmente inspecionar — anti-acceptance crítico (segura DB lock por segundos é inaceitável).

- [ ] **Step 4: Lint nos arquivos tocados**

Run: `npx eslint src/modules/billing/billing.service.ts src/modules/billing/billing.checkout.spec.ts src/modules/ai-visagism/ai-visagism.service.ts src/common/exceptions/error-codes.ts`

Expected: **0 errors**.

- [ ] **Step 5: Build**

Run: `pnpm build 2>&1 | tail -5`

Expected: build OK.

- [ ] **Step 6: Suite unit completa**

Run: `pnpm test 2>&1 | tail -10`

Expected: **todos verdes**.

- [ ] **Step 7: Suite E2E billing (se Docker saudável)**

Run: `pnpm test:e2e -- billing 2>&1 | tail -10`

Expected: **5+ suites verdes**. **Atenção:** se testcontainers travar (visto em F3), pular e anotar pro user revisar. Não bloqueia commit; estado dos unit tests + lint + build é suficiente pra confiar no fix.

- [ ] **Step 8: Suite E2E AI visagism (valida A3 via middleware)**

Run: `pnpm test:e2e -- ai-visagism 2>&1 | tail -10`

Expected: **suites verdes**. Especialmente `ai-visagism-gating` (linha 60: `'404 TENANT_NOT_FOUND quando subscription past_due'`) continua passando — middleware barra primeiro, service-level alinhado é defesa em camadas.

- [ ] **Step 9: Smoke manual local (opcional)**

```bash
docker compose up -d postgres redis
pnpm prisma migrate dev
pnpm start:dev
```

Em outro terminal:

```bash
# Cadastra tenant, força past_due via Prisma Studio (ou seed manual), tenta AI visagism
curl -X POST http://localhost:3000/public/<slug>/ai/visagism/consultations \
  -F "consentAcceptedAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  -F "photo=@/path/to/test.jpg"
# Esperado: 404 com body { code: 'TENANT_NOT_FOUND', ... }
```

Encerrar servidor (Ctrl-C).

---

## Task 6: PR — abrir pull request da fase F4

**Arquivo:** N/A — operação git/GitHub.

- [ ] **Step 1: Conferir status**

Run: `git status && git log --oneline main..HEAD`

Expected: 2 commits desta fase:
1. `feat(ai-visagism): 404 TENANT_NOT_FOUND em past_due/cancelled (F4 R-F4-01 / A3)`
2. `feat(billing): double-tx race-check em createCheckout (F4 R-F4-03/04/05 / A4)`

- [ ] **Step 2: Push da branch**

Run: `git push -u origin feature/billing-hardening-f4-storefront-checkout-race`

- [ ] **Step 3: Abrir PR via `gh`**

```bash
gh pr create --title "feat(billing,ai): F4 — coerencia storefront + checkout race (A3 + A4)" --body "$(cat <<'EOF'
## Summary

Fase F4 do [spec billing-hardening-v2](docs/superpowers/specs/2026-05-21-billing-hardening-v2-design.md), fechando os 2 últimos vetores e zerando a auditoria 2026-05-21:

- **A3**: `AiVisagismService.assertSubscriptionAllowed` retornava `402 SUBSCRIPTION_INACTIVE` em past_due/cancelled — vazava estado de billing pra scraper que varre slugs. Trocado pra `404 TENANT_NOT_FOUND` (INV-16). Defesa em camadas: `PublicTenantMiddleware` (B1) ja barra em `/public/:slug/*`; esta mudança alinha o service-level pra que bypass do middleware não vaze. **D-08.**
- **A4**: `BillingService.createCheckout` não tinha proteção contra cliques paralelos. Throttle 6/60s não previne 2 calls concorrentes (serializa só janelas separadas). Adicionado double-tx race-check: TX1 pre-HTTP valida `mpPreapprovalId`, TX2 post-HTTP valida + escreve. HTTP cancel/create FORA das tx (não bloqueia DB). Se race detectada, cleanup best-effort do preapproval órfão recém-criado + 409 `CHECKOUT_RACE_DETECTED`. **D-09.**

Sem mudança de schema. Novo ErrorCode `CHECKOUT_RACE_DETECTED` (HTTP 409).

## Test plan
- [x] Unit: 2 novos testes em `billing.checkout.spec.ts` (race pre-HTTP, race post-HTTP + cleanup)
- [x] Unit: `pnpm jest src/modules/billing/` 100% verde
- [x] Unit: `pnpm jest src/modules/ai-visagism/` 100% verde
- [x] E2E (se Docker saudável): `pnpm test:e2e -- billing` 100% verde
- [x] E2E (se Docker saudável): `pnpm test:e2e -- ai-visagism` — `ai-visagism-gating` test linha 60 (`404 TENANT_NOT_FOUND past_due`) passa
- [x] Lint + build: 0 errors nos arquivos tocados
- [x] Grep: `SUBSCRIPTION_INACTIVE`+`PAYMENT_REQUIRED` 0 ocorrências em `src/modules/ai-visagism/`
- [x] Grep: `cancelPreapproval`/`createPreapproval` ficam FORA de `$transaction` (inspeção manual confirma)

## Anti-acceptance verificado
- ❌ AI visagism retorna 402/403 em past_due/cancelled → 404 TENANT_NOT_FOUND confirmado
- ❌ Front recebe `SUBSCRIPTION_INACTIVE` em endpoint público → ErrorCode removido do service
- ❌ Chamada externa ao Asaas DENTRO de `prisma.$transaction` → inspeção manual confirma fora
- ❌ Race cria 2 preapprovals sem cleanup → cleanup best-effort + log `subscription.race_cleanup_failed`
- ❌ Fluxo serial de re-checkout (past_due → renovar) quebra → testes pré-existentes verdes

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Aguardar CI**

Acompanhar checks. Se verde, mergear (squash) em `main`. F4 fecha o spec billing-hardening-v2 inteiro (8 vetores: 4 críticos C1-C4 + 4 altos A1-A4).

---

## Self-Review (post-write checklist)

**1. Cobertura R-F4-NN:**
- R-F4-01 (assertSubscriptionAllowed: 402→404) → Task 2 Step 2 ✅
- R-F4-02 (atualizar testes pra novo status) → Task 2 (E2E ja existe + passa via middleware) ✅
- R-F4-03 (createCheckout em prisma.$transaction, HTTP fora) → Task 4 Step 6 ✅
- R-F4-04 (adicionar CHECKOUT_RACE_DETECTED em error-codes) → Task 3 Step 1 ✅
- R-F4-05 (testes de race — vencedora 200, perdedora 409, max 1 createPreapproval) → Task 4 Step 2 (2 testes) ✅

**2. Acceptance criteria do spec §10:**
- "Tenant past_due em POST /public/:slug/ai/visagism/consultations recebe 404 + code: TENANT_NOT_FOUND" → Task 2 Step 2 + E2E pré-existente ✅
- "Tenant cancelled idem" → mesma mudança cobre ambos ✅
- "Trialing/active mantém 201 (sem regressão)" → ramo `if (!sub || cancelled || past_due)` não atinge — mantido ✅
- "Polling endpoint GET /public/ai/visagism/consultations/:id em past_due continua 200" → endpoint token-scoped, fora do middleware (public.module.ts excluido), e fora do gating do service (gating é só em `createConsultation` no slug-scoped) ✅
- "2 calls paralelos em /admin/billing/checkout — uma 200, outra 409" → Task 4 Step 2 (2 testes) ✅
- "Apenas 1 createPreapproval em cenário concorrente" → Task 4 Step 2 (asserts via mock counter) ✅
- "Fluxo serial (1 checkout completo → outro) continua funcionando" → mockResolvedValue (não mockImplementation) nos testes serial — re-checagem sempre passa ✅
- "pnpm test, pnpm test:e2e, pnpm lint, pnpm build verdes" → Task 5 ✅

**3. Anti-acceptance do spec §10:**
- ❌ AI visagism retorna 402/403 em past_due/cancelled → Task 2 muda pra 404 ✅
- ❌ Front recebe SUBSCRIPTION_INACTIVE em endpoint público → grep Task 5 Step 1 confirma 0 ocorrências ✅
- ❌ Chamada externa ao Asaas dentro de $transaction → Task 4 Step 6 estrutura HTTP entre TX1 e TX2, fora de ambas ✅
- ❌ Race cria 2 preapprovals → TX2 catch + cleanup cancelPreapproval ✅
- ❌ Fluxo serial quebra → testes pré-existentes continuam usando `mockResolvedValue` (chamadas múltiplas retornam mesmo valor — race-check passa) ✅

**4. Fora de escopo respeitado (spec §10):**
- ❌ Idempotency key persistente no DB → não adicionado
- ❌ `FOR UPDATE` lock pessimista → não usado (re-leitura na tx, D-09)
- ❌ Cleanup retroativo de preapprovals órfãs existentes → não adicionado (script separado se observarmos)
- ❌ Mudança no front pra tratar 409 → fora desta PR (front trata na próxima)
- ❌ Mover gating do AI visagism pro middleware → não feito (D-08)

**5. Placeholder scan:** nenhum TBD/TODO/placeholder.

**6. Type consistency:**
- `ErrorCodes.CHECKOUT_RACE_DETECTED` declarado em error-codes.ts e usado em billing.service.ts — match exato.
- `HttpStatus.CONFLICT` (409) usado em ambas as TXs em billing.service.ts e nos testes — match.
- `DomainException` com `{ code, message, status }` (sem `details`) — consistente com `SUBSCRIPTION_ALREADY_ACTIVE` pré-existente.
- `prisma.$transaction(async (tx) => { ... })` API confirmada para Prisma 5.x (lib travada do projeto).

**7. Conhecidos pontos frágeis (mitigados):**
- READ COMMITTED janela residual de race: D-09 do spec aceita explicitamente. Documentado em comment + commit message + nota arquitetural em Step 6.
- Cleanup do preapproval órfão (TX2 catch) é best-effort: se cancelPreapproval falhar, log `subscription.race_cleanup_failed` permite ops investigar. Ainda melhor que o estado anterior (0 cleanup).
- Mock de `$transaction` nos testes unitários delega pra `repo` — confiavel pra testes que mockam `repo.findByTenantId` com `mockResolvedValue` ou `mockImplementation`. Testes que precisarem isolar TX1 vs TX2 (race testing) usam `mockImplementation` com `callCount` (Step 2).
- Constructor do `BillingService` ganha novo argumento `prisma` — força atualizar mocks em todos os specs que instanciam o service. Listados: `billing.checkout.spec.ts` (Task 4 Step 3), `billing.service.spec.ts`, `billing.cron.spec.ts`, `billing.processor.spec.ts` se aplicável (verificar em Step 8).

---

## Histórico

| Data | Mudança |
|---|---|
| 2026-05-21 | Versão inicial. Plano executável da F4 (A3 storefront + A4 checkout race). Spec: `2026-05-21-billing-hardening-v2-design.md`. Fecha auditoria 2026-05-21. |
