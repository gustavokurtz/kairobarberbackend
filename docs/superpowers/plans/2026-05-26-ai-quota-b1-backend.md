# AI Quota per Status — Fase B1 (Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir a env `AI_VISAGISM_MONTHLY_QUOTA` única por `AI_VISAGISM_TRIAL_QUOTA=10` + `AI_VISAGISM_ACTIVE_QUOTA=30`, fazer o débito atômico resolver o limite via `CASE status` no SQL (1 round-trip), e expor `aiQuotaLimit` nos endpoints SaaS `GET /saas/ai-usage` e `GET /saas/tenants/:id`.

**Architecture:** Mudanças cirúrgicas em 4 arquivos existentes (env validation, .env.example, QuotaRepository, QuotaService) + ajuste de payload em 2 services SaaS. Sem migration de schema. Sem coluna nova. Sem `Plan` model. O contrato externo (response 201 do POST de consulta, erro 429 `AI_QUOTA_EXCEEDED`) preserva campos existentes — apenas o **valor** de `quotaLimit`/`details.limit` passa a ser dinâmico (10 ou 30 conforme status). Tests unitários cobrem os 5 cenários da §8 do spec.

**Tech Stack:** NestJS 11, Prisma 5 (raw SQL pro UPDATE atomic), TypeScript estrito, Jest. Spec base: [docs/superpowers/specs/2026-05-26-ai-quota-per-status-design.md](../specs/2026-05-26-ai-quota-per-status-design.md).

---

## Task 0: Recall (re-leitura obrigatória)

**Files:** nenhum (só leitura)

- [ ] **Step 1: Re-ler o spec inteiro**

Abrir e ler completamente:
`/home/ntconsult/Projetos/meus/kairobarber/kairobarber-api/docs/superpowers/specs/2026-05-26-ai-quota-per-status-design.md`

- [ ] **Step 2: Echo-back de 5 bullets antes de codar qualquer linha**

Responder mentalmente (ou em comentário do PR):

1. **Invariants relevantes:** INV-01 (UPDATE atomic), INV-02 (provider só no worker), INV-03 (limite por status: 10/30/0), INV-04 (não zera trial→active), INV-06 (env vars, não DB), INV-08 (sem Plan model).
2. **Em escopo:** R-B1-01..R-B1-07.
3. **Anti-acceptance:** sem migration de dados, sem reset em trial→active, sem coluna nova, sem lookup-then-update no caminho feliz, sem mudança em `refund`/`resetAll`/cron, zero endpoint novo.
4. **Endpoints exatos:** `POST /public/{slug}/ai/visagism/consultations` (valor dinâmico em `quotaLimit`/`details.limit`); `GET /saas/ai-usage` (incluir `aiQuotaLimit` por item); `GET /saas/tenants/:id` (incluir `subscription.aiQuotaLimit`).
5. **Acceptance criteria:** unit tests verdes cobrindo trial 9→10/10→429, active 29→30/30→429, past_due→429; lint+build+test verdes; E2E rodado pelo Gustavo (não automático) confirmando trial 11ª=429, active 31ª=429, trial→active acumula.

Se algum bullet parecer adivinhado ou parafraseado vago → **pare e re-leia §2/§4/§7 do spec**.

---

## File Structure

**Modificados:**
- `.env.example:87` — substituir `AI_VISAGISM_MONTHLY_QUOTA=100` por `AI_VISAGISM_TRIAL_QUOTA=10` + `AI_VISAGISM_ACTIVE_QUOTA=30`
- `src/config/env.validation.ts:122` (Joi schema) — idem
- `src/config/env.validation.ts:196` (type `Env`) — idem
- `src/modules/ai-visagism/quota/quota.repository.ts:12-22` — `tryIncrement` aceita 2 limites e usa `CASE status` no SQL; RETURNING inclui status
- `src/modules/ai-visagism/quota/quota.service.ts` — ler 2 envs no constructor; passa pro repo; em estouro faz `SELECT status` pra montar mensagem 429 correta; retorna `{ used, limit, status }`
- `src/modules/ai-visagism/ai-visagism.service.ts:81` — sem mudança estrutural (charge já retorna `{ used, limit }`); confirmar que `quotaLimit` da response reflete o valor dinâmico
- `src/modules/saas-admin/services/saas-ai-usage.service.ts:27-32` — incluir `aiQuotaLimit` em cada item (resolve via status do tenant: a query precisa passar a incluir `status`)
- `src/modules/saas-admin/services/saas-tenants.service.ts:57-65` — incluir `aiQuotaLimit` no payload `subscription` (status já vem)
- `src/modules/ai-visagism/quota/quota.service.spec.ts` — atualizar todos os testes (assinatura nova, novos cenários)

**Criados:**
- `src/modules/saas-admin/services/saas-ai-usage.service.spec.ts` — novo, cobrindo `aiQuotaLimit` por linha
- Os novos cenários em `saas-tenants.service.spec.ts` ficam **dentro** do arquivo existente (já existe).

---

## Task 1: Atualizar env vars (Joi + type + .env.example)

**Files:**
- Modify: `src/config/env.validation.ts:122` e `:196`
- Modify: `.env.example:87`

- [ ] **Step 1: Escrever teste falhando** (não aplicável aqui — env é configuração; teste real vem na Task 3 onde o QuotaService consome). Pular pra Step 2.

- [ ] **Step 2: Modificar `src/config/env.validation.ts` (Joi schema)**

