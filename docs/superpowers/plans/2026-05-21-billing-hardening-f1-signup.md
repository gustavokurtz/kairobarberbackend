# Billing Hardening F1 — Signup Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fechar o vetor C1 da auditoria 2026-05-21 (trial farm escalável via signup sem throttle + email case-sensitive) adicionando rate-limit no `POST /auth/register/owner`, normalização `trim().toLowerCase()` em escritas/leituras de `User.email`, e migration que substitui a constraint `@unique` cru por um índice funcional `UNIQUE LOWER(email)`.

**Architecture:** Service-layer normalization (não middleware, não DTO transformer) — garante que mesmo bypass de DTO grava email normalizado. `@Throttle` decorator no endpoint NestJS pra rate-limit por IP. Migration manual em SQL pra criar `CREATE UNIQUE INDEX ... ON "User"(LOWER(email))` (Prisma 5.x não suporta nativamente). Banco assumido limpo (D-04 do spec) — migration falha-rápido se houver duplicates, exige cleanup manual.

**Tech Stack:** NestJS 11 + `@nestjs/throttler` + Prisma 5 + Postgres. Tests via Jest + supertest + `@testcontainers/postgresql` (padrão do projeto).

**Spec source-of-truth:** [`docs/superpowers/specs/2026-05-21-billing-hardening-v2-design.md`](../specs/2026-05-21-billing-hardening-v2-design.md) §7 (Fase F1, R-F1-01 a R-F1-09).

---

## File Structure

**Arquivos modificados:**
- `src/modules/auth/auth.controller.ts` — adiciona `@Throttle` no `POST /auth/register/owner`
- `src/modules/auth/auth.service.ts` — normaliza `email` em `registerOwner`, `login`, `forgotPassword`
- `src/modules/auth/repositories/user.repository.ts` — normaliza em `findByEmail`
- `prisma/schema.prisma` — remove `@unique` cru do campo `email` do model `User` (substituído por index funcional via migration)
- `test/e2e/auth-onboarding.e2e-spec.ts` — estende com casos de throttle + case-insensitivity

**Arquivos criados:**
- `prisma/migrations/<timestamp>_user_email_case_insensitive/migration.sql` — `UPDATE` normalizador + `DROP CONSTRAINT` + `CREATE UNIQUE INDEX`

**Convenções respeitadas:**
- Tests são e2e (padrão dominante do projeto — só 3 unit specs em `src/modules/auth/`).
- `@Throttle` no controller layer, mesma sintaxe usada em `/login`, `/checkout`, etc.
- pt-BR em mensagens de erro.

---

## Task 0: Recall — re-ler spec e fazer echo-back

**Arquivo:** N/A (etapa de leitura/raciocínio, sem código).

- [ ] **Step 1: Re-ler ambos os specs**

Ler na íntegra (sem skip):
1. `docs/superpowers/specs/2026-05-21-billing-hardening-v2-design.md`
2. `docs/superpowers/specs/2026-05-20-trial-grace-tightening-design.md`

- [ ] **Step 2: Responder echo-back de 5 bullets na resposta da Task 0**

Responder textualmente (não commitar):

1. Quais invariants (INV-01 a INV-16) são relevantes pra F1?
   *Esperado: INV-12 (write normalize), INV-13 (read normalize + DB index). INV-16 não toca F1 (é F4). INV-01 a INV-11 da spec anterior continuam valendo mas F1 não as modifica.*
2. Que decisões eu posso ferir sem perceber?
   *Esperado: D-02 (não strip aliases/dots — preserva `+foo`), D-03 (CPF/CNPJ continua opcional — não exigir), D-04 (sem cleanup defensivo na migration), D-01 (3/60s, não 5/60s).*
3. Quais requirements R-F1-NN são meu escopo?
   *Esperado: R-F1-01 a R-F1-09.*
4. Qual anti-acceptance protege de scope creep?
   *Esperado: ❌ alias strip (D-02), ❌ migration sem UPDATE prévio, ❌ throttle bloqueia 1-2 signups legítimos, ❌ User.email com maiúscula após esta fase.*
5. Qual recall-check de teste prova que não quebrei reativação?
   *Esperado: login com email gravado em case original continua funcionando (`gustavo@x.com` registrado, login `Gustavo@X.com` → 200). Reativação billing não é tocada por F1 (fora do escopo).*