Em [src/config/env.validation.ts:122](../../src/config/env.validation.ts), localizar e **substituir**:

```typescript
  AI_VISAGISM_MONTHLY_QUOTA: Joi.number().integer().min(0).default(100),
```

Por:

```typescript
  AI_VISAGISM_TRIAL_QUOTA: Joi.number().integer().min(0).default(10),
  AI_VISAGISM_ACTIVE_QUOTA: Joi.number().integer().min(0).default(30),
```

- [ ] **Step 3: Modificar `src/config/env.validation.ts` (type `Env`)**

Em [src/config/env.validation.ts:196](../../src/config/env.validation.ts), localizar e **substituir**:

```typescript
  AI_VISAGISM_MONTHLY_QUOTA: number;
```

Por:

```typescript
  AI_VISAGISM_TRIAL_QUOTA: number;
  AI_VISAGISM_ACTIVE_QUOTA: number;
```

- [ ] **Step 4: Modificar `.env.example`**

Em [.env.example:87](../../.env.example), localizar e **substituir**:

```
AI_VISAGISM_MONTHLY_QUOTA=100
```

Por:

```
AI_VISAGISM_TRIAL_QUOTA=10
AI_VISAGISM_ACTIVE_QUOTA=30
```

- [ ] **Step 5: Verificar que `pnpm build` falha por uso de var antiga**

Run: `cd /home/ntconsult/Projetos/meus/kairobarber/kairobarber-api && pnpm build`
Expected: FAIL com erro de TypeScript em `quota.service.ts` (ainda usa `AI_VISAGISM_MONTHLY_QUOTA`). Confirma que o boot **iria falhar** se o código não fosse atualizado. Não commitar ainda — Task 2/3 corrigem.

---

## Task 2: QuotaRepository — `tryIncrement` com `CASE status` (TDD)

**Files:**
- Modify: `src/modules/ai-visagism/quota/quota.repository.ts:1-47`

Como esta é uma raw SQL query, testes unitários da repository ficam fracos (precisa mock do prisma.$queryRaw com template strings — frágil). Cobertura real vem via tests do service mockando o repo (Task 3) + E2E (Task 9). Por isso esta task **não tem teste novo** — só implementação + validação por compilação.

- [ ] **Step 1: Substituir `tryIncrement` em `quota.repository.ts:12-22`**

Em [src/modules/ai-visagism/quota/quota.repository.ts](../../src/modules/ai-visagism/quota/quota.repository.ts), localizar o método `tryIncrement` e **substituir** o método inteiro por:

```typescript
  /**
   * Incremento atômico com limite resolvido por status:
   *   - trialing → trialLimit
   *   - active   → activeLimit
   *   - past_due/cancelled → 0 (nunca incrementa; CASE retorna 0)
   *
   * Retorna { used, status } se incrementou; null se estourou (ou status não cobre).
   * Atomic via Postgres em 1 round-trip — sem race condition.
   */
  async tryIncrement(
    tenantId: string,
    trialLimit: number,
    activeLimit: number,
  ): Promise<{ used: number; status: string } | null> {
    const rows = await this.prisma.$queryRaw<
      { ai_quota_used_this_month: number; status: string }[]
    >`
      UPDATE "Subscription"
      SET "aiQuotaUsedThisMonth" = "aiQuotaUsedThisMonth" + 1,
          "updatedAt" = NOW()
      WHERE "tenantId" = ${tenantId}
        AND "aiQuotaUsedThisMonth" < (
          CASE "status"
            WHEN 'trialing' THEN ${trialLimit}::int
            WHEN 'active'   THEN ${activeLimit}::int
            ELSE 0
          END
        )
      RETURNING "aiQuotaUsedThisMonth" AS ai_quota_used_this_month,
                "status" AS status
    `;
    const row = rows[0];
    if (!row) return null;
    return { used: row.ai_quota_used_this_month, status: row.status };
  }
```

- [ ] **Step 2: Adicionar método `getStatus` no mesmo arquivo (fallback pra mensagem de erro)**

Em [src/modules/ai-visagism/quota/quota.repository.ts](../../src/modules/ai-visagism/quota/quota.repository.ts), adicionar logo após `tryIncrement` (antes de `refund`):

```typescript
  /**
   * SELECT auxiliar usado apenas no caminho de erro 429,
   * pra montar a mensagem com o limite correto. Não usado no caminho feliz.
   */
  async getStatus(tenantId: string): Promise<string | null> {
    const row = await this.prisma.subscription.findUnique({
      where: { tenantId },
      select: { status: true },
    });
    return row?.status ?? null;
  }
```

- [ ] **Step 3: Confirmar compilação**

Run: `cd /home/ntconsult/Projetos/meus/kairobarber/kairobarber-api && pnpm tsc --noEmit`
Expected: FAIL ainda (quota.service.ts continua usando assinatura antiga + env antiga). Próxima task arruma. Não commitar.

---

## Task 3: QuotaService — 2 envs + repassa limites + fallback pra mensagem de erro (TDD)

**Files:**
- Modify: `src/modules/ai-visagism/quota/quota.service.ts:1-54`
- Modify: `src/modules/ai-visagism/quota/quota.service.spec.ts:1-57`

- [ ] **Step 1: Reescrever `quota.service.spec.ts` completamente**

Substituir o conteúdo de [src/modules/ai-visagism/quota/quota.service.spec.ts](../../src/modules/ai-visagism/quota/quota.service.spec.ts) por:

```typescript
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { QuotaService } from './quota.service';
import { QuotaRepository } from './quota.repository';

function makeService(trialLimit = 10, activeLimit = 30) {
  const repo: jest.Mocked<
    Pick<QuotaRepository, 'tryIncrement' | 'refund' | 'resetAll' | 'getStatus'>
  > = {
    tryIncrement: jest.fn(),
    refund: jest.fn(),
    resetAll: jest.fn(),
    getStatus: jest.fn(),
  };
  const cfg = {
    getOrThrow: <T>(k: string): T => {
      if (k === 'AI_VISAGISM_TRIAL_QUOTA') return trialLimit as unknown as T;
      if (k === 'AI_VISAGISM_ACTIVE_QUOTA') return activeLimit as unknown as T;
      return undefined as unknown as T;
    },
  } as unknown as ConfigService;
  const logger = { log: jest.fn(), warn: jest.fn() } as unknown as Logger;
  const service = new QuotaService(repo as unknown as QuotaRepository, cfg, logger);
  return { service, repo, logger };
}

describe('QuotaService', () => {
  describe('chargeOrThrow — sucesso por status', () => {
    it('trialing 9→10: incrementa e retorna limit=10', async () => {
      const { service, repo } = makeService(10, 30);
      repo.tryIncrement.mockResolvedValueOnce({ used: 10, status: 'trialing' });
      await expect(service.chargeOrThrow('t1')).resolves.toEqual({
        used: 10,
        limit: 10,
        status: 'trialing',
      });
      expect(repo.tryIncrement).toHaveBeenCalledWith('t1', 10, 30);
    });

    it('active 29→30: incrementa e retorna limit=30', async () => {
      const { service, repo } = makeService(10, 30);
      repo.tryIncrement.mockResolvedValueOnce({ used: 30, status: 'active' });
      await expect(service.chargeOrThrow('t1')).resolves.toEqual({
        used: 30,
        limit: 30,
        status: 'active',
      });
    });
  });

  describe('chargeOrThrow — estouro (null do repo)', () => {
    it('trialing estourado: 429 com details.limit=10', async () => {
      const { service, repo } = makeService(10, 30);
      repo.tryIncrement.mockResolvedValueOnce(null);
      repo.getStatus.mockResolvedValueOnce('trialing');
      await expect(service.chargeOrThrow('t1')).rejects.toMatchObject({
        opts: {
          code: 'AI_QUOTA_EXCEEDED',
          status: 429,
          details: { limit: 10 },
        },
      });
      expect(repo.getStatus).toHaveBeenCalledWith('t1');
    });

    it('active estourado: 429 com details.limit=30', async () => {
      const { service, repo } = makeService(10, 30);
      repo.tryIncrement.mockResolvedValueOnce(null);
      repo.getStatus.mockResolvedValueOnce('active');
      await expect(service.chargeOrThrow('t1')).rejects.toMatchObject({
        opts: {
          code: 'AI_QUOTA_EXCEEDED',
          status: 429,
          details: { limit: 30 },
        },
      });
    });

    it('past_due (CASE retorna 0): 429 com details.limit=0', async () => {
      const { service, repo } = makeService(10, 30);
      repo.tryIncrement.mockResolvedValueOnce(null);
      repo.getStatus.mockResolvedValueOnce('past_due');
      await expect(service.chargeOrThrow('t1')).rejects.toMatchObject({
        opts: {
          code: 'AI_QUOTA_EXCEEDED',
          status: 429,
          details: { limit: 0 },
        },
      });
    });

    it('tenant sem subscription (getStatus null): 429 com details.limit=0', async () => {
      const { service, repo } = makeService(10, 30);
      repo.tryIncrement.mockResolvedValueOnce(null);
      repo.getStatus.mockResolvedValueOnce(null);
      await expect(service.chargeOrThrow('t1')).rejects.toMatchObject({
        opts: {
          code: 'AI_QUOTA_EXCEEDED',
          status: 429,
          details: { limit: 0 },
        },
      });
    });
  });

  describe('refund (inalterado)', () => {
    it('engole erro do repo e loga warn', async () => {
      const { service, repo, logger } = makeService();
      repo.refund.mockRejectedValueOnce(new Error('db down'));
      await expect(service.refund('t1')).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'ai_visagism.quota_refund_failed' }),
      );
    });
  });

  describe('resetAll (inalterado)', () => {
    it('devolve count do repo e loga', async () => {
      const { service, repo } = makeService();
      repo.resetAll.mockResolvedValueOnce(42);
      await expect(service.resetAll()).resolves.toBe(42);
    });
  });

  describe('limites expostos', () => {
    it('trialLimit e activeLimit refletem env', () => {
      const { service } = makeService(7, 21);
      expect(service.trialLimit).toBe(7);
      expect(service.activeLimit).toBe(21);
    });
  });
});
```

- [ ] **Step 2: Rodar testes — devem FALHAR**

Run: `cd /home/ntconsult/Projetos/meus/kairobarber/kairobarber-api && pnpm jest src/modules/ai-visagism/quota/quota.service.spec.ts`
Expected: TODOS os testes falham (compilação ou assertion) porque `QuotaService` ainda tem assinatura antiga.

- [ ] **Step 3: Reescrever `quota.service.ts` completamente**

Substituir [src/modules/ai-visagism/quota/quota.service.ts](../../src/modules/ai-visagism/quota/quota.service.ts) por:

```typescript
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { QuotaRepository } from './quota.repository';

@Injectable()
export class QuotaService {
  private readonly trialQuota: number;
  private readonly activeQuota: number;

  constructor(
    private readonly repo: QuotaRepository,
    cfg: ConfigService,
    private readonly logger: Logger,
  ) {
    this.trialQuota = cfg.getOrThrow<number>('AI_VISAGISM_TRIAL_QUOTA');
    this.activeQuota = cfg.getOrThrow<number>('AI_VISAGISM_ACTIVE_QUOTA');
  }

  /**
   * Débito atômico: incrementa aiQuotaUsedThisMonth se used < limite-do-status.
   * Limite é resolvido no SQL via CASE.
   *
   * @throws DomainException(AI_QUOTA_EXCEEDED, 429) se estourou.
   */
  async chargeOrThrow(
    tenantId: string,
  ): Promise<{ used: number; limit: number; status: string }> {
    const charged = await this.repo.tryIncrement(tenantId, this.trialQuota, this.activeQuota);
    if (charged) {
      const limit = this.resolveLimit(charged.status);
      return { used: charged.used, limit, status: charged.status };
    }

    // Caminho de erro: SELECT auxiliar pra montar a mensagem com o limit correto.
    const status = await this.repo.getStatus(tenantId);
    const limit = status ? this.resolveLimit(status) : 0;
    throw new DomainException({
      code: ErrorCodes.AI_QUOTA_EXCEEDED,
      message: `Cota mensal de consultas de IA esgotada (${limit}).`,
      status: HttpStatus.TOO_MANY_REQUESTS,
      details: { limit },
    });
  }

  async refund(tenantId: string): Promise<void> {
    try {
      await this.repo.refund(tenantId);
    } catch (err) {
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

  /** Helper público pros services SaaS (ai-usage, tenant detail) resolverem o limite a partir do status. */
  resolveLimit(status: string): number {
    if (status === 'trialing') return this.trialQuota;
    if (status === 'active') return this.activeQuota;
    return 0;
  }

  get trialLimit(): number {
    return this.trialQuota;
  }

  get activeLimit(): number {
    return this.activeQuota;
  }
}
```

- [ ] **Step 4: Rodar testes — devem PASSAR**

Run: `cd /home/ntconsult/Projetos/meus/kairobarber/kairobarber-api && pnpm jest src/modules/ai-visagism/quota/quota.service.spec.ts`
Expected: PASS em todos os describes.

- [ ] **Step 5: Rodar build pra confirmar tipagem**

Run: `cd /home/ntconsult/Projetos/meus/kairobarber/kairobarber-api && pnpm tsc --noEmit`
Expected: passa (ou ainda falha em pontos cobertos pelas próximas tasks — anote quais).

- [ ] **Step 6: Commit parcial (env + quota)**

```bash
cd /home/ntconsult/Projetos/meus/kairobarber/kairobarber-api
git add .env.example src/config/env.validation.ts \
        src/modules/ai-visagism/quota/quota.repository.ts \
        src/modules/ai-visagism/quota/quota.service.ts \
        src/modules/ai-visagism/quota/quota.service.spec.ts
git commit -m "$(cat <<'EOF'
feat(ai-visagism): cota IA por status (trial=10, active=30)

Substitui AI_VISAGISM_MONTHLY_QUOTA único por AI_VISAGISM_TRIAL_QUOTA
e AI_VISAGISM_ACTIVE_QUOTA. QuotaRepository.tryIncrement resolve o
limite no SQL via CASE status (1 round-trip atomic). QuotaService
expõe resolveLimit() pra outros services.

Spec: docs/superpowers/specs/2026-05-26-ai-quota-per-status-design.md
(B1 R-B1-01..R-B1-03, INV-01, INV-03, INV-06)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `ai-visagism.service.ts` — ajustar destructure do charge

**Files:**
- Modify: `src/modules/ai-visagism/ai-visagism.service.ts:81`
- Modify: `src/modules/ai-visagism/ai-visagism.service.spec.ts` (atualizar mocks)

O charge agora retorna `{ used, limit, status }` em vez de `{ used, limit }`. O service só consome `used` e `limit` (passa adiante na response 201) — adição de `status` é silenciosa, mas o **type contract** muda. TS estrito vai forçar atualização.

- [ ] **Step 1: Confirmar local da chamada**

`grep -n "chargeOrThrow" src/modules/ai-visagism/ai-visagism.service.ts`
Expected: linha 81 (ou próxima): `const { used, limit } = await this.quota.chargeOrThrow(cmd.tenantId);`

- [ ] **Step 2: Rodar `pnpm tsc --noEmit`**

Run: `cd /home/ntconsult/Projetos/meus/kairobarber/kairobarber-api && pnpm tsc --noEmit`
Expected: **PASSAR** sem mudança (TS aceita destructure parcial — `status` é simplesmente ignorado). Se falhar com outro motivo, anote e corrija.

- [ ] **Step 3: Atualizar mocks do `ai-visagism.service.spec.ts`**

`grep -n "chargeOrThrow" src/modules/ai-visagism/ai-visagism.service.spec.ts`
Para cada ocorrência onde o mock retorna `{ used, limit }`, atualizar pra incluir `status` consistente. Exemplo:

Antes:
```typescript
quota.chargeOrThrow.mockResolvedValue({ used: 1, limit: 100 });
```

Depois:
```typescript
quota.chargeOrThrow.mockResolvedValue({ used: 1, limit: 10, status: 'trialing' });
```

Ajustar **todos** os pontos. Se algum teste verifica `quotaLimit` na response esperada (ex.: `expect(res.quotaLimit).toBe(100)`), trocar pra 10 ou 30 conforme o cenário.

- [ ] **Step 4: Rodar testes do módulo ai-visagism**

Run: `cd /home/ntconsult/Projetos/meus/kairobarber/kairobarber-api && pnpm jest src/modules/ai-visagism`
Expected: PASS em todos os specs do módulo.

- [ ] **Step 5: Commit**

```bash
cd /home/ntconsult/Projetos/meus/kairobarber/kairobarber-api
git add src/modules/ai-visagism/ai-visagism.service.spec.ts
git commit -m "$(cat <<'EOF'
test(ai-visagism): atualiza mocks de chargeOrThrow pra incluir status