---

## Task 1: Pre-flight — verificar que DB de prod NÃO tem duplicates de email

**Arquivo:** N/A (verificação operacional, sem código).

**Por que:** Migration desta fase **falha-rápido** (D-04 do spec). Se houver duplicates case-insensitive no DB de prod, o `CREATE UNIQUE INDEX` aborta no deploy e fica meio aplicado. Verificação prévia evita rollback.

- [ ] **Step 1: Conectar ao banco de prod via Railway**

```bash
# No diretório do projeto:
railway run psql -c '<query>'
# OU se preferir shell interativo:
railway run psql
```

Se não tiver `railway` CLI, abrir `Prisma Studio` apontando pra `DATABASE_URL` de prod (via Railway dashboard → Variables → copiar `DATABASE_URL`):

```bash
DATABASE_URL='<prod-url>' pnpm prisma studio
```

- [ ] **Step 2: Rodar query de detecção de duplicates**

```sql
SELECT LOWER(TRIM(email)) AS normalized, COUNT(*) AS count, ARRAY_AGG(email) AS variants
FROM "User"
GROUP BY normalized
HAVING COUNT(*) > 1;
```

Expected: **0 linhas** (banco limpo).

- [ ] **Step 3: Decisão**

- **Se 0 linhas retornadas:** prosseguir pra Task 2. Anotar no PR description: "Pre-flight (2026-05-21): 0 duplicates em prod".
- **Se ≥ 1 linha retornada:** **PARAR**. Salvar output completo. Não codar nada. Reportar pro Gustavo: "Achei N duplicates em prod, exemplos: ..., preciso de decisão de cleanup manual (manter qual versão de cada par?) antes de aplicar a migration F1."

- [ ] **Step 4: Mesmo check no banco local de dev**

```bash
pnpm prisma studio
# Ou:
psql $DATABASE_URL -c "SELECT LOWER(TRIM(email)) AS n, COUNT(*) FROM \"User\" GROUP BY n HAVING COUNT(*) > 1;"
```

Expected: 0 linhas. Se houver, limpar local (seed reset é seguro em dev):

```bash
SEED_RESET=true pnpm prisma:seed
```

---

## Task 2: Adicionar `@Throttle` em `POST /auth/register/owner` (TDD)

**Files:**
- Modify: `src/modules/auth/auth.controller.ts:19-30`
- Modify: `test/e2e/auth-onboarding.e2e-spec.ts` (adiciona novo `it()` ao final do describe)

- [ ] **Step 1: Adicionar test e2e que falha**

Abrir `test/e2e/auth-onboarding.e2e-spec.ts` e adicionar **antes do último `});` que fecha o `describe`** (procure pela última chave fechando o bloco principal):

```ts
  it('throttles register/owner em 4ª request consecutiva (3/60s/IP)', async () => {
    const server = app.getHttpServer();

    // 3 signups com slugs e emails distintos devem passar (limite 3/60s)
    for (let i = 0; i < 3; i++) {
      await request(server)
        .post('/auth/register/owner')
        .send({
          email: `throttle${i}@example.com`,
          password: 'StrongPass!1',
          name: `Throttle ${i}`,
          tenantName: `Throttle Barber ${i}`,
          slug: `throttle-${i}`,
        })
        .expect(201);
    }

    // 4ª request no mesmo IP em < 60s deve retornar 429 Too Many Requests
    await request(server)
      .post('/auth/register/owner')
      .send({
        email: 'throttle3@example.com',
        password: 'StrongPass!1',
        name: 'Throttle 3',
        tenantName: 'Throttle Barber 3',
        slug: 'throttle-3',
      })
      .expect(429);
  });
```

- [ ] **Step 2: Rodar test pra verificar que FALHA**

```bash
pnpm test:e2e -- auth-onboarding
```

Expected: novo teste **FALHA** com `expected 429 "Too Many Requests", got 201 "Created"` (porque ainda não tem @Throttle).

- [ ] **Step 3: Implementar o decorator**

Em `src/modules/auth/auth.controller.ts`, **adicionar** a linha `@Throttle(...)` entre `@Public()` e `@Post('register/owner')`:

```ts
  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('register/owner')
  @HttpCode(HttpStatus.CREATED)
  async registerOwner(@Body() dto: RegisterOwnerDto) {
    const r = await this.auth.registerOwner(dto);
    return {
      user: { id: r.user.id, email: r.user.email, name: r.user.name, role: r.user.role },
      tenant: { id: r.tenant.id, slug: r.tenant.slug, name: r.tenant.name },
      accessToken: r.accessToken,
      refreshToken: r.refreshToken,
    };
  }
```

Verificar que `Throttle` está importado no topo do arquivo (deve estar — `/login` já usa). Se faltar:

```ts
import { Throttle } from '@nestjs/throttler';
```

- [ ] **Step 4: Rodar test pra verificar que PASSA**

```bash
pnpm test:e2e -- auth-onboarding
```

Expected: novo teste **PASSA**. Suite inteira (incluindo testes pré-existentes do mesmo describe) também passa.

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/auth.controller.ts test/e2e/auth-onboarding.e2e-spec.ts
git commit -m "$(cat <<'EOF'
feat(auth): throttle register/owner 3/60s/IP (F1 R-F1-01)

Fecha vetor C1 da auditoria 2026-05-21: signup sem rate-limit
permitia trial farm escalável via bot/botnet. Mesma magnitude
do /checkout (3/60s) — endpoint com side-effect financeiro.

Spec: docs/superpowers/specs/2026-05-21-billing-hardening-v2-design.md
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Normalizar email em `UserRepository.findByEmail` (TDD)

**Files:**
- Modify: `src/modules/auth/repositories/user.repository.ts:9-11`
- Modify: `test/e2e/auth-onboarding.e2e-spec.ts` (adiciona novo `it()`)

- [ ] **Step 1: Adicionar test que falha**

Adicionar ao final do `describe` em `test/e2e/auth-onboarding.e2e-spec.ts`:

```ts
  it('login funciona com email case-variant após signup (lookup normalize)', async () => {
    const server = app.getHttpServer();

    // Pré: registrar com email em case original
    await request(server)
      .post('/auth/register/owner')
      .send({
        email: 'CaseLookup@Example.com',
        password: 'StrongPass!1',
        name: 'Case Lookup',
        tenantName: 'Case Lookup Barber',
        slug: 'case-lookup',
      })
      .expect(201);

    // Login com mesma string em case diferente deve achar o usuário
    const login = await request(server)
      .post('/auth/login')
      .send({ email: 'caselookup@example.com', password: 'StrongPass!1' })
      .expect(200);

    const body = login.body as LoginResponse;
    expect(body.accessToken).toBeTruthy();
  });
```

- [ ] **Step 2: Rodar e verificar FALHA**

```bash
pnpm test:e2e -- auth-onboarding
```

Expected: teste **FALHA** com `expected 200, got 401` (ou similar — `INVALID_CREDENTIALS` porque findByEmail retorna null pra lookup case-different).

- [ ] **Step 3: Implementar normalize em findByEmail**

Em `src/modules/auth/repositories/user.repository.ts`, substituir o método `findByEmail`:

```ts
  findByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
    });
  }
```

- [ ] **Step 4: Rodar e verificar PASSA**

```bash
pnpm test:e2e -- auth-onboarding
```

Expected: novo teste **PASSA**. Mas atenção — o teste anterior (`registers owner, returns tokens`) pode quebrar se o User foi gravado como `CaseLookup@Example.com` no DB (write ainda não normalizado em Task 3) e o login normalizado procura `caselookup@example.com` que **não existe**. Vamos verificar:

- Registro Task 3 grava email como `'CaseLookup@Example.com'` (Task 4 ainda não rodou).
- Login normaliza pra `'caselookup@example.com'`.
- `findUnique({ where: { email: 'caselookup@example.com' } })` → **null** (DB tem com case original).
- Teste falha mesmo com a implementação.

**Esta é a falha esperada que motiva Task 4.** Se o teste passar aqui (provavelmente não), suspeitar de algo errado.

**Se o teste continuar falhando:** ok, deixar como está, prosseguir pra Task 4 — ela fixa o gap. Task 3 sozinha não é suficiente; Task 4 + Task 3 juntas resolvem.

**Decisão pragmática:** rodar test rotulado `.skip` se preferir verde intermediário, ou aceitar vermelho temporário. Recomendado: deixar vermelho temporário com nota:

```ts
  // Falha até R-F1-02 (Task 4) normalizar write. Documentado em plano F1.
  it('login funciona com email case-variant após signup (lookup normalize)', ...);
```

- [ ] **Step 5: NÃO commitar isolado**

Esta task é semi-completa sozinha. Commit acontece junto com Task 4 quando ambos passam. Pular pra Task 4 sem commitar Task 3.

---

## Task 4: Normalizar email em `AuthService` (writes + lookups) (TDD)

**Files:**
- Modify: `src/modules/auth/auth.service.ts` (4 locais: registerOwner write, login pre-lookup, forgotPassword pre-lookup, qualquer outro `findByEmail`/`user.create` com email cru)
- Modify: `test/e2e/auth-onboarding.e2e-spec.ts` (adiciona 2 novos `it()`)

- [ ] **Step 1: Adicionar test que falha — duplicate detection case-insensitive**

Adicionar ao final do `describe`:

```ts
  it('rejeita signup com email case-variant do existente (409)', async () => {
    const server = app.getHttpServer();

    await request(server)
      .post('/auth/register/owner')
      .send({
        email: 'dupCase@Example.com',
        password: 'StrongPass!1',
        name: 'Dup Case',
        tenantName: 'Dup Case Barber',
        slug: 'dup-case-1',
      })
      .expect(201);

    const conflict = await request(server)
      .post('/auth/register/owner')
      .send({
        email: 'DUPCASE@example.com', // mesmo email, case diferente
        password: 'StrongPass!1',
        name: 'Dup Case 2',
        tenantName: 'Dup Case Barber 2',
        slug: 'dup-case-2',
      })
      .expect(409);

    const body = conflict.body as ErrorResponse;
    expect(body.code).toBe('EMAIL_ALREADY_REGISTERED');
  });

  it('grava email normalizado (lowercase) no DB após signup', async () => {
    const server = app.getHttpServer();

    const reg = await request(server)
      .post('/auth/register/owner')
      .send({
        email: 'NormalizeWrite@Example.com',
        password: 'StrongPass!1',
        name: 'Normalize Write',
        tenantName: 'Normalize Write Barber',
        slug: 'normalize-write',
      })
      .expect(201);

    const body = reg.body as RegisterResponse;
    expect(body.user.email).toBe('normalizewrite@example.com');
  });
```

- [ ] **Step 2: Rodar e verificar FALHA**

```bash
pnpm test:e2e -- auth-onboarding
```

Expected:
- Teste "rejeita signup com email case-variant": **FALHA** — segunda chamada retorna 201 (não 409) porque `findByEmail` normaliza input mas o user gravado tem case original ≠ normalized lookup.
  - Espera: Task 3 fez findByEmail normalize. Primeiro signup grava `dupCase@Example.com`. Segundo signup chama `findByEmail('DUPCASE@example.com')` → lookup normaliza pra `dupcase@example.com` → **não encontra** porque DB tem `dupCase@Example.com`. **Segundo signup passa, retorna 201.** Falha esperada.
- Teste "grava email normalizado": **FALHA** — email retornado pela API é `'NormalizeWrite@Example.com'` (case original), não `'normalizewrite@example.com'`.

- [ ] **Step 3: Implementar normalize em registerOwner write**

Abrir `src/modules/auth/auth.service.ts`. Localizar método `registerOwner` (começa em linha ~53). Substituir o início do método:

```ts
  async registerOwner(dto: RegisterOwnerDto) {
    if (RESERVED_SLUGS.has(dto.slug)) {
      throw new DomainException({
        code: ErrorCodes.SLUG_RESERVED,
        message: 'Slug reservado.',
        status: HttpStatus.CONFLICT,
      });
    }
    const email = dto.email.trim().toLowerCase();
    const existingEmail = await this.users.findByEmail(email);
    if (existingEmail) {
      throw new DomainException({
        code: ErrorCodes.EMAIL_ALREADY_REGISTERED,
        message: 'Email já cadastrado.',
        status: HttpStatus.CONFLICT,
      });
    }
    const existingSlug = await this.prisma.tenant.findUnique({ where: { slug: dto.slug } });
    if (existingSlug) {
      throw new DomainException({
        code: ErrorCodes.SLUG_TAKEN,
        message: 'Slug já em uso.',
        status: HttpStatus.CONFLICT,
      });
    }

    const passwordHash = await this.password.hash(dto.password);

    const { user, tenant } = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email, passwordHash, name: dto.name, role: UserRole.tenant_owner },
      });
      const tenant = await tx.tenant.create({
        data: { slug: dto.slug, name: dto.tenantName, ownerUserId: user.id },
      });
      await this.billing.startTrial({ tenantId: tenant.id, tx });
      return { user, tenant };
    });
    // ... resto do método inalterado (issuePair, otts, email.send)
```