QuotaService.chargeOrThrow agora retorna { used, limit, status }.
Specs do service usam limites por status (10/30).

Spec: docs/superpowers/specs/2026-05-26-ai-quota-per-status-design.md (R-B1-04)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: SaasAiUsageService — incluir `aiQuotaLimit` por linha (TDD)

**Files:**
- Create: `src/modules/saas-admin/services/saas-ai-usage.service.spec.ts`
- Modify: `src/modules/saas-admin/services/saas-ai-usage.service.ts:12-54`

- [ ] **Step 1: Criar o spec (vai falhar até a implementação)**

Criar `src/modules/saas-admin/services/saas-ai-usage.service.spec.ts` com:

```typescript
import { SaasAiUsageService } from './saas-ai-usage.service';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AiConsultationRepository } from 'src/modules/ai-visagism/repositories/ai-consultation.repository';
import { QuotaService } from 'src/modules/ai-visagism/quota/quota.service';

function makeService() {
  const findMany = jest.fn();
  const count = jest.fn();
  const prisma = {
    subscription: { findMany, count },
  } as unknown as PrismaService;
  const aiRepo = {
    listRecentByTenant: jest.fn(),
  } as unknown as AiConsultationRepository;
  const quota = {
    resolveLimit: (status: string) =>
      status === 'trialing' ? 10 : status === 'active' ? 30 : 0,
  } as unknown as QuotaService;
  const service = new SaasAiUsageService(prisma, aiRepo, quota);
  return { service, findMany, count };
}

describe('SaasAiUsageService.snapshot', () => {
  it('inclui aiQuotaLimit=10 pra tenant trialing', async () => {
    const { service, findMany, count } = makeService();
    findMany.mockResolvedValue([
      {
        aiQuotaUsedThisMonth: 4,
        status: 'trialing',
        tenant: { id: 't1', slug: 'demo', name: 'Demo' },
      },
    ]);
    count.mockResolvedValue(1);

    const result = await service.snapshot({ page: 1, pageSize: 10 });

    expect(result.data[0]).toMatchObject({
      tenantId: 't1',
      tenantSlug: 'demo',
      tenantName: 'Demo',
      aiQuotaUsedThisMonth: 4,
      aiQuotaLimit: 10,
    });
  });

  it('inclui aiQuotaLimit=30 pra tenant active', async () => {
    const { service, findMany, count } = makeService();
    findMany.mockResolvedValue([
      {
        aiQuotaUsedThisMonth: 15,
        status: 'active',
        tenant: { id: 't2', slug: 'pago', name: 'Pago' },
      },
    ]);
    count.mockResolvedValue(1);

    const result = await service.snapshot({ page: 1, pageSize: 10 });

    expect(result.data[0]).toMatchObject({ aiQuotaLimit: 30 });
  });
});
```

- [ ] **Step 2: Rodar — testes devem FALHAR**

Run: `cd /home/ntconsult/Projetos/meus/kairobarber/kairobarber-api && pnpm jest src/modules/saas-admin/services/saas-ai-usage.service.spec.ts`
Expected: FAIL — `aiQuotaLimit` não está no payload.

- [ ] **Step 3: Modificar `saas-ai-usage.service.ts`**

Substituir [src/modules/saas-admin/services/saas-ai-usage.service.ts](../../src/modules/saas-admin/services/saas-ai-usage.service.ts) por:

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AiConsultationRepository } from 'src/modules/ai-visagism/repositories/ai-consultation.repository';
import { QuotaService } from 'src/modules/ai-visagism/quota/quota.service';