A chave é: substituir TODAS as 2 referências a `dto.email` (linha ~61 do `findByEmail` e linha ~82 do `tx.user.create({ data: { email: dto.email, ... } })`) por `email` (a const local normalizada).

- [ ] **Step 4: Implementar normalize em login**

No mesmo arquivo, localizar `async login(email: string, plainPassword: string)` (linha ~120). Substituir a primeira linha do método:

```ts
  async login(email: string, plainPassword: string) {
    const user = await this.users.findByEmail(email.trim().toLowerCase());
    // ... resto inalterado
```

Note: `findByEmail` já normaliza (Task 3), mas explicitar aqui é defesa redundante (INV-12/INV-13 do spec: normalizar no service layer também).

- [ ] **Step 5: Implementar normalize em forgotPassword**

No mesmo arquivo, localizar `async forgotPassword(email: string)` (linha ~205). Mesma mudança:

```ts
  async forgotPassword(email: string) {
    const user = await this.users.findByEmail(email.trim().toLowerCase());
    // ... resto inalterado
```

- [ ] **Step 6: Auditar outros writes de User.email**

Rodar:

```bash
grep -rn "prisma.user.create\|tx.user.create" src/
```

Esperado: 1 ocorrência em `auth.service.ts:82` (já normalizada). Se aparecer outras (e.g., `customers.service.ts` criando User via claim flow), aplicar o mesmo padrão: `email.trim().toLowerCase()` antes do `create`.

Atualmente conhecido outro write: invitation accept em `auth.service.ts:259` (cria `User` a partir de `invitation.email`). Localizar e aplicar:

```ts
  // Antes:
  email: invitation.email,
  // Depois (se aplicável — confirmar lendo contexto):
  email: invitation.email.trim().toLowerCase(),
```

E em customer claim (linha ~313):

```ts
  email: customer.email!.trim().toLowerCase(),
```

- [ ] **Step 7: Rodar testes e verificar PASSA**

```bash
pnpm test:e2e -- auth-onboarding
```

Expected: **TODOS os testes passam** (os 2 novos de Task 4 + os de Task 3 que estavam vermelhos + os pré-existentes).

- [ ] **Step 8: Rodar suite completa pra detectar regressão**

```bash
pnpm test
pnpm test:e2e
```

Expected: tudo verde. Se algum teste pré-existente que envolve email quebrar, confirmar se é por normalize legítimo (esperado) ou regressão. Caso seja regressão, revisar.

- [ ] **Step 9: Commit (junto Task 3 + Task 4)**