@Injectable()
export class SaasAiUsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRepo: AiConsultationRepository,
    private readonly quota: QuotaService,
  ) {}

  async snapshot(args: { page: number; pageSize: number; detailed?: boolean }) {
    const now = new Date();
    const windowMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

    const [rows, total] = await Promise.all([
      this.prisma.subscription.findMany({
        where: { aiQuotaUsedThisMonth: { gt: 0 } },
        orderBy: { aiQuotaUsedThisMonth: 'desc' },
        skip: (args.page - 1) * args.pageSize,
        take: args.pageSize,
        include: { tenant: { select: { id: true, slug: true, name: true } } },
      }),
      this.prisma.subscription.count({ where: { aiQuotaUsedThisMonth: { gt: 0 } } }),
    ]);

    const items: Array<Record<string, unknown>> = rows.map((s) => ({
      tenantId: s.tenant.id,
      tenantSlug: s.tenant.slug,
      tenantName: s.tenant.name,
      aiQuotaUsedThisMonth: s.aiQuotaUsedThisMonth,
      aiQuotaLimit: this.quota.resolveLimit(s.status),
    }));

    if (args.detailed) {
      for (const item of items) {
        const recent = await this.aiRepo.listRecentByTenant(item.tenantId as string, 50);
        item.recentConsultations = recent.map((r) => ({
          id: r.id,
          status: r.status,
          providerCostCents: r.providerCostCents,
          createdAt: r.createdAt.toISOString(),
          expiredAt: r.expiredAt?.toISOString() ?? null,
        }));
      }
    }

    return {
      windowMonth,
      page: args.page,
      pageSize: args.pageSize,
      total,
      data: items,
    };
  }
}
```

(Mudanças: adicionado `QuotaService` no constructor; cada item do mapa inclui `aiQuotaLimit: this.quota.resolveLimit(s.status)`. O `s.status` já vem porque `findMany` sem `select` específico traz todos os scalars de Subscription.)

- [ ] **Step 4: Atualizar `SaasAdminModule` pra injetar `QuotaService`**

`grep -n "SaasAiUsageService" src/modules/saas-admin/saas-admin.module.ts`

Em `src/modules/saas-admin/saas-admin.module.ts`, garantir que `QuotaService` está nos providers — ou que `AiVisagismModule` exporta `QuotaService` e está nos `imports` do `SaasAdminModule`.

Verificar primeiro qual padrão o projeto usa:

```bash
cd /home/ntconsult/Projetos/meus/kairobarber/kairobarber-api
grep -n "QuotaService\|AiVisagismModule" src/modules/saas-admin/saas-admin.module.ts src/modules/ai-visagism/ai-visagism.module.ts
```

Se `AiVisagismModule` exporta `QuotaService`, adicionar `AiVisagismModule` em `imports` do `SaasAdminModule`. Se não exporta, modificar `ai-visagism.module.ts` pra adicionar `QuotaService` em `exports`, e então importar `AiVisagismModule` em `SaasAdminModule`.

Aplicar a mudança mínima necessária. Evitar criar dependência circular — se houver risco, declarar `QuotaService` localmente em `SaasAdminModule` reusando `QuotaRepository` (mais simples se já houver Prisma disponível).

- [ ] **Step 5: Rodar testes do saas-admin**

Run: `cd /home/ntconsult/Projetos/meus/kairobarber/kairobarber-api && pnpm jest src/modules/saas-admin`
Expected: PASS em `saas-ai-usage.service.spec.ts` + os outros specs existentes do módulo continuam verdes.

- [ ] **Step 6: Commit**

```bash
cd /home/ntconsult/Projetos/meus/kairobarber/kairobarber-api
git add src/modules/saas-admin/services/saas-ai-usage.service.ts \
        src/modules/saas-admin/services/saas-ai-usage.service.spec.ts \
        src/modules/saas-admin/saas-admin.module.ts \
        src/modules/ai-visagism/ai-visagism.module.ts
git commit -m "$(cat <<'EOF'
feat(saas-admin): expor aiQuotaLimit por linha em GET /saas/ai-usage

SaasAiUsageService consome QuotaService.resolveLimit(status) pra
calcular o limite dinâmico (10/30) por subscription. Front (W1)
deleta a constante MONTHLY_QUOTA hardcoded.

Spec: docs/superpowers/specs/2026-05-26-ai-quota-per-status-design.md (R-B1-05)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: SaasTenantsService — incluir `aiQuotaLimit` em `subscription` do detail (TDD)

**Files:**
- Modify: `src/modules/saas-admin/services/saas-tenants.service.ts:57-65`
- Modify: `src/modules/saas-admin/services/saas-tenants.service.spec.ts`

- [ ] **Step 1: Adicionar teste em `saas-tenants.service.spec.ts`**

`grep -n "describe\|detail" src/modules/saas-admin/services/saas-tenants.service.spec.ts` pra localizar o bloco de `detail`. Dentro do `describe('detail', ...)` existente (ou um novo), adicionar:

```typescript
it('inclui aiQuotaLimit=10 em subscription trialing', async () => {
  // Ajustar nomes dos mocks conforme o setup atual do spec — repo.findOneDetailed retorna
  // { tenant: { subscription: { status: 'trialing', aiQuotaUsedThisMonth: 2, ... } }, counters: {...} }
  repo.findOneDetailed.mockResolvedValueOnce({
    tenant: {
      id: 't1',
      slug: 'demo',
      name: 'Demo',
      bio: null,
      owner: { email: 'a@b.c' },
      suspendedAt: null,
      createdAt: new Date(),
      subscription: {
        status: 'trialing',
        trialEndsAt: new Date(),
        currentPeriodEnd: null,
        mpPreapprovalId: null,
        aiQuotaUsedThisMonth: 2,
      },
    },
    counters: { /* o que o repo retornar */ },
  } as never);
  const result = await service.detail('t1');
  expect(result.subscription).toMatchObject({
    status: 'trialing',
    aiQuotaUsedThisMonth: 2,
    aiQuotaLimit: 10,
  });
});

it('inclui aiQuotaLimit=30 em subscription active', async () => {
  repo.findOneDetailed.mockResolvedValueOnce({
    tenant: {
      id: 't2',
      slug: 'pago',
      name: 'Pago',
      bio: null,
      owner: { email: 'a@b.c' },
      suspendedAt: null,
      createdAt: new Date(),
      subscription: {
        status: 'active',
        trialEndsAt: null,
        currentPeriodEnd: new Date(),
        mpPreapprovalId: 'pp_x',
        aiQuotaUsedThisMonth: 18,
      },
    },
    counters: {},
  } as never);
  const result = await service.detail('t2');
  expect(result.subscription).toMatchObject({ aiQuotaLimit: 30 });
});
```