```bash
git add src/modules/auth/auth.service.ts src/modules/auth/repositories/user.repository.ts test/e2e/auth-onboarding.e2e-spec.ts
git commit -m "$(cat <<'EOF'
feat(auth): normalize email lower+trim em writes/reads (F1 R-F1-02..06)

Fecha bypass de @unique cru via case-variation
(`Gustavo@gmail.com` vs `gustavo@gmail.com` viravam Users distintos).
Normalize aplicado em service layer (INV-12/INV-13):
- AuthService.registerOwner: normaliza write
- AuthService.login: normaliza pre-lookup
- AuthService.forgotPassword: normaliza pre-lookup
- UserRepository.findByEmail: normaliza query

Constraint do DB ainda é @unique cru — migration funcional vem na Task 5.
Defesa em camadas: service evita conflito; DB index funcional é backstop.

Spec: docs/superpowers/specs/2026-05-21-billing-hardening-v2-design.md
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Migration — `UPDATE` normalizador + índice funcional `UNIQUE LOWER(email)`

**Files:**
- Modify: `prisma/schema.prisma` (remove `@unique` do campo `email` do model `User`)
- Create: `prisma/migrations/<timestamp>_user_email_case_insensitive/migration.sql`
- Modify: `test/e2e/auth-onboarding.e2e-spec.ts` (adiciona test que valida constraint do DB)

- [ ] **Step 1: Adicionar test que valida constraint funcional do DB**

Adicionar ao final do `describe`:

```ts
  it('DB rejeita INSERT direto com email case-variant após migration', async () => {
    const server = app.getHttpServer();

    // Pré: registrar via API (vai gravar email normalizado)
    await request(server)
      .post('/auth/register/owner')
      .send({
        email: 'dbconstraint@example.com',
        password: 'StrongPass!1',
        name: 'DB Constraint',
        tenantName: 'DB Constraint Barber',
        slug: 'db-constraint',
      })
      .expect(201);

    // Tentar INSERT direto via Prisma com email case-variant que normalizado bate com existente
    // Deve falhar por unique constraint do DB (não só do service)
    const prisma = app.get('PrismaService') as { user: { create: (args: unknown) => Promise<unknown> } };

    await expect(
      prisma.user.create({
        data: {
          email: 'DBConstraint@Example.com', // case-variant, bypassando normalize do service
          passwordHash: 'fakehash',
          name: 'Bypass',
          role: 'tenant_owner',
        },
      }),
    ).rejects.toThrow(/Unique constraint|user_email_lower_unique|already exists/i);
  });