Antes de colar, **abrir** `saas-tenants.service.spec.ts` e adaptar os nomes/setup conforme o que já existe (não duplicar `makeService` se já tiver helper).

- [ ] **Step 2: Rodar — devem FALHAR**

Run: `cd /home/ntconsult/Projetos/meus/kairobarber/kairobarber-api && pnpm jest src/modules/saas-admin/services/saas-tenants.service.spec.ts`
Expected: FAIL — `aiQuotaLimit` ausente.

- [ ] **Step 3: Injetar QuotaService no constructor de `SaasTenantsService`**

Em [src/modules/saas-admin/services/saas-tenants.service.ts](../../src/modules/saas-admin/services/saas-tenants.service.ts), alterar o constructor (linha 10-13):

```typescript
import { QuotaService } from 'src/modules/ai-visagism/quota/quota.service';
// ... outros imports

@Injectable()
export class SaasTenantsService {
  constructor(
    private readonly repo: SaasTenantRepository,
    private readonly audit: AuditService,
    private readonly quota: QuotaService,
  ) {}
```

- [ ] **Step 4: Modificar o método `detail` pra incluir aiQuotaLimit**

Em [src/modules/saas-admin/services/saas-tenants.service.ts:57-65](../../src/modules/saas-admin/services/saas-tenants.service.ts), trocar o bloco `subscription: t.subscription ? { ... } : null` por:

```typescript
      subscription: t.subscription
        ? {
            status: t.subscription.status,
            trialEndsAt: t.subscription.trialEndsAt,
            currentPeriodEnd: t.subscription.currentPeriodEnd,
            mpPreapprovalId: t.subscription.mpPreapprovalId,
            aiQuotaUsedThisMonth: t.subscription.aiQuotaUsedThisMonth,
            aiQuotaLimit: this.quota.resolveLimit(t.subscription.status),
          }
        : null,
```

- [ ] **Step 5: Atualizar `saas-admin.module.ts` se necessário**

Se a Task 5 já adicionou o import de `AiVisagismModule` (ou local provider), nada novo a fazer. Caso contrário, garantir que `SaasTenantsService` recebe `QuotaService` via DI.

- [ ] **Step 6: Rodar testes — devem PASSAR**

Run: `cd /home/ntconsult/Projetos/meus/kairobarber/kairobarber-api && pnpm jest src/modules/saas-admin/services/saas-tenants.service.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /home/ntconsult/Projetos/meus/kairobarber/kairobarber-api
git add src/modules/saas-admin/services/saas-tenants.service.ts \
        src/modules/saas-admin/services/saas-tenants.service.spec.ts \
        src/modules/saas-admin/saas-admin.module.ts
git commit -m "$(cat <<'EOF'
feat(saas-admin): expor aiQuotaLimit em GET /saas/tenants/:id

SaasTenantsService.detail() inclui subscription.aiQuotaLimit
resolvido por status (10/30/0). Mesmo padrão de R-B1-05.

Spec: docs/superpowers/specs/2026-05-26-ai-quota-per-status-design.md (R-B1-06)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Sanidade — build + lint + unit suite completa

**Files:** nenhum

- [ ] **Step 1: Build**

Run: `cd /home/ntconsult/Projetos/meus/kairobarber/kairobarber-api && pnpm build`
Expected: exit 0, sem erros TypeScript.

- [ ] **Step 2: Lint**

Run: `cd /home/ntconsult/Projetos/meus/kairobarber/kairobarber-api && pnpm lint`
Expected: exit 0.

- [ ] **Step 3: Test suite inteira (unit only — não E2E)**

Run: `cd /home/ntconsult/Projetos/meus/kairobarber/kairobarber-api && pnpm test`
Expected: PASS em todos os arquivos. Atenção especial a:
- `quota.service.spec.ts` ✓
- `ai-visagism.service.spec.ts` ✓
- `saas-ai-usage.service.spec.ts` ✓
- `saas-tenants.service.spec.ts` ✓

Se qualquer outro spec quebrar por causa de tipo (`{ used, limit }` → `{ used, limit, status }`), atualizar inline e re-rodar.

- [ ] **Step 4: Buscar resíduos de `AI_VISAGISM_MONTHLY_QUOTA`**

Run: `cd /home/ntconsult/Projetos/meus/kairobarber/kairobarber-api && grep -rn "AI_VISAGISM_MONTHLY_QUOTA" --include="*.ts" --include="*.example" --include="*.md" src/ test/ .env.example`
Expected: **zero ocorrências**. Se aparecer alguma, deletar/atualizar.

- [ ] **Step 5: Commit se houver mudança residual**

```bash
cd /home/ntconsult/Projetos/meus/kairobarber/kairobarber-api
git status
# se houver alterações não commitadas:
git add <arquivos>
git commit -m "$(cat <<'EOF'
chore(ai-visagism): remover resíduos de AI_VISAGISM_MONTHLY_QUOTA

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Atualizar CLAUDE.md do api (se mencionar cota)