```

**Nota:** Em vez de `app.get('PrismaService')` raw, pode ser mais idiomático importar `PrismaService` do projeto e usar `app.get(PrismaService)`. Verificar o padrão usado em outros e2e (`grep "app.get" test/e2e/*.ts`) e seguir.

- [ ] **Step 2: Rodar test pra verificar FALHA**

```bash
pnpm test:e2e -- auth-onboarding
```

Expected: teste **FALHA** porque o constraint atual é `@unique email` cru (case-sensitive). INSERT com `DBConstraint@Example.com` passa porque case-sensitive DB enxerga como diferente de `dbconstraint@example.com`.

- [ ] **Step 3: Criar migration SQL**

```bash
pnpm prisma migrate dev --name user_email_case_insensitive --create-only
```

Isso cria pasta `prisma/migrations/<timestamp>_user_email_case_insensitive/migration.sql` com SQL auto-gerado (provavelmente vazio ou tentando dropar @unique baseado no schema — vamos sobrescrever).

Abrir o arquivo `migration.sql` recém-criado e **substituir todo o conteúdo** por:

```sql
-- Migration: User email case-insensitive uniqueness
-- Spec: docs/superpowers/specs/2026-05-21-billing-hardening-v2-design.md R-F1-07

-- Step 1: normalize existing rows (idempotente; sem efeito se já foram salvos lowercase pela Task 4)
UPDATE "User" SET email = LOWER(TRIM(email)) WHERE email <> LOWER(TRIM(email));

-- Step 2: drop legacy unique constraint
ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_email_key";

-- Step 3: create functional unique index
-- Falha-rápido (D-04 do spec) se houver duplicates case-insensitive remanescentes
CREATE UNIQUE INDEX "user_email_lower_unique" ON "User" (LOWER(email));
```

- [ ] **Step 4: Atualizar `schema.prisma`**

Em `prisma/schema.prisma`, localizar o model `User` (linha ~52) e o campo email (linha 54). **Remover** o `@unique` do campo email:

```prisma
model User {
  // ... outros campos
  email           String              // ← era: email String @unique
  // ... outros campos
}
```

**Importante:** O índice funcional `UNIQUE LOWER(email)` não é expressável no Prisma schema (até v5.x). Adicionar comment explicativo logo acima do campo:

```prisma
  // Unique constraint é funcional (LOWER(email)) criado por migration manual:
  // prisma/migrations/<timestamp>_user_email_case_insensitive
  // Não expressável no schema do Prisma 5.x. Não adicionar @unique aqui (conflitaria).
  email           String
```

- [ ] **Step 5: Aplicar a migration localmente**

```bash
pnpm prisma migrate dev
```

Expected: migration aplica sem erro, gera/atualiza Prisma Client. Se o `UPDATE` der erro de "duplicate key" no `CREATE UNIQUE INDEX`, **PARAR** — há duplicates no banco local que precisam de cleanup (lembrar: D-04 diz banco assumido limpo). Cleanup local:

```bash
SEED_RESET=true pnpm prisma:seed
pnpm prisma migrate reset
pnpm prisma migrate dev
```

- [ ] **Step 6: Rodar test e verificar PASSA**

```bash
pnpm test:e2e -- auth-onboarding
```

Expected: **todos os 5+ testes do describe passam**, incluindo o novo "DB rejeita INSERT direto".

- [ ] **Step 7: Rodar suite full + lint + build**

```bash
pnpm lint
pnpm test
pnpm test:e2e
pnpm build
```

Expected: tudo verde. Se Prisma Client gerado tiver erro de tipo (campo email sem `@unique` muda métodos como `findUnique({ where: { email } })`), corrigir os call sites:

- `findUnique({ where: { email } })` → `findFirst({ where: { email } })` OU manter `findUnique` se o índice funcional for reconhecido pelo Prisma (improvável em v5.x).
- **Verificação:** rodar `pnpm tsc --noEmit` e mapear erros de tipo. Mais provável: nenhum impacto, porque o único `findUnique({ where: { email } })` está em `user.repository.ts:findByEmail`, e Prisma pode ou não reconhecer o índice funcional como `unique` na tipagem.

Se Prisma reclamar: trocar `findUnique` por `findFirst` no `user.repository.ts:findByEmail`:

```ts
  findByEmail(email: string) {
    return this.prisma.user.findFirst({
      where: { email: email.trim().toLowerCase() },
    });
  }
```

Semanticamente equivalente porque o índice funcional garante unicidade.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/ test/e2e/auth-onboarding.e2e-spec.ts src/modules/auth/repositories/user.repository.ts
git commit -m "$(cat <<'EOF'
feat(auth): índice funcional UNIQUE LOWER(email) na tabela User (F1 R-F1-07/08)

Substitui @unique cru (case-sensitive) por:
  CREATE UNIQUE INDEX user_email_lower_unique ON "User"(LOWER(email))

Backstop em camada de DB: mesmo se algum write futuro bypass o
normalize do service, o constraint funcional rejeita case-variant.

Schema sem @unique no campo email (Prisma 5.x não suporta index
funcional nativo). Migration faz UPDATE normalizador antes do
CREATE INDEX — falha-rápido se houver duplicates remanescentes
(D-04 do spec: banco assumido limpo, sem cleanup defensivo).

Spec: docs/superpowers/specs/2026-05-21-billing-hardening-v2-design.md
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Verificação final + nota de deploy

**Files:** N/A (verificação operacional).

- [ ] **Step 1: Conferir acceptance da spec F1**

Bater cada checkbox da §7 Acceptance da spec (`2026-05-21-billing-hardening-v2-design.md`):

- [ ] `POST /auth/register/owner` tem `@Throttle({ default: { limit: 3, ttl: 60_000 } })` — confirmar via grep:
  ```bash
  grep -A2 "register/owner" src/modules/auth/auth.controller.ts | grep Throttle
  ```
- [ ] 4ª chamada retorna 429 — coberto por teste e2e (Task 2).
- [ ] Signup com `email: 'Test@X.com'` cria User com `email = 'test@x.com'` — coberto por teste "grava email normalizado" (Task 4).
- [ ] Segundo signup case-variant retorna 409 — coberto por teste "rejeita signup case-variant" (Task 4).
- [ ] `findByEmail('Test@X.com')` retorna user — coberto por teste "login funciona case-variant" (Task 3).
- [ ] Migration roda sem erro com banco limpo — manualmente verificado em Task 5 Step 5.
- [ ] DB rejeita INSERT direto — coberto por teste "DB rejeita INSERT case-variant" (Task 5).
- [ ] `pnpm test`, `pnpm test:e2e`, `pnpm lint`, `pnpm build` verdes — Task 5 Step 7.

- [ ] **Step 2: Conferir anti-acceptance (✅ todos não ocorreram)**

- ❌ Signup retorna 201 em chamada paralela com email case-variant → **NÃO** (teste Task 4 prova 409).
- ❌ `User.email` no DB tem letra maiúscula → **NÃO** (migration normaliza, service normaliza).
- ❌ Migration cria index sem `UPDATE` prévio → **NÃO** (Task 5 Step 3 SQL tem `UPDATE` antes).
- ❌ Lookup de email em service usa `dto.email` cru → **NÃO** (Task 4 substituiu).
- ❌ Throttle bloqueia 1-2 signups legítimos → **NÃO** (limit é 3 inclusive, testado).
- ❌ Email aliases (`+1`) são strip → **NÃO** (D-02: só `.trim().toLowerCase()`).

- [ ] **Step 3: Nota de deploy no PR**

Quando abrir o PR, escrever na descrição:

```
## Deploy notes — F1 signup hardening

Pre-flight executado em 2026-05-21:
- ✅ 0 duplicates em prod (query: `SELECT LOWER(TRIM(email))...GROUP BY...HAVING COUNT(*) > 1`)
- ✅ 0 duplicates em dev

Migration aplica em produção via Railway auto-deploy (branch main).
Falha-rápido configurada (D-04 da spec): se algum write não-instrumentado
salvou duplicate entre pre-flight e deploy, migration aborta o deploy.

Rollback: revert do PR + reapply do legacy @unique se necessário (improvável).
```

- [ ] **Step 4: Verificação manual de smoke (opcional, recomendado antes de mergear)**

Subir local com banco fresh:

```bash
docker compose up -d postgres redis
pnpm prisma migrate dev
pnpm start:dev
```

Em outro terminal:

```bash
# Signup case-variant 1
curl -X POST http://localhost:3000/auth/register/owner \
  -H 'Content-Type: application/json' \
  -d '{"email":"Smoke@X.com","password":"StrongPass!1","name":"Smoke","tenantName":"Smoke","slug":"smoke-1"}'

# Esperado: 201, body.user.email === "smoke@x.com"

# Signup case-variant 2 — mesmo email lowercase
curl -X POST http://localhost:3000/auth/register/owner \
  -H 'Content-Type: application/json' \
  -d '{"email":"SMOKE@X.com","password":"StrongPass!1","name":"Smoke 2","tenantName":"Smoke 2","slug":"smoke-2"}'

# Esperado: 409, code: EMAIL_ALREADY_REGISTERED

# 4ª request (após 2 acima + uma com slug-3 que falhará por slug) em < 60s
for i in 1 2 3 4; do
  curl -X POST http://localhost:3000/auth/register/owner \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"throttle$i@x.com\",\"password\":\"StrongPass!1\",\"name\":\"T\",\"tenantName\":\"T\",\"slug\":\"throttle-smoke-$i\"}"
  echo ""
done

# Esperado: 201, 201, 201, 429
```

---

## Self-Review (já executado pelo autor do plano)

**Spec coverage:**
- R-F1-01 (throttle) → Task 2 ✅
- R-F1-02 (normalize registerOwner) → Task 4 Step 3 ✅
- R-F1-03 (normalize findByEmail) → Task 3 Step 3 ✅
- R-F1-04 (normalize login) → Task 4 Step 4 ✅
- R-F1-05 (normalize forgotPassword) → Task 4 Step 5 ✅
- R-F1-06 (auditar outros writes) → Task 4 Step 6 ✅
- R-F1-07 (migration SQL) → Task 5 Step 3 ✅
- R-F1-08 (schema.prisma sem @unique) → Task 5 Step 4 ✅
- R-F1-09 (testes) → Tasks 2/3/4/5 distribuídos ✅

**Acceptance coverage:** 8/8 (Task 6 Step 1).

**Anti-acceptance coverage:** 6/6 (Task 6 Step 2).

**Placeholders:** nenhum TBD/TODO. Todos os steps mostram código exato.

**Type consistency:** `email` (const local) usado consistentemente em registerOwner. Outros call sites preservam parâmetro `email` original. Nenhum rename meio-do-caminho.

**Conhecidos pontos frágeis (mitigados):**
- Task 3 teste passa vermelho temporário até Task 4 (Step 5 da Task 3 documenta).
- Prisma `findUnique` vs `findFirst` ambiguidade após remover `@unique` — Task 5 Step 7 cobre fallback pra `findFirst`.

---

## Histórico

| Data | Mudança |
|---|---|
| 2026-05-21 | Versão inicial. Plano executável da F1 (signup hardening). Spec: `2026-05-21-billing-hardening-v2-design.md`. |