**Files:**
- Maybe modify: `CLAUDE.md`
- Maybe modify: `docs/superpowers/specs/2026-05-11-kairobarber-backend-design.md` (seção AI)

- [ ] **Step 1: Localizar menções**

Run: `cd /home/ntconsult/Projetos/meus/kairobarber/kairobarber-api && grep -rn "MONTHLY_QUOTA\|100/mês\|100 consultas\|AI_VISAGISM_MONTHLY" CLAUDE.md docs/superpowers/ 2>&1`

- [ ] **Step 2: Se houver menção genérica ("Cota mensal por tenant")**

Sem mudança. A frase é correta — a cota continua sendo mensal por tenant.

- [ ] **Step 3: Se houver menção a "100" como número exato**

Substituir pela nova nomenclatura: "trial=10, active=30 (env vars `AI_VISAGISM_TRIAL_QUOTA` / `AI_VISAGISM_ACTIVE_QUOTA`)". Referenciar o spec novo.

- [ ] **Step 4: Commit (se houver mudança)**

```bash
cd /home/ntconsult/Projetos/meus/kairobarber/kairobarber-api
git add CLAUDE.md docs/superpowers/specs/2026-05-11-kairobarber-backend-design.md
git commit -m "$(cat <<'EOF'
docs: atualizar menções de cota AI pra refletir trial=10, active=30

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: E2E manual com Gustavo

**Files:** `test/e2e/ai-visagism.e2e-spec.ts` (atualizar — se existir cenário de 101 consultas)

- [ ] **Step 1: Localizar specs E2E afetados**

Run: `cd /home/ntconsult/Projetos/meus/kairobarber/kairobarber-api && grep -rn "MONTHLY_QUOTA\|100" test/e2e/ai-visagism*`

- [ ] **Step 2: Adaptar assertions pros novos limites**

Se houver cenário que faz N consultas e espera 429 na (N+1)-ésima, alterar:
- Trial: N=10 → 11ª deve dar 429 com `details.limit=10`
- Active: N=30 → 31ª deve dar 429 com `details.limit=30`

Adicionar cenário novo: tenant em trial faz 5 consultas, vira active (mudar status na fixture), faz mais 5 — contador final = 10 (acumula, decisão D3), não estoura.

- [ ] **Step 3: NÃO rodar `pnpm test:e2e`. Pedir pro Gustavo**

Pedir literalmente:

> "Rode `pnpm test:e2e -- ai-visagism` e me cola o output. Especificamente preciso ver:
> - tenant trial 11ª consulta → 429 `AI_QUOTA_EXCEEDED` com `details.limit=10`
> - tenant active 31ª consulta → 429 com `details.limit=30`
> - tenant trial→active acumula contador (sem reset)"

- [ ] **Step 4: Diagnosticar e corrigir conforme output (se necessário)**

Se algum teste E2E falhar, debugar com `superpowers:systematic-debugging`. Não commitar fix sem o output verde colado pelo Gustavo.

- [ ] **Step 5: Commit final se houve mudança nos E2E**

```bash
cd /home/ntconsult/Projetos/meus/kairobarber/kairobarber-api
git add test/e2e/ai-visagism*
git commit -m "$(cat <<'EOF'
test(e2e): cota IA por status (trial 11→429, active 31→429, acúmulo trial→active)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Verificação de acceptance final (B1)

Marcar todos antes de declarar B1 done:

- [ ] `.env.example` sem `AI_VISAGISM_MONTHLY_QUOTA`, com 2 novas vars (10 e 30).
- [ ] Boot do app valida envs (Joi defaults cobrem; tirar uma manualmente e tentar bootar → falha).
- [ ] `pnpm test` verde.
- [ ] `pnpm lint` verde.
- [ ] `pnpm build` verde.
- [ ] `grep -rn AI_VISAGISM_MONTHLY_QUOTA` zero ocorrências em `src/`, `test/`, `.env.example`, `docs/`.
- [ ] Response 201 do POST de consulta retorna `quotaLimit=10` (trial fixture) ou `quotaLimit=30` (active fixture).
- [ ] Response 429 `AI_QUOTA_EXCEEDED` traz `details.limit` correto.
- [ ] `GET /saas/ai-usage` retorna `aiQuotaLimit` por item (10 ou 30).
- [ ] `GET /saas/tenants/:id` retorna `subscription.aiQuotaLimit`.
- [ ] E2E rodado pelo Gustavo: trial 11ª = 429, active 31ª = 429, trial→active não zera contador.

## Anti-acceptance (relembrar antes do PR)

- ❌ Sem migration de schema (Prisma).
- ❌ Sem reset de `aiQuotaUsedThisMonth` em transição trial→active.
- ❌ Sem coluna `aiMonthlyLimit` em Subscription.
- ❌ Sem `Plan` model.
- ❌ Sem lookup-then-update no caminho feliz (atomic via CASE).
- ❌ Sem mudança em `refund` ou no cron `JOB_AI_QUOTA_RESET`.
- ❌ Sem endpoint novo.
- ❌ Sem mudança em `visagism-error-bubble.tsx` ou em qualquer arquivo de `kairobarber-web/`.

---

## Próximo passo

Depois do PR de B1 merged + deployed em prod: executar `2026-05-26-ai-quota-w1-web.md` (no repo `kairobarber-web/`).
