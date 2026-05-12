# KairoBarber — Fase 2 (Painel do Barbeiro) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar o painel privado do barbeiro: o dono da barbearia (tenant_owner) consegue, via endpoints autenticados, configurar a barbearia inteira — perfil + endereço + foto, horário de funcionamento, 3 barbeiros (com convite por email e time-off), 5 serviços (com vínculo barbeiro↔serviço) e 10 fotos (upload via presigned URL para R2). Nada de público nem de pagamento ainda.

**Architecture:** Continua o monolito modular NestJS. Três novos módulos: `barbers`, `catalog` (services + photos), `storage`. O módulo `tenants` ganha endpoints de update e business-hours. O módulo `auth` ganha endpoint público de aceite de convite. Multi-tenancy continua via Prisma extension `scoped` + `TenantGuard`: a lista `TENANT_SCOPED_MODELS` é estendida para Barber, TimeOff, Service, ServiceBarber, Photo e BarberInvitation. Upload de foto é direto cliente↔R2 via presigned PUT (servidor só emite URL e confirma); abstração `StorageProvider` espelha o padrão de `EmailProvider`.

**Tech Stack:** Continua tudo da Fase 0+1. Novidades: `@aws-sdk/client-s3@^3` e `@aws-sdk/s3-request-presigner@^3` para presigned URLs no Cloudflare R2 (S3-compatible). `crypto.randomUUID()` (nativo, sem dep nova) para r2Key.

**Spec de referência:** [`docs/superpowers/specs/2026-05-11-kairobarber-backend-design.md`](../specs/2026-05-11-kairobarber-backend-design.md) (seção 4 — Fase 2; seção 6 — modelo de dados; seção 7 — endpoints).

**Plano anterior:** [`2026-05-11-kairobarber-fase-0-1.md`](./2026-05-11-kairobarber-fase-0-1.md) (estado atual do código).

---

## Estado atual do repositório (entrada da Fase 2)

- `prisma/schema.prisma` tem `User`, `Tenant`, `Subscription`, `RefreshToken`, `OneTimeToken` (migrations `20260511214551_init_identity` + `20260511214945_add_relation_on_delete`).
- `src/infra/prisma/prisma.service.ts` expõe `PrismaService.scoped` com filtro automático de tenant. `TENANT_SCOPED_MODELS` hoje contém só `'Subscription'`.
- `src/modules/auth` tem `register/owner`, `login`, `refresh`, `logout`, `verify-email`, `forgot-password`, `reset-password`. `JwtAuthGuard` é `APP_GUARD` global; `@Public()` desativa por handler.
- `src/modules/tenants` tem só `GET /admin/tenant` e o `subscription-debug` usado pelo teste de isolation.
- `src/modules/notifications` tem `EMAIL_PROVIDER` injection token + `ConsoleEmailProvider`.
- Test harness em `test/support/{postgres-container,test-app,test-env}.ts`. Migrations rodam via `prisma migrate deploy` quando o container sobe.

---

## Estrutura de arquivos resultante (delta da Fase 2)

```
kairobarber/
├── prisma/
│   ├── schema.prisma                                       # ATUALIZA: novos modelos
│   └── migrations/
│       └── <novo timestamp>_phase2_barber_panel/           # NOVO: migration
│           └── migration.sql
│
├── src/
│   ├── config/
│   │   └── env.validation.ts                               # ATUALIZA: STORAGE_PROVIDER + R2_*
│   │
│   ├── common/
│   │   └── exceptions/
│   │       └── error-codes.ts                              # ATUALIZA: códigos da Fase 2
│   │
│   ├── infra/
│   │   └── prisma/
│   │       └── prisma.service.ts                           # ATUALIZA: TENANT_SCOPED_MODELS
│   │
│   └── modules/
│       ├── auth/
│       │   ├── auth.controller.ts                          # ATUALIZA: POST /auth/barbers/accept-invite
│       │   ├── auth.service.ts                             # ATUALIZA: aceita convite; login resolve tenant pra barber_member
│       │   └── dto/
│       │       └── accept-barber-invite.dto.ts             # NOVO
│       │
│       ├── tenants/
│       │   ├── tenants.controller.ts                       # ATUALIZA: PATCH endpoints
│       │   ├── tenants.service.ts                          # ATUALIZA: update + business-hours
│       │   ├── business-hours.ts                           # NOVO: tipos + validador
│       │   ├── business-hours.spec.ts                      # NOVO
│       │   └── dto/
│       │       ├── update-tenant.dto.ts                    # NOVO
│       │       └── update-business-hours.dto.ts            # NOVO
│       │
│       ├── barbers/                                        # NOVO MÓDULO
│       │   ├── barbers.module.ts
│       │   ├── barbers.controller.ts
│       │   ├── barbers.service.ts
│       │   ├── barbers.service.spec.ts
│       │   ├── time-off.controller.ts
│       │   ├── time-off.service.ts
│       │   ├── time-off.service.spec.ts
│       │   ├── barber-invitations.service.ts
│       │   ├── barber-invitations.service.spec.ts
│       │   ├── repositories/
│       │   │   ├── barber.repository.ts
│       │   │   ├── time-off.repository.ts
│       │   │   └── barber-invitation.repository.ts
│       │   └── dto/
│       │       ├── create-barber.dto.ts
│       │       ├── update-barber.dto.ts
│       │       └── create-time-off.dto.ts
│       │
│       ├── catalog/                                        # NOVO MÓDULO
│       │   ├── catalog.module.ts
│       │   ├── services.controller.ts
│       │   ├── services.service.ts
│       │   ├── services.service.spec.ts
│       │   ├── photos.controller.ts
│       │   ├── photos.service.ts
│       │   ├── photos.service.spec.ts
│       │   ├── repositories/
│       │   │   ├── service.repository.ts
│       │   │   └── photo.repository.ts
│       │   └── dto/
│       │       ├── create-service.dto.ts
│       │       ├── update-service.dto.ts
│       │       ├── set-service-barbers.dto.ts
│       │       ├── create-photo-upload-url.dto.ts
│       │       └── create-photo.dto.ts
│       │
│       └── storage/                                        # NOVO MÓDULO
│           ├── storage.module.ts
│           ├── storage.provider.ts                         # interface + token + tipos
│           └── providers/
│               ├── console-storage.provider.ts             # in-memory pra dev/test
│               ├── console-storage.provider.spec.ts
│               └── r2-storage.provider.ts                  # impl real (Cloudflare R2)
│
│   └── app.module.ts                                       # ATUALIZA: registra BarbersModule, CatalogModule, StorageModule
│
├── test/
│   └── e2e/
│       └── barber-panel-setup.e2e-spec.ts                  # NOVO: happy path acceptance
│
├── package.json                                            # ATUALIZA: @aws-sdk/*
└── .env.example                                            # ATUALIZA: STORAGE_PROVIDER + R2_*
```

---

## Decisões importantes desta fase (registrar antes de codar)

1. **Convite por email**: tabela dedicada `BarberInvitation` (token único, hashado, sem userId). Distinta de `OneTimeToken` porque o usuário ainda não existe. Aceite cria User + Atribui `barberId.userId`.
2. **Login do barber_member**: na Fase 1 `auth.service.login` resolvia tenantId só por `Tenant.ownerUserId`. Nesta fase, se `user.role === 'barber_member'`, resolve por `Barber.userId`. Mesma lógica em `refresh`.
3. **Owner-as-barber**: fora de escopo do MVP. Se o owner quiser cortar cabelo, registra um Barber com email diferente. Documentado no parking-lot da spec via spec — sem código especial.
4. **Soft delete de Photo / Barber / Service**: marcamos `deletedAt` na linha. Limpeza de R2 fica pra cron de cleanup futuro (LGPD). Listagens filtram `deletedAt: null`.
5. **PUT /admin/services/:id/barbers**: substitui o conjunto inteiro de `ServiceBarber` para aquele service, em transação. Valida que todos os barberIds pertencem ao tenant.
6. **Presigned URL**: TTL 60s. r2Key padrão `tenants/{tenantId}/photos/{uuid}.{ext}`. Tenant nunca aparece exposto no path público — só interno do bucket. Allowlist de contentType: `image/jpeg`, `image/png`, `image/webp`. Tamanho enforced pelo R2 via Content-Length-Range no presign (5MB máx).
7. **TimeOff**: validação obrigatória `endsAt > startsAt`. Sem checagem de overlap entre TimeOffs do mesmo barbeiro (consultas futuras de availability lidam com isso).
8. **Business hours**: estrutura `{ days: BusinessDay[7] }` onde `days[0]` é domingo, `days[6]` é sábado (matches `Date.getDay()`). Cada `BusinessDay = { open: boolean, intervals: Array<{ startMin: number, endMin: number }> }`. Validação obrigatória: `0 <= startMin < endMin <= 1440`.
9. **Tenant scoping no Prisma**: TODOS os novos modelos vão na lista `TENANT_SCOPED_MODELS`. `ServiceBarber` também — ele não tem coluna `tenantId` direta, mas as inserções vão pela transação dentro do escopo do tenant (vide Task 11). Para o filtro automático funcionar em queries de leitura, é mais simples adicionar `tenantId` em `ServiceBarber` também (denormalização barata + reforça isolation). Ver Task 1.

---

## Pré-requisitos por tarefa

- Stack já bootstrapped na Fase 0/1.
- Container Postgres roda via testcontainers; nada externo é tocado pelos testes.
- Cada tarefa termina com `npm run lint && npm run test` verdes antes do commit.

---

## Task 1: Schema + migration — novos modelos e campos da Fase 2

**Files:**
- Modify: `prisma/schema.prisma`
- Create (gerado pela CLI): `prisma/migrations/<timestamp>_phase2_barber_panel/migration.sql`

- [ ] **Step 1.1: Estender o schema Prisma**

Edite `prisma/schema.prisma`. Acrescente os campos novos no `Tenant`, adicione a relation inversa em `User`, e crie os modelos novos no fim do arquivo:

```prisma
// (Tenant — substituir o bloco atual)
model Tenant {
  id            String    @id @default(cuid())
  slug          String    @unique
  name          String
  bio           String?
  address       String?
  phone         String?
  avatarUrl     String?
  timezone      String    @default("America/Sao_Paulo")
  businessHours Json?
  ownerUserId   String    @unique
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  deletedAt     DateTime?

  owner             User               @relation("TenantOwner", fields: [ownerUserId], references: [id], onDelete: Restrict)
  subscription      Subscription?
  barbers           Barber[]
  services          Service[]
  photos            Photo[]
  barberInvitations BarberInvitation[]
  timeOffs          TimeOff[]
  serviceBarbers    ServiceBarber[]

  @@index([deletedAt])
}

// (User — adicionar a relation inversa de Barber)
model User {
  id              String    @id @default(cuid())
  email           String    @unique
  passwordHash    String
  name            String
  role            UserRole
  emailVerifiedAt DateTime?
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  ownedTenant   Tenant?        @relation("TenantOwner")
  refreshTokens RefreshToken[]
  oneTimeTokens OneTimeToken[]
  barberProfile Barber?        @relation("BarberUser")
}

// (Novos modelos — anexar no fim do arquivo)

model Barber {
  id          String    @id @default(cuid())
  tenantId    String
  userId      String?   @unique
  displayName String
  bio         String?
  avatarUrl   String?
  active      Boolean   @default(true)
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  deletedAt   DateTime?

  tenant         Tenant            @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  user           User?             @relation("BarberUser", fields: [userId], references: [id], onDelete: SetNull)
  timeOffs       TimeOff[]
  serviceBarbers ServiceBarber[]
  photos         Photo[]
  invitation     BarberInvitation?

  @@index([tenantId, deletedAt])
}

model TimeOff {
  id        String   @id @default(cuid())
  tenantId  String
  barberId  String
  startsAt  DateTime
  endsAt    DateTime
  reason    String?
  createdAt DateTime @default(now())

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  barber Barber @relation(fields: [barberId], references: [id], onDelete: Cascade)

  @@index([tenantId, barberId, startsAt])
}

model Service {
  id          String    @id @default(cuid())
  tenantId    String
  name        String
  description String?
  durationMin Int
  priceCents  Int
  active      Boolean   @default(true)
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  deletedAt   DateTime?

  tenant         Tenant          @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  serviceBarbers ServiceBarber[]
  photos         Photo[]

  @@index([tenantId, deletedAt])
}

model ServiceBarber {
  tenantId  String
  serviceId String
  barberId  String

  tenant  Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  service Service @relation(fields: [serviceId], references: [id], onDelete: Cascade)
  barber  Barber  @relation(fields: [barberId], references: [id], onDelete: Cascade)

  @@id([serviceId, barberId])
  @@index([tenantId])
}

model Photo {
  id        String    @id @default(cuid())
  tenantId  String
  r2Key     String
  caption   String?
  serviceId String?
  barberId  String?
  createdAt DateTime  @default(now())
  deletedAt DateTime?

  tenant  Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  service Service? @relation(fields: [serviceId], references: [id], onDelete: SetNull)
  barber  Barber?  @relation(fields: [barberId], references: [id], onDelete: SetNull)

  @@index([tenantId, deletedAt])
}

model BarberInvitation {
  id         String    @id @default(cuid())
  tenantId   String
  barberId   String    @unique
  email      String
  tokenHash  String    @unique
  expiresAt  DateTime
  acceptedAt DateTime?
  createdAt  DateTime  @default(now())

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  barber Barber @relation(fields: [barberId], references: [id], onDelete: Cascade)

  @@index([tenantId])
  @@index([email])
}
```

- [ ] **Step 1.2: Gerar migration**

Run:
```bash
npx prisma migrate dev --name phase2_barber_panel
```
Expected: cria `prisma/migrations/<timestamp>_phase2_barber_panel/migration.sql`. Cliente Prisma regenera automaticamente.

- [ ] **Step 1.3: Sanity-check do schema**

Run:
```bash
npx prisma format && npx prisma validate
```
Expected: sem erros.

- [ ] **Step 1.4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(schema): phase 2 models for barber panel"
```

---

## Task 2: PrismaService — incluir novos modelos no tenant scoping + teste de regressão

**Files:**
- Modify: `src/infra/prisma/prisma.service.ts:1-95`
- Test: `test/e2e/tenant-isolation.e2e-spec.ts:1-118` (estender)

- [ ] **Step 2.1: Escrever teste de regressão de isolation pros novos modelos**

Em `test/e2e/tenant-isolation.e2e-spec.ts` adicione, antes do `afterAll`, um teste novo que cria um Barber em cada tenant e prova que `scoped.barber.findMany()` só retorna o do tenant atual. Append depois do último `it(...)`:

```typescript
  it('scoped middleware also filters Barber for tenants A and B', async () => {
    // Create a barber for each tenant via raw scoped client (mirrors what BarbersService will do)
    // We hit a debug endpoint we will NOT add — instead we use PrismaService directly via the Nest container.
    const { PrismaService } = await import('src/infra/prisma/prisma.service');
    const prisma = app.get(PrismaService);

    await prisma.withTenant(tenantAId, async () => {
      await prisma.scoped.barber.create({ data: { displayName: 'Barbeiro A1' } });
    });
    await prisma.withTenant(tenantBId, async () => {
      await prisma.scoped.barber.create({ data: { displayName: 'Barbeiro B1' } });
    });

    const seenByA = await prisma.withTenant(tenantAId, () => prisma.scoped.barber.findMany());
    const seenByB = await prisma.withTenant(tenantBId, () => prisma.scoped.barber.findMany());

    expect(seenByA.map((b) => b.displayName)).toEqual(['Barbeiro A1']);
    expect(seenByB.map((b) => b.displayName)).toEqual(['Barbeiro B1']);
  });
```

- [ ] **Step 2.2: Rodar o teste e ver FALHAR**

Run:
```bash
npm run test:e2e -- --testPathPattern tenant-isolation
```
Expected: o novo `it` falha (Barber sem tenantId não é injetado) ou retorna registros de outro tenant.

- [ ] **Step 2.3: Estender TENANT_SCOPED_MODELS**

Edite `src/infra/prisma/prisma.service.ts:9-14`. Substitua a constante:

```typescript
const TENANT_SCOPED_MODELS = new Set<string>([
  'Subscription',
  'Barber',
  'TimeOff',
  'Service',
  'ServiceBarber',
  'Photo',
  'BarberInvitation',
]);
```

Nada mais muda — a extension já trata create/findMany/etc.

- [ ] **Step 2.4: Rodar tudo de novo e ver PASSAR**

Run:
```bash
npm run test:e2e
```
Expected: PASS em todos os e2e.

- [ ] **Step 2.5: Commit**

```bash
git add src/infra/prisma/prisma.service.ts test/e2e/tenant-isolation.e2e-spec.ts
git commit -m "feat(prisma): scope phase 2 models in tenant middleware + regression test"
```

---

## Task 3: Códigos de erro da Fase 2

**Files:**
- Modify: `src/common/exceptions/error-codes.ts:1-22`

- [ ] **Step 3.1: Adicionar códigos novos**

Edite `src/common/exceptions/error-codes.ts`. Adicione abaixo do bloco `// Auth (Fase 1)`:

```typescript
  // Phase 2 — barber panel
  BARBER_NOT_FOUND: 'BARBER_NOT_FOUND',
  TIME_OFF_NOT_FOUND: 'TIME_OFF_NOT_FOUND',
  TIME_OFF_INVALID_RANGE: 'TIME_OFF_INVALID_RANGE',
  SERVICE_NOT_FOUND: 'SERVICE_NOT_FOUND',
  PHOTO_NOT_FOUND: 'PHOTO_NOT_FOUND',
  BUSINESS_HOURS_INVALID: 'BUSINESS_HOURS_INVALID',
  STORAGE_CONTENT_TYPE_INVALID: 'STORAGE_CONTENT_TYPE_INVALID',
  INVITATION_INVALID: 'INVITATION_INVALID',
  INVITATION_EXPIRED: 'INVITATION_EXPIRED',
  INVITATION_ALREADY_ACCEPTED: 'INVITATION_ALREADY_ACCEPTED',
  SERVICE_BARBER_MISMATCH: 'SERVICE_BARBER_MISMATCH',
```

- [ ] **Step 3.2: Verificar typecheck**

Run:
```bash
npm run build
```
Expected: sem erros (apenas adições de strings na const).

- [ ] **Step 3.3: Commit**

```bash
git add src/common/exceptions/error-codes.ts
git commit -m "feat(errors): add phase 2 error codes"
```

---

## Task 4: Módulo storage — interface + ConsoleStorageProvider + módulo

**Files:**
- Create: `src/modules/storage/storage.provider.ts`
- Create: `src/modules/storage/providers/console-storage.provider.ts`
- Create: `src/modules/storage/providers/console-storage.provider.spec.ts`
- Create: `src/modules/storage/storage.module.ts`
- Modify: `src/config/env.validation.ts`
- Modify: `src/app.module.ts`
- Modify: `.env.example`

- [ ] **Step 4.1: Adicionar config de storage**

Em `src/config/env.validation.ts`, dentro de `envValidationSchema`, adicione antes de `SENTRY_DSN`:

```typescript
  STORAGE_PROVIDER: Joi.string().valid('console', 'r2').default('console'),
  R2_ACCOUNT_ID: Joi.string().when('STORAGE_PROVIDER', {
    is: 'r2',
    then: Joi.required(),
    otherwise: Joi.optional().allow(''),
  }),
  R2_ACCESS_KEY_ID: Joi.string().when('STORAGE_PROVIDER', {
    is: 'r2',
    then: Joi.required(),
    otherwise: Joi.optional().allow(''),
  }),
  R2_SECRET_ACCESS_KEY: Joi.string().when('STORAGE_PROVIDER', {
    is: 'r2',
    then: Joi.required(),
    otherwise: Joi.optional().allow(''),
  }),
  R2_BUCKET: Joi.string().when('STORAGE_PROVIDER', {
    is: 'r2',
    then: Joi.required(),
    otherwise: Joi.optional().allow(''),
  }),
```

E no `AppEnv` type:

```typescript
  STORAGE_PROVIDER: 'console' | 'r2';
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET?: string;
```

- [ ] **Step 4.2: Refletir em `.env.example`**

Append em `.env.example`:

```
STORAGE_PROVIDER=console
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=
```

- [ ] **Step 4.3: Criar a interface do provider**

Crie `src/modules/storage/storage.provider.ts`:

```typescript
export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');

export type PresignedUpload = {
  uploadUrl: string;
  r2Key: string;
  expiresAt: Date;
  contentType: string;
  maxBytes: number;
};

export interface StorageProvider {
  /**
   * Returns a presigned PUT URL that lets the client upload directly to the underlying object store.
   * Caller MUST validate contentType before calling.
   */
  presignUpload(input: {
    tenantId: string;
    contentType: string;
    extension: string;
    maxBytes: number;
    ttlSeconds: number;
  }): Promise<PresignedUpload>;

  /** Best-effort delete; missing object is not an error. */
  delete(r2Key: string): Promise<void>;
}

export const ALLOWED_PHOTO_CONTENT_TYPES = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export const PHOTO_MAX_BYTES = 5 * 1024 * 1024; // 5MB

export function extensionFromContentType(contentType: string): string {
  switch (contentType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    default:
      throw new Error(`Unsupported content type: ${contentType}`);
  }
}
```

- [ ] **Step 4.4: Escrever o teste do ConsoleStorageProvider**

Crie `src/modules/storage/providers/console-storage.provider.spec.ts`:

```typescript
import { ConsoleStorageProvider } from './console-storage.provider';

describe('ConsoleStorageProvider', () => {
  const provider = new ConsoleStorageProvider();

  it('returns a presigned URL containing the tenant-scoped r2Key', async () => {
    const res = await provider.presignUpload({
      tenantId: 'tenant-1',
      contentType: 'image/jpeg',
      extension: 'jpg',
      maxBytes: 100,
      ttlSeconds: 60,
    });
    expect(res.r2Key).toMatch(/^tenants\/tenant-1\/photos\/[a-f0-9-]{36}\.jpg$/);
    expect(res.uploadUrl).toContain('storage.local');
    expect(res.uploadUrl).toContain(res.r2Key);
    expect(res.contentType).toBe('image/jpeg');
    expect(res.maxBytes).toBe(100);
    expect(res.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('delete() never throws even for unknown keys', async () => {
    await expect(provider.delete('nope')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 4.5: Rodar teste e ver FALHAR**

Run:
```bash
npx jest --config jest.config.ts src/modules/storage/providers/console-storage.provider.spec.ts
```
Expected: FAIL "Cannot find module './console-storage.provider'".

- [ ] **Step 4.6: Implementar ConsoleStorageProvider**

Crie `src/modules/storage/providers/console-storage.provider.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PresignedUpload, StorageProvider } from '../storage.provider';

@Injectable()
export class ConsoleStorageProvider implements StorageProvider {
  async presignUpload(input: {
    tenantId: string;
    contentType: string;
    extension: string;
    maxBytes: number;
    ttlSeconds: number;
  }): Promise<PresignedUpload> {
    const r2Key = `tenants/${input.tenantId}/photos/${randomUUID()}.${input.extension}`;
    const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
    const uploadUrl = `http://storage.local/upload/${r2Key}?expires=${expiresAt.toISOString()}`;
    return {
      uploadUrl,
      r2Key,
      expiresAt,
      contentType: input.contentType,
      maxBytes: input.maxBytes,
    };
  }

  async delete(_r2Key: string): Promise<void> {
    // no-op in console mode
  }
}
```

- [ ] **Step 4.7: Rodar teste e ver PASSAR**

Run:
```bash
npx jest --config jest.config.ts src/modules/storage/providers/console-storage.provider.spec.ts
```
Expected: PASS 2/2.

- [ ] **Step 4.8: Criar StorageModule**

Crie `src/modules/storage/storage.module.ts`:

```typescript
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { STORAGE_PROVIDER } from './storage.provider';
import { ConsoleStorageProvider } from './providers/console-storage.provider';

@Global()
@Module({
  providers: [
    {
      provide: STORAGE_PROVIDER,
      useFactory: (cfg: ConfigService) => {
        const provider = cfg.get<string>('STORAGE_PROVIDER');
        if (provider === 'console') return new ConsoleStorageProvider();
        // R2 será adicionado na Task 13
        throw new Error(`Unsupported STORAGE_PROVIDER: ${provider}`);
      },
      inject: [ConfigService],
    },
  ],
  exports: [STORAGE_PROVIDER],
})
export class StorageModule {}
```

- [ ] **Step 4.9: Registrar no AppModule**

Em `src/app.module.ts:1-33`, adicione o import e o módulo:

```typescript
import { StorageModule } from './modules/storage/storage.module';
```
e adicione `StorageModule` na lista `imports:` depois de `NotificationsModule`.

- [ ] **Step 4.10: Lint + test geral**

Run:
```bash
npm run lint && npm run test
```
Expected: tudo verde.

- [ ] **Step 4.11: Commit**

```bash
git add src/modules/storage src/config/env.validation.ts src/app.module.ts .env.example
git commit -m "feat(storage): module + ConsoleStorageProvider + env wiring"
```

---

## Task 5: Tenants — PATCH /admin/tenant + PATCH /admin/tenant/business-hours

**Files:**
- Create: `src/modules/tenants/business-hours.ts`
- Create: `src/modules/tenants/business-hours.spec.ts`
- Create: `src/modules/tenants/dto/update-tenant.dto.ts`
- Create: `src/modules/tenants/dto/update-business-hours.dto.ts`
- Modify: `src/modules/tenants/tenants.service.ts:1-35`
- Modify: `src/modules/tenants/tenants.controller.ts:1-34`
- Modify: `src/modules/tenants/repositories/tenant.repository.ts:1-15`
- Modify: `src/modules/tenants/tenants.module.ts:1-10`

- [ ] **Step 5.1: Escrever teste de business-hours**

Crie `src/modules/tenants/business-hours.spec.ts`:

```typescript
import { validateBusinessHours, BUSINESS_HOURS_EMPTY } from './business-hours';

describe('validateBusinessHours', () => {
  it('accepts a default empty week', () => {
    expect(() => validateBusinessHours(BUSINESS_HOURS_EMPTY)).not.toThrow();
  });

  it('accepts a full valid week with multiple intervals per day', () => {
    const bh = {
      days: [
        { open: false, intervals: [] },
        { open: true, intervals: [{ startMin: 540, endMin: 720 }, { startMin: 780, endMin: 1140 }] },
        { open: true, intervals: [{ startMin: 540, endMin: 1140 }] },
        { open: true, intervals: [{ startMin: 540, endMin: 1140 }] },
        { open: true, intervals: [{ startMin: 540, endMin: 1140 }] },
        { open: true, intervals: [{ startMin: 540, endMin: 1140 }] },
        { open: true, intervals: [{ startMin: 540, endMin: 1080 }] },
      ],
    };
    expect(() => validateBusinessHours(bh)).not.toThrow();
  });

  it('rejects when days length != 7', () => {
    expect(() => validateBusinessHours({ days: [] })).toThrow(/exactly 7/);
  });

  it('rejects an interval where endMin <= startMin', () => {
    const bh = {
      days: [
        { open: true, intervals: [{ startMin: 600, endMin: 600 }] },
        ...Array(6).fill({ open: false, intervals: [] }),
      ],
    };
    expect(() => validateBusinessHours(bh)).toThrow(/start.*end/i);
  });

  it('rejects an interval out of [0, 1440]', () => {
    const bh = {
      days: [
        { open: true, intervals: [{ startMin: -10, endMin: 600 }] },
        ...Array(6).fill({ open: false, intervals: [] }),
      ],
    };
    expect(() => validateBusinessHours(bh)).toThrow(/0.*1440/);
  });

  it('rejects overlapping intervals in the same day', () => {
    const bh = {
      days: [
        { open: true, intervals: [{ startMin: 540, endMin: 720 }, { startMin: 700, endMin: 800 }] },
        ...Array(6).fill({ open: false, intervals: [] }),
      ],
    };
    expect(() => validateBusinessHours(bh)).toThrow(/overlap/i);
  });
});
```

- [ ] **Step 5.2: Rodar teste e ver FALHAR**

Run:
```bash
npx jest --config jest.config.ts src/modules/tenants/business-hours.spec.ts
```
Expected: FAIL — módulo não existe.

- [ ] **Step 5.3: Implementar `business-hours.ts`**

Crie `src/modules/tenants/business-hours.ts`:

```typescript
import { HttpStatus } from '@nestjs/common';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';

export type BusinessInterval = { startMin: number; endMin: number };
export type BusinessDay = { open: boolean; intervals: BusinessInterval[] };
export type BusinessHours = { days: BusinessDay[] };

export const BUSINESS_HOURS_EMPTY: BusinessHours = {
  days: Array.from({ length: 7 }, () => ({ open: false, intervals: [] })),
};

function fail(message: string): never {
  throw new DomainException({
    code: ErrorCodes.BUSINESS_HOURS_INVALID,
    message,
    status: HttpStatus.BAD_REQUEST,
  });
}

export function validateBusinessHours(input: unknown): asserts input is BusinessHours {
  if (!input || typeof input !== 'object') fail('businessHours must be an object');
  const days = (input as { days?: unknown }).days;
  if (!Array.isArray(days) || days.length !== 7) {
    fail('businessHours.days must have exactly 7 entries (Sun..Sat)');
  }
  for (let i = 0; i < 7; i++) {
    const day = days[i] as { open?: unknown; intervals?: unknown };
    if (typeof day.open !== 'boolean') fail(`day[${i}].open must be boolean`);
    if (!Array.isArray(day.intervals)) fail(`day[${i}].intervals must be an array`);

    if (!day.open && day.intervals.length > 0) {
      fail(`day[${i}] is closed but has intervals`);
    }

    const intervals = day.intervals as BusinessInterval[];
    for (let j = 0; j < intervals.length; j++) {
      const iv = intervals[j];
      if (
        typeof iv.startMin !== 'number' ||
        typeof iv.endMin !== 'number' ||
        !Number.isInteger(iv.startMin) ||
        !Number.isInteger(iv.endMin)
      ) {
        fail(`day[${i}].intervals[${j}] must have integer startMin/endMin`);
      }
      if (iv.startMin < 0 || iv.endMin > 1440) {
        fail(`day[${i}].intervals[${j}] must be within 0..1440`);
      }
      if (iv.startMin >= iv.endMin) {
        fail(`day[${i}].intervals[${j}] startMin must be < endMin`);
      }
    }
    const sorted = [...intervals].sort((a, b) => a.startMin - b.startMin);
    for (let j = 1; j < sorted.length; j++) {
      if (sorted[j].startMin < sorted[j - 1].endMin) {
        fail(`day[${i}] intervals overlap`);
      }
    }
  }
}
```

- [ ] **Step 5.4: Rodar teste e ver PASSAR**

Run:
```bash
npx jest --config jest.config.ts src/modules/tenants/business-hours.spec.ts
```
Expected: PASS 5/5.

- [ ] **Step 5.5: Criar DTOs**

Crie `src/modules/tenants/dto/update-tenant.dto.ts`:

```typescript
import { IsOptional, IsString, MaxLength, MinLength, IsUrl } from 'class-validator';

export class UpdateTenantDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(500) bio?: string | null;
  @IsOptional() @IsString() @MaxLength(200) address?: string | null;
  @IsOptional() @IsString() @MaxLength(40) phone?: string | null;
  @IsOptional() @IsUrl({ require_protocol: true }) avatarUrl?: string | null;
  @IsOptional() @IsString() @MaxLength(60) timezone?: string;
}
```

Crie `src/modules/tenants/dto/update-business-hours.dto.ts`:

```typescript
import { IsObject } from 'class-validator';

export class UpdateBusinessHoursDto {
  // Estrutura completa validada por validateBusinessHours dentro do service.
  // class-validator só garante que é objeto; semântica fica no domain validator.
  @IsObject() businessHours!: unknown;
}
```

- [ ] **Step 5.6: Estender TenantRepository**

Edite `src/modules/tenants/repositories/tenant.repository.ts`. Substitua todo o conteúdo:

```typescript
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class TenantRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string) {
    return this.prisma.tenant.findUnique({
      where: { id },
      include: { subscription: true },
    });
  }

  update(id: string, data: Prisma.TenantUpdateInput) {
    return this.prisma.tenant.update({ where: { id }, data });
  }
}
```

- [ ] **Step 5.7: Estender TenantsService**

Edite `src/modules/tenants/tenants.service.ts`. Substitua:

```typescript
import { HttpStatus, Injectable } from '@nestjs/common';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { TenantRepository } from './repositories/tenant.repository';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { validateBusinessHours, BusinessHours } from './business-hours';

@Injectable()
export class TenantsService {
  constructor(
    private readonly repo: TenantRepository,
    private readonly prisma: PrismaService,
  ) {}

  async getCurrent(tenantId: string) {
    const t = await this.repo.findById(tenantId);
    if (!t || t.deletedAt) {
      throw new DomainException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Tenant não encontrado.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    return t;
  }

  async update(tenantId: string, dto: UpdateTenantDto) {
    await this.getCurrent(tenantId); // 404 se não existe
    return this.repo.update(tenantId, dto);
  }

  async updateBusinessHours(tenantId: string, businessHours: unknown) {
    await this.getCurrent(tenantId);
    validateBusinessHours(businessHours);
    return this.repo.update(tenantId, {
      businessHours: businessHours as unknown as BusinessHours,
    });
  }

  listMySubscription() {
    return this.prisma.scoped.subscription.findMany({});
  }
}
```

- [ ] **Step 5.8: Estender TenantsController**

Edite `src/modules/tenants/tenants.controller.ts`. Substitua o conteúdo:

```typescript
import { Body, Controller, Get, HttpCode, HttpStatus, Patch, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { TenantGuard } from 'src/common/guards/tenant.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { Roles } from 'src/common/decorators/roles.decorator';
import { CurrentTenant } from 'src/common/decorators/current-tenant.decorator';
import { TenantsService } from './tenants.service';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { UpdateBusinessHoursDto } from './dto/update-business-hours.dto';

@Controller('admin/tenant')
@UseGuards(TenantGuard, RolesGuard)
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Get()
  async getCurrent(@CurrentTenant() tenantId: string) {
    const t = await this.tenants.getCurrent(tenantId);
    return {
      id: t.id,
      slug: t.slug,
      name: t.name,
      bio: t.bio,
      address: t.address,
      phone: t.phone,
      avatarUrl: t.avatarUrl,
      timezone: t.timezone,
      businessHours: t.businessHours ?? null,
      subscription: t.subscription
        ? {
            status: t.subscription.status,
            trialEndsAt: t.subscription.trialEndsAt,
            currentPeriodEnd: t.subscription.currentPeriodEnd,
          }
        : null,
    };
  }

  @Patch()
  @Roles(UserRole.tenant_owner)
  @HttpCode(HttpStatus.OK)
  async update(@CurrentTenant() tenantId: string, @Body() dto: UpdateTenantDto) {
    const t = await this.tenants.update(tenantId, dto);
    return {
      id: t.id,
      name: t.name,
      bio: t.bio,
      address: t.address,
      phone: t.phone,
      avatarUrl: t.avatarUrl,
      timezone: t.timezone,
    };
  }

  @Patch('business-hours')
  @Roles(UserRole.tenant_owner)
  @HttpCode(HttpStatus.OK)
  async updateBusinessHours(
    @CurrentTenant() tenantId: string,
    @Body() dto: UpdateBusinessHoursDto,
  ) {
    const t = await this.tenants.updateBusinessHours(tenantId, dto.businessHours);
    return { businessHours: t.businessHours };
  }

  @Get('subscription-debug')
  async listMy(@CurrentTenant() _tenantId: string) {
    return this.tenants.listMySubscription();
  }
}
```

- [ ] **Step 5.9: Garantir que TenantsModule não precisa exportar nada novo**

Verifique `src/modules/tenants/tenants.module.ts` — não precisa mudar, já tem `TenantsService` e `TenantRepository`.

- [ ] **Step 5.10: Build + lint + tests**

Run:
```bash
npm run lint && npm run build && npm run test
```
Expected: tudo verde.

- [ ] **Step 5.11: Commit**

```bash
git add src/modules/tenants src/common
git commit -m "feat(tenants): PATCH /admin/tenant + business-hours endpoint with domain validator"
```

---

## Task 6: Barbers — CRUD base (sem time-off, sem convite)

**Files:**
- Create: `src/modules/barbers/barbers.module.ts`
- Create: `src/modules/barbers/barbers.controller.ts`
- Create: `src/modules/barbers/barbers.service.ts`
- Create: `src/modules/barbers/barbers.service.spec.ts`
- Create: `src/modules/barbers/repositories/barber.repository.ts`
- Create: `src/modules/barbers/dto/create-barber.dto.ts`
- Create: `src/modules/barbers/dto/update-barber.dto.ts`
- Modify: `src/app.module.ts` (registrar `BarbersModule`)

> Nesta task POST cria um Barber órfão (sem userId, sem convite). Convite entra na Task 8.

- [ ] **Step 6.1: DTOs**

Crie `src/modules/barbers/dto/create-barber.dto.ts`:

```typescript
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateBarberDto {
  @IsString() @MinLength(2) @MaxLength(80) displayName!: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(500) bio?: string;
}
```

Crie `src/modules/barbers/dto/update-barber.dto.ts`:

```typescript
import { IsBoolean, IsOptional, IsString, IsUrl, MaxLength, MinLength } from 'class-validator';

export class UpdateBarberDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) displayName?: string;
  @IsOptional() @IsString() @MaxLength(500) bio?: string | null;
  @IsOptional() @IsUrl({ require_protocol: true }) avatarUrl?: string | null;
  @IsOptional() @IsBoolean() active?: boolean;
}
```

- [ ] **Step 6.2: Repository**

Crie `src/modules/barbers/repositories/barber.repository.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class BarberRepository {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.scoped.barber.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  }

  findById(id: string) {
    return this.prisma.scoped.barber.findFirst({ where: { id, deletedAt: null } });
  }

  create(data: Prisma.BarberCreateInput | Prisma.BarberUncheckedCreateInput) {
    return this.prisma.scoped.barber.create({ data: data as Prisma.BarberCreateInput });
  }

  update(id: string, data: Prisma.BarberUpdateInput) {
    return this.prisma.scoped.barber.update({ where: { id }, data });
  }

  softDelete(id: string) {
    return this.prisma.scoped.barber.update({
      where: { id },
      data: { deletedAt: new Date(), active: false },
    });
  }
}
```

- [ ] **Step 6.3: Escrever testes do service**

Crie `src/modules/barbers/barbers.service.spec.ts`:

```typescript
import { BarbersService } from './barbers.service';
import { BarberRepository } from './repositories/barber.repository';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';

describe('BarbersService', () => {
  let repo: jest.Mocked<BarberRepository>;
  let svc: BarbersService;

  beforeEach(() => {
    repo = {
      list: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      softDelete: jest.fn(),
    } as unknown as jest.Mocked<BarberRepository>;
    svc = new BarbersService(repo);
  });

  it('list() returns repository.list()', async () => {
    repo.list.mockResolvedValue([{ id: 'b1' }] as never);
    await expect(svc.list()).resolves.toEqual([{ id: 'b1' }]);
  });

  it('getById() throws BARBER_NOT_FOUND when missing', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(svc.getById('missing')).rejects.toMatchObject({
      opts: { code: ErrorCodes.BARBER_NOT_FOUND },
    });
  });

  it('create() forwards displayName + bio', async () => {
    repo.create.mockResolvedValue({ id: 'new', displayName: 'X' } as never);
    await svc.create({ displayName: 'X', bio: 'b' });
    expect(repo.create).toHaveBeenCalledWith({ displayName: 'X', bio: 'b' });
  });

  it('update() rejects unknown barber with 404', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(svc.update('nope', { displayName: 'Y' })).rejects.toBeInstanceOf(DomainException);
  });

  it('softDelete() rejects unknown barber with 404', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(svc.softDelete('nope')).rejects.toBeInstanceOf(DomainException);
  });
});
```

- [ ] **Step 6.4: Rodar testes e ver FALHAR**

Run:
```bash
npx jest --config jest.config.ts src/modules/barbers/barbers.service.spec.ts
```
Expected: FAIL — `BarbersService` ainda não existe.

- [ ] **Step 6.5: Implementar BarbersService**

Crie `src/modules/barbers/barbers.service.ts`:

```typescript
import { HttpStatus, Injectable } from '@nestjs/common';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { BarberRepository } from './repositories/barber.repository';
import { CreateBarberDto } from './dto/create-barber.dto';
import { UpdateBarberDto } from './dto/update-barber.dto';

@Injectable()
export class BarbersService {
  constructor(private readonly repo: BarberRepository) {}

  list() {
    return this.repo.list();
  }

  async getById(id: string) {
    const b = await this.repo.findById(id);
    if (!b) {
      throw new DomainException({
        code: ErrorCodes.BARBER_NOT_FOUND,
        message: 'Barbeiro não encontrado.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    return b;
  }

  create(dto: CreateBarberDto) {
    const { email: _email, ...rest } = dto;
    return this.repo.create(rest);
  }

  async update(id: string, dto: UpdateBarberDto) {
    await this.getById(id);
    return this.repo.update(id, dto);
  }

  async softDelete(id: string) {
    await this.getById(id);
    return this.repo.softDelete(id);
  }
}
```

> Note: `email` é consumido na Task 8 (envio do convite). Aqui ele é só validado mas ignorado.

- [ ] **Step 6.6: Implementar BarbersController**

Crie `src/modules/barbers/barbers.controller.ts`:

```typescript
import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { TenantGuard } from 'src/common/guards/tenant.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { Roles } from 'src/common/decorators/roles.decorator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import type { AuthenticatedUser } from 'src/common/types/request-context';
import { BarbersService } from './barbers.service';
import { CreateBarberDto } from './dto/create-barber.dto';
import { UpdateBarberDto } from './dto/update-barber.dto';

@Controller('admin/barbers')
@UseGuards(TenantGuard, RolesGuard)
export class BarbersController {
  constructor(private readonly barbers: BarbersService) {}

  @Get()
  list() {
    return this.barbers.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.barbers.getById(id);
  }

  @Post()
  @Roles(UserRole.tenant_owner)
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateBarberDto) {
    return this.barbers.create(dto);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateBarberDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (user.role === UserRole.barber_member) {
      const target = await this.barbers.getById(id);
      if (target.userId !== user.id) {
        throw new ForbiddenException('Barbeiros só editam o próprio perfil.');
      }
    }
    return this.barbers.update(id, dto);
  }

  @Delete(':id')
  @Roles(UserRole.tenant_owner)
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Param('id') id: string) {
    await this.barbers.softDelete(id);
  }
}
```

> Verifique que `src/common/decorators/current-user.decorator.ts` existe. Caso retorne `AuthenticatedUser`, está OK. Senão, ajuste o tipo.

- [ ] **Step 6.7: Implementar BarbersModule**

Crie `src/modules/barbers/barbers.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { BarbersController } from './barbers.controller';
import { BarbersService } from './barbers.service';
import { BarberRepository } from './repositories/barber.repository';

@Module({
  controllers: [BarbersController],
  providers: [BarbersService, BarberRepository],
  exports: [BarbersService, BarberRepository],
})
export class BarbersModule {}
```

- [ ] **Step 6.8: Registrar BarbersModule no AppModule**

Em `src/app.module.ts`, adicione:

```typescript
import { BarbersModule } from './modules/barbers/barbers.module';
```
e inclua `BarbersModule` na lista `imports:` depois de `TenantsModule`.

- [ ] **Step 6.9: Rodar testes do service e ver PASSAR**

Run:
```bash
npx jest --config jest.config.ts src/modules/barbers
```
Expected: PASS 5/5.

- [ ] **Step 6.10: Build + lint + tests gerais**

Run:
```bash
npm run lint && npm run build && npm run test
```
Expected: tudo verde.

- [ ] **Step 6.11: Commit**

```bash
git add src/modules/barbers src/app.module.ts
git commit -m "feat(barbers): CRUD endpoints (no invitation flow yet)"
```

---

## Task 7: Barbers — Time-off (POST/DELETE em /admin/barbers/:id/time-off)

**Files:**
- Create: `src/modules/barbers/time-off.service.ts`
- Create: `src/modules/barbers/time-off.service.spec.ts`
- Create: `src/modules/barbers/time-off.controller.ts`
- Create: `src/modules/barbers/repositories/time-off.repository.ts`
- Create: `src/modules/barbers/dto/create-time-off.dto.ts`
- Modify: `src/modules/barbers/barbers.module.ts`

- [ ] **Step 7.1: DTO**

Crie `src/modules/barbers/dto/create-time-off.dto.ts`:

```typescript
import { IsDateString, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateTimeOffDto {
  @IsDateString() startsAt!: string;
  @IsDateString() endsAt!: string;
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
}
```

- [ ] **Step 7.2: Repository**

Crie `src/modules/barbers/repositories/time-off.repository.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class TimeOffRepository {
  constructor(private readonly prisma: PrismaService) {}

  listForBarber(barberId: string) {
    return this.prisma.scoped.timeOff.findMany({
      where: { barberId },
      orderBy: { startsAt: 'asc' },
    });
  }

  create(data: { barberId: string; startsAt: Date; endsAt: Date; reason?: string }) {
    return this.prisma.scoped.timeOff.create({ data });
  }

  findById(id: string) {
    return this.prisma.scoped.timeOff.findFirst({ where: { id } });
  }

  delete(id: string) {
    return this.prisma.scoped.timeOff.delete({ where: { id } });
  }
}
```

- [ ] **Step 7.3: Service tests**

Crie `src/modules/barbers/time-off.service.spec.ts`:

```typescript
import { TimeOffService } from './time-off.service';
import { TimeOffRepository } from './repositories/time-off.repository';
import { BarbersService } from './barbers.service';
import { ErrorCodes } from 'src/common/exceptions/error-codes';

describe('TimeOffService', () => {
  let repo: jest.Mocked<TimeOffRepository>;
  let barbers: jest.Mocked<BarbersService>;
  let svc: TimeOffService;

  beforeEach(() => {
    repo = {
      listForBarber: jest.fn(),
      create: jest.fn(),
      findById: jest.fn(),
      delete: jest.fn(),
    } as unknown as jest.Mocked<TimeOffRepository>;
    barbers = { getById: jest.fn() } as unknown as jest.Mocked<BarbersService>;
    svc = new TimeOffService(repo, barbers);
  });

  it('create() rejects invalid range', async () => {
    barbers.getById.mockResolvedValue({ id: 'b1' } as never);
    await expect(
      svc.create('b1', { startsAt: '2026-05-12T10:00Z', endsAt: '2026-05-12T09:00Z' }),
    ).rejects.toMatchObject({ opts: { code: ErrorCodes.TIME_OFF_INVALID_RANGE } });
  });

  it('create() persists when range is valid', async () => {
    barbers.getById.mockResolvedValue({ id: 'b1' } as never);
    repo.create.mockResolvedValue({ id: 't1' } as never);
    const out = await svc.create('b1', {
      startsAt: '2026-05-12T10:00Z',
      endsAt: '2026-05-12T11:00Z',
      reason: 'consulta',
    });
    expect(repo.create).toHaveBeenCalledWith({
      barberId: 'b1',
      startsAt: new Date('2026-05-12T10:00Z'),
      endsAt: new Date('2026-05-12T11:00Z'),
      reason: 'consulta',
    });
    expect(out).toEqual({ id: 't1' });
  });

  it('delete() rejects when time-off not found or belongs to other barber', async () => {
    barbers.getById.mockResolvedValue({ id: 'b1' } as never);
    repo.findById.mockResolvedValue(null);
    await expect(svc.delete('b1', 't-missing')).rejects.toMatchObject({
      opts: { code: ErrorCodes.TIME_OFF_NOT_FOUND },
    });

    repo.findById.mockResolvedValue({ id: 't1', barberId: 'b2' } as never);
    await expect(svc.delete('b1', 't1')).rejects.toMatchObject({
      opts: { code: ErrorCodes.TIME_OFF_NOT_FOUND },
    });
  });
});
```

- [ ] **Step 7.4: Rodar e ver FALHAR**

Run:
```bash
npx jest --config jest.config.ts src/modules/barbers/time-off.service.spec.ts
```
Expected: FAIL — service não existe.

- [ ] **Step 7.5: Implementar TimeOffService**

Crie `src/modules/barbers/time-off.service.ts`:

```typescript
import { HttpStatus, Injectable } from '@nestjs/common';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { TimeOffRepository } from './repositories/time-off.repository';
import { BarbersService } from './barbers.service';
import { CreateTimeOffDto } from './dto/create-time-off.dto';

@Injectable()
export class TimeOffService {
  constructor(
    private readonly repo: TimeOffRepository,
    private readonly barbers: BarbersService,
  ) {}

  async list(barberId: string) {
    await this.barbers.getById(barberId);
    return this.repo.listForBarber(barberId);
  }

  async create(barberId: string, dto: CreateTimeOffDto) {
    await this.barbers.getById(barberId);
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (!(endsAt > startsAt)) {
      throw new DomainException({
        code: ErrorCodes.TIME_OFF_INVALID_RANGE,
        message: 'endsAt deve ser maior que startsAt.',
        status: HttpStatus.BAD_REQUEST,
      });
    }
    return this.repo.create({ barberId, startsAt, endsAt, reason: dto.reason });
  }

  async delete(barberId: string, timeOffId: string) {
    await this.barbers.getById(barberId);
    const existing = await this.repo.findById(timeOffId);
    if (!existing || existing.barberId !== barberId) {
      throw new DomainException({
        code: ErrorCodes.TIME_OFF_NOT_FOUND,
        message: 'Folga não encontrada.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    await this.repo.delete(timeOffId);
  }
}
```

- [ ] **Step 7.6: TimeOffController**

Crie `src/modules/barbers/time-off.controller.ts`:

```typescript
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { TenantGuard } from 'src/common/guards/tenant.guard';
import { TimeOffService } from './time-off.service';
import { CreateTimeOffDto } from './dto/create-time-off.dto';

@Controller('admin/barbers/:barberId/time-off')
@UseGuards(TenantGuard)
export class TimeOffController {
  constructor(private readonly timeOff: TimeOffService) {}

  @Get()
  list(@Param('barberId') barberId: string) {
    return this.timeOff.list(barberId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Param('barberId') barberId: string, @Body() dto: CreateTimeOffDto) {
    return this.timeOff.create(barberId, dto);
  }

  @Delete(':timeOffId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Param('barberId') barberId: string, @Param('timeOffId') timeOffId: string) {
    await this.timeOff.delete(barberId, timeOffId);
  }
}
```

- [ ] **Step 7.7: Atualizar BarbersModule**

Substitua `src/modules/barbers/barbers.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { BarbersController } from './barbers.controller';
import { BarbersService } from './barbers.service';
import { BarberRepository } from './repositories/barber.repository';
import { TimeOffController } from './time-off.controller';
import { TimeOffService } from './time-off.service';
import { TimeOffRepository } from './repositories/time-off.repository';

@Module({
  controllers: [BarbersController, TimeOffController],
  providers: [BarbersService, BarberRepository, TimeOffService, TimeOffRepository],
  exports: [BarbersService, BarberRepository],
})
export class BarbersModule {}
```

- [ ] **Step 7.8: Rodar testes do service e ver PASSAR**

Run:
```bash
npx jest --config jest.config.ts src/modules/barbers/time-off.service.spec.ts
```
Expected: PASS 3/3.

- [ ] **Step 7.9: Build + lint + tests gerais**

```bash
npm run lint && npm run build && npm run test
```
Expected: tudo verde.

- [ ] **Step 7.10: Commit**

```bash
git add src/modules/barbers
git commit -m "feat(barbers): time-off endpoints with range validation"
```

---

## Task 8: Convite de barbeiro por email (extensão do POST /admin/barbers + POST /auth/barbers/accept-invite)

**Files:**
- Create: `src/modules/barbers/barber-invitations.service.ts`
- Create: `src/modules/barbers/barber-invitations.service.spec.ts`
- Create: `src/modules/barbers/repositories/barber-invitation.repository.ts`
- Modify: `src/modules/barbers/barbers.service.ts`
- Modify: `src/modules/barbers/barbers.module.ts`
- Create: `src/modules/auth/dto/accept-barber-invite.dto.ts`
- Modify: `src/modules/auth/auth.controller.ts`
- Modify: `src/modules/auth/auth.service.ts`
- Modify: `src/modules/auth/auth.module.ts`

> Decisão: o convite só é enviado se `email` veio no DTO de criação. Se não veio, Barber fica órfão — pode ser convidado depois via endpoint dedicado (fora do MVP — TODO documentado no plano da Fase 3). 

- [ ] **Step 8.1: Repository**

Crie `src/modules/barbers/repositories/barber-invitation.repository.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class BarberInvitationRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: { barberId: string; email: string; tokenHash: string; expiresAt: Date }) {
    return this.prisma.scoped.barberInvitation.create({ data });
  }

  findByTokenHash(tokenHash: string) {
    // NOT scoped: aceite do convite é PÚBLICO (sem tenant no contexto).
    return this.prisma.barberInvitation.findUnique({
      where: { tokenHash },
      include: { barber: true, tenant: true },
    });
  }

  markAccepted(id: string) {
    return this.prisma.barberInvitation.update({
      where: { id },
      data: { acceptedAt: new Date() },
    });
  }
}
```

> **Por que `prisma.barberInvitation` sem scoped no findByTokenHash?** O aceite é público (sem JWT, sem tenant no ALS). O token é segredo suficiente. Logo após validar, fazemos as ações dentro do tenant correto.

- [ ] **Step 8.2: Testes do invitation service**

Crie `src/modules/barbers/barber-invitations.service.spec.ts`:

```typescript
import { BarberInvitationsService } from './barber-invitations.service';
import { BarberInvitationRepository } from './repositories/barber-invitation.repository';
import { ConfigService } from '@nestjs/config';
import { EmailProvider } from 'src/modules/notifications/email.provider';

describe('BarberInvitationsService', () => {
  let repo: jest.Mocked<BarberInvitationRepository>;
  let email: jest.Mocked<EmailProvider>;
  let cfg: ConfigService;
  let svc: BarberInvitationsService;

  beforeEach(() => {
    repo = {
      create: jest.fn(),
      findByTokenHash: jest.fn(),
      markAccepted: jest.fn(),
    } as unknown as jest.Mocked<BarberInvitationRepository>;
    email = { send: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<EmailProvider>;
    cfg = new ConfigService({ APP_URL: 'https://app.kairobarber.test' });
    svc = new BarberInvitationsService(repo, email, cfg);
  });

  it('issue() stores a hash, sends an email and returns plain token (length > 20)', async () => {
    repo.create.mockResolvedValue({ id: 'inv1' } as never);
    const { tokenPlain } = await svc.issue({
      barberId: 'b1',
      email: 'barbeiro@test.com',
      displayName: 'Barbeiro',
    });
    expect(tokenPlain.length).toBeGreaterThan(20);
    expect(repo.create).toHaveBeenCalledTimes(1);
    const arg = repo.create.mock.calls[0][0];
    expect(arg.tokenHash).not.toEqual(tokenPlain);
    expect(arg.email).toBe('barbeiro@test.com');
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(email.send.mock.calls[0][0].to).toBe('barbeiro@test.com');
    expect(email.send.mock.calls[0][0].text).toContain(tokenPlain);
  });

  it('validate() returns invitation when token is valid', async () => {
    repo.findByTokenHash.mockResolvedValue({
      id: 'inv1',
      acceptedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000),
      barberId: 'b1',
      tenantId: 't1',
      email: 'e@e.com',
      barber: {},
      tenant: {},
    } as never);
    await expect(svc.validate('plain')).resolves.toMatchObject({ id: 'inv1' });
  });

  it('validate() rejects expired token', async () => {
    repo.findByTokenHash.mockResolvedValue({
      id: 'inv1',
      acceptedAt: null,
      expiresAt: new Date(Date.now() - 1),
    } as never);
    await expect(svc.validate('plain')).rejects.toMatchObject({
      opts: { code: 'INVITATION_EXPIRED' },
    });
  });

  it('validate() rejects already-accepted', async () => {
    repo.findByTokenHash.mockResolvedValue({
      id: 'inv1',
      acceptedAt: new Date(),
      expiresAt: new Date(Date.now() + 1000),
    } as never);
    await expect(svc.validate('plain')).rejects.toMatchObject({
      opts: { code: 'INVITATION_ALREADY_ACCEPTED' },
    });
  });

  it('validate() rejects unknown token', async () => {
    repo.findByTokenHash.mockResolvedValue(null);
    await expect(svc.validate('plain')).rejects.toMatchObject({
      opts: { code: 'INVITATION_INVALID' },
    });
  });
});
```

- [ ] **Step 8.3: Rodar e ver FALHAR**

Run:
```bash
npx jest --config jest.config.ts src/modules/barbers/barber-invitations.service.spec.ts
```
Expected: FAIL — service não existe.

- [ ] **Step 8.4: Implementar BarberInvitationsService**

Crie `src/modules/barbers/barber-invitations.service.ts`:

```typescript
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { EMAIL_PROVIDER } from 'src/modules/notifications/email.provider';
import type { EmailProvider } from 'src/modules/notifications/email.provider';
import { BarberInvitationRepository } from './repositories/barber-invitation.repository';

const INVITATION_TTL_SECONDS = 7 * 24 * 3600;

@Injectable()
export class BarberInvitationsService {
  constructor(
    private readonly repo: BarberInvitationRepository,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    private readonly config: ConfigService,
  ) {}

  async issue(input: { barberId: string; email: string; displayName: string }) {
    const tokenPlain = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(tokenPlain).digest('hex');
    const expiresAt = new Date(Date.now() + INVITATION_TTL_SECONDS * 1000);
    const invitation = await this.repo.create({
      barberId: input.barberId,
      email: input.email,
      tokenHash,
      expiresAt,
    });
    const appUrl = this.config.get<string>('APP_URL');
    await this.email.send({
      to: input.email,
      subject: 'Convite para entrar no KairoBarber',
      text:
        `Olá ${input.displayName}!\n\nVocê foi convidado(a) para entrar no KairoBarber como barbeiro(a). ` +
        `Aceite o convite com o token abaixo (válido por 7 dias):\n\n${tokenPlain}\n\n` +
        `Ou acesse: ${appUrl}/accept-invite?token=${tokenPlain}\n`,
    });
    return { invitation, tokenPlain };
  }

  async validate(tokenPlain: string) {
    const tokenHash = createHash('sha256').update(tokenPlain).digest('hex');
    const found = await this.repo.findByTokenHash(tokenHash);
    if (!found) {
      throw new DomainException({
        code: ErrorCodes.INVITATION_INVALID,
        message: 'Convite inválido.',
        status: HttpStatus.BAD_REQUEST,
      });
    }
    if (found.acceptedAt) {
      throw new DomainException({
        code: ErrorCodes.INVITATION_ALREADY_ACCEPTED,
        message: 'Convite já foi aceito.',
        status: HttpStatus.CONFLICT,
      });
    }
    if (found.expiresAt < new Date()) {
      throw new DomainException({
        code: ErrorCodes.INVITATION_EXPIRED,
        message: 'Convite expirado.',
        status: HttpStatus.BAD_REQUEST,
      });
    }
    return found;
  }

  markAccepted(id: string) {
    return this.repo.markAccepted(id);
  }
}
```

- [ ] **Step 8.5: Rodar e ver PASSAR**

Run:
```bash
npx jest --config jest.config.ts src/modules/barbers/barber-invitations.service.spec.ts
```
Expected: PASS 5/5.

- [ ] **Step 8.6: Plugar invitation no POST /admin/barbers**

Edite `src/modules/barbers/barbers.service.ts`. Adicione `BarberInvitationsService` no constructor e altere `create`:

```typescript
import { HttpStatus, Injectable } from '@nestjs/common';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { BarberRepository } from './repositories/barber.repository';
import { CreateBarberDto } from './dto/create-barber.dto';
import { UpdateBarberDto } from './dto/update-barber.dto';
import { BarberInvitationsService } from './barber-invitations.service';

@Injectable()
export class BarbersService {
  constructor(
    private readonly repo: BarberRepository,
    private readonly invitations: BarberInvitationsService,
  ) {}

  list() {
    return this.repo.list();
  }

  async getById(id: string) {
    const b = await this.repo.findById(id);
    if (!b) {
      throw new DomainException({
        code: ErrorCodes.BARBER_NOT_FOUND,
        message: 'Barbeiro não encontrado.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    return b;
  }

  async create(dto: CreateBarberDto) {
    const created = await this.repo.create({
      displayName: dto.displayName,
      bio: dto.bio,
    });
    if (dto.email) {
      await this.invitations.issue({
        barberId: created.id,
        email: dto.email,
        displayName: dto.displayName,
      });
    }
    return created;
  }

  async update(id: string, dto: UpdateBarberDto) {
    await this.getById(id);
    return this.repo.update(id, dto);
  }

  async softDelete(id: string) {
    await this.getById(id);
    return this.repo.softDelete(id);
  }
}
```

- [ ] **Step 8.7: Atualizar testes do BarbersService**

Edite `src/modules/barbers/barbers.service.spec.ts`. Substitua todo o conteúdo:

```typescript
import { BarbersService } from './barbers.service';
import { BarberRepository } from './repositories/barber.repository';
import { BarberInvitationsService } from './barber-invitations.service';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';

describe('BarbersService', () => {
  let repo: jest.Mocked<BarberRepository>;
  let invitations: jest.Mocked<BarberInvitationsService>;
  let svc: BarbersService;

  beforeEach(() => {
    repo = {
      list: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      softDelete: jest.fn(),
    } as unknown as jest.Mocked<BarberRepository>;
    invitations = {
      issue: jest.fn().mockResolvedValue({ invitation: { id: 'inv1' }, tokenPlain: 'tok' }),
    } as unknown as jest.Mocked<BarberInvitationsService>;
    svc = new BarbersService(repo, invitations);
  });

  it('list() returns repository.list()', async () => {
    repo.list.mockResolvedValue([{ id: 'b1' }] as never);
    await expect(svc.list()).resolves.toEqual([{ id: 'b1' }]);
  });

  it('getById() throws BARBER_NOT_FOUND when missing', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(svc.getById('missing')).rejects.toMatchObject({
      opts: { code: ErrorCodes.BARBER_NOT_FOUND },
    });
  });

  it('create() without email does NOT issue invitation', async () => {
    repo.create.mockResolvedValue({ id: 'new', displayName: 'X' } as never);
    await svc.create({ displayName: 'X' });
    expect(invitations.issue).not.toHaveBeenCalled();
  });

  it('create() with email issues invitation', async () => {
    repo.create.mockResolvedValue({ id: 'new', displayName: 'X' } as never);
    await svc.create({ displayName: 'X', email: 'e@e.com' });
    expect(invitations.issue).toHaveBeenCalledWith({
      barberId: 'new',
      email: 'e@e.com',
      displayName: 'X',
    });
  });

  it('update() rejects unknown barber with 404', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(svc.update('nope', { displayName: 'Y' })).rejects.toBeInstanceOf(DomainException);
  });

  it('softDelete() rejects unknown barber with 404', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(svc.softDelete('nope')).rejects.toBeInstanceOf(DomainException);
  });
});
```

- [ ] **Step 8.8: Rodar testes do barbers e ver PASSAR**

Run:
```bash
npx jest --config jest.config.ts src/modules/barbers
```
Expected: PASS em todos.

- [ ] **Step 8.9: Endpoint público de aceite — DTO**

Crie `src/modules/auth/dto/accept-barber-invite.dto.ts`:

```typescript
import { IsString, MaxLength, MinLength } from 'class-validator';

export class AcceptBarberInviteDto {
  @IsString() @MinLength(20) token!: string;
  @IsString() @MinLength(8) @MaxLength(128) password!: string;
  @IsString() @MinLength(2) @MaxLength(80) name!: string;
}
```

- [ ] **Step 8.10: Estender AuthService — aceitar convite + resolver tenant pra barber_member**

Edite `src/modules/auth/auth.service.ts`.

(a) Importe no topo:
```typescript
import { BarberInvitationsService } from 'src/modules/barbers/barber-invitations.service';
import { Prisma } from '@prisma/client';
```

(b) Injete no constructor (acrescentar como último parâmetro):
```typescript
    private readonly barberInvitations: BarberInvitationsService,
```

(c) Adicione o método de aceitar convite ao fim da classe:

```typescript
  async acceptBarberInvite(input: { token: string; password: string; name: string }) {
    const invitation = await this.barberInvitations.validate(input.token);

    const existingUser = await this.users.findByEmail(invitation.email);
    if (existingUser) {
      throw new DomainException({
        code: ErrorCodes.EMAIL_ALREADY_REGISTERED,
        message: 'Email já cadastrado.',
        status: HttpStatus.CONFLICT,
      });
    }

    const passwordHash = await this.password.hash(input.password);

    const { user } = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: invitation.email,
          name: input.name,
          passwordHash,
          role: UserRole.barber_member,
          emailVerifiedAt: new Date(),
        },
      });
      await tx.barber.update({
        where: { id: invitation.barberId },
        data: { userId: user.id },
      });
      await tx.barberInvitation.update({
        where: { id: invitation.id },
        data: { acceptedAt: new Date() },
      });
      return { user };
    });

    const pair = await this.tokens.issuePair({
      userId: user.id,
      role: user.role,
      tenantId: invitation.tenantId,
    });
    return { user, tenantId: invitation.tenantId, ...pair };
  }
```

(d) Atualize `login` e `refresh` para que `barber_member` resolva tenantId via Barber. Substitua a definição de `tenant` nesses métodos por uma helper:

No início da classe, adicione método privado:

```typescript
  private async resolveTenantIdFor(userId: string, role: UserRole): Promise<string | undefined> {
    if (role === UserRole.tenant_owner) {
      const tenant = await this.prisma.tenant.findUnique({ where: { ownerUserId: userId } });
      return tenant?.id;
    }
    if (role === UserRole.barber_member) {
      const barber = await this.prisma.barber.findUnique({
        where: { userId },
        select: { tenantId: true },
      });
      return barber?.tenantId;
    }
    return undefined;
  }
```

Em `login()`, troque:
```typescript
    const tenant = await this.prisma.tenant.findUnique({ where: { ownerUserId: user.id } });
    const pair = await this.tokens.issuePair({
      userId: user.id,
      role: user.role,
      tenantId: tenant?.id,
    });
```
por:
```typescript
    const tenantId = await this.resolveTenantIdFor(user.id, user.role);
    const pair = await this.tokens.issuePair({ userId: user.id, role: user.role, tenantId });
```

Em `refresh()`, faça a mesma substituição.

- [ ] **Step 8.11: Estender AuthController**

Edite `src/modules/auth/auth.controller.ts`. Adicione o import e endpoint:

```typescript
import { AcceptBarberInviteDto } from './dto/accept-barber-invite.dto';
```

No fim da classe, adicione:

```typescript
  @Public()
  @Post('barbers/accept-invite')
  @HttpCode(HttpStatus.OK)
  async acceptBarberInvite(@Body() dto: AcceptBarberInviteDto) {
    const r = await this.auth.acceptBarberInvite(dto);
    return {
      user: { id: r.user.id, email: r.user.email, name: r.user.name, role: r.user.role },
      tenantId: r.tenantId,
      accessToken: r.accessToken,
      refreshToken: r.refreshToken,
    };
  }
```

- [ ] **Step 8.12: Atualizar BarbersModule + AuthModule (DI cross-module)**

Edite `src/modules/barbers/barbers.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { BarbersController } from './barbers.controller';
import { BarbersService } from './barbers.service';
import { BarberRepository } from './repositories/barber.repository';
import { TimeOffController } from './time-off.controller';
import { TimeOffService } from './time-off.service';
import { TimeOffRepository } from './repositories/time-off.repository';
import { BarberInvitationsService } from './barber-invitations.service';
import { BarberInvitationRepository } from './repositories/barber-invitation.repository';

@Module({
  controllers: [BarbersController, TimeOffController],
  providers: [
    BarbersService,
    BarberRepository,
    TimeOffService,
    TimeOffRepository,
    BarberInvitationsService,
    BarberInvitationRepository,
  ],
  exports: [BarbersService, BarberRepository, BarberInvitationsService],
})
export class BarbersModule {}
```

Edite `src/modules/auth/auth.module.ts`. Importe e adicione `BarbersModule` nos imports:

```typescript
import { BarbersModule } from 'src/modules/barbers/barbers.module';
```
e na lista `imports`:
```typescript
  imports: [JwtModule.register({}), BarbersModule],
```

- [ ] **Step 8.13: Atualizar/rever testes existentes de auth (TokensService etc.)**

Não há mudança em `tokens.service.spec.ts` ou `password.service.spec.ts`. Verifique se existem testes que usam `AuthService` diretamente — se sim, mocke `BarberInvitationsService`.

Run:
```bash
npm run test
```
Expected: tudo verde (se algum teste de auth quebrar pela DI nova, mocke o serviço).

- [ ] **Step 8.14: E2E — fluxo de convite (happy path)**

Edite o teste e2e `auth-onboarding.e2e-spec.ts` apenas se quiser estender; senão pule. O E2E de Phase 2 (Task 14) já cobre o fluxo completo. Aqui só rode o build:

```bash
npm run build && npm run test:e2e -- --testPathPattern auth-onboarding
```
Expected: PASS (regressão da Fase 1).

- [ ] **Step 8.15: Commit**

```bash
git add src/modules
git commit -m "feat(barbers,auth): barber invitation flow + barber_member login"
```

---

## Task 9: Catalog — Services CRUD

**Files:**
- Create: `src/modules/catalog/catalog.module.ts`
- Create: `src/modules/catalog/services.controller.ts`
- Create: `src/modules/catalog/services.service.ts`
- Create: `src/modules/catalog/services.service.spec.ts`
- Create: `src/modules/catalog/repositories/service.repository.ts`
- Create: `src/modules/catalog/dto/create-service.dto.ts`
- Create: `src/modules/catalog/dto/update-service.dto.ts`
- Modify: `src/app.module.ts` (registrar `CatalogModule`)

- [ ] **Step 9.1: DTOs**

Crie `src/modules/catalog/dto/create-service.dto.ts`:

```typescript
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CreateServiceDto {
  @IsString() @MinLength(2) @MaxLength(80) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsInt() @Min(5) @Max(480) durationMin!: number;
  @IsInt() @Min(0) @Max(10_000_00) priceCents!: number;
  @IsOptional() @IsBoolean() active?: boolean;
}
```

Crie `src/modules/catalog/dto/update-service.dto.ts`:

```typescript
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class UpdateServiceDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  @IsOptional() @IsInt() @Min(5) @Max(480) durationMin?: number;
  @IsOptional() @IsInt() @Min(0) @Max(10_000_00) priceCents?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}
```

- [ ] **Step 9.2: Repository**

Crie `src/modules/catalog/repositories/service.repository.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class ServiceRepository {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.scoped.service.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'asc' },
      include: { serviceBarbers: true },
    });
  }

  findById(id: string) {
    return this.prisma.scoped.service.findFirst({
      where: { id, deletedAt: null },
      include: { serviceBarbers: true },
    });
  }

  create(data: Prisma.ServiceUncheckedCreateInput) {
    return this.prisma.scoped.service.create({ data: data as Prisma.ServiceCreateInput });
  }

  update(id: string, data: Prisma.ServiceUpdateInput) {
    return this.prisma.scoped.service.update({ where: { id }, data });
  }

  softDelete(id: string) {
    return this.prisma.scoped.service.update({
      where: { id },
      data: { deletedAt: new Date(), active: false },
    });
  }
}
```

- [ ] **Step 9.3: Service tests**

Crie `src/modules/catalog/services.service.spec.ts`:

```typescript
import { ServicesService } from './services.service';
import { ServiceRepository } from './repositories/service.repository';
import { ErrorCodes } from 'src/common/exceptions/error-codes';

describe('ServicesService', () => {
  let repo: jest.Mocked<ServiceRepository>;
  let svc: ServicesService;

  beforeEach(() => {
    repo = {
      list: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      softDelete: jest.fn(),
    } as unknown as jest.Mocked<ServiceRepository>;
    svc = new ServicesService(repo);
  });

  it('list() returns from repo', async () => {
    repo.list.mockResolvedValue([{ id: 's1' }] as never);
    await expect(svc.list()).resolves.toEqual([{ id: 's1' }]);
  });

  it('getById() throws SERVICE_NOT_FOUND', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(svc.getById('x')).rejects.toMatchObject({
      opts: { code: ErrorCodes.SERVICE_NOT_FOUND },
    });
  });

  it('create() forwards DTO', async () => {
    repo.create.mockResolvedValue({ id: 's1' } as never);
    await svc.create({ name: 'Corte', durationMin: 30, priceCents: 5000 });
    expect(repo.create).toHaveBeenCalledWith({
      name: 'Corte',
      durationMin: 30,
      priceCents: 5000,
    });
  });

  it('update() rejects unknown service', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(svc.update('s1', { name: 'X' })).rejects.toMatchObject({
      opts: { code: ErrorCodes.SERVICE_NOT_FOUND },
    });
  });

  it('softDelete() rejects unknown service', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(svc.softDelete('s1')).rejects.toMatchObject({
      opts: { code: ErrorCodes.SERVICE_NOT_FOUND },
    });
  });
});
```

- [ ] **Step 9.4: Rodar e ver FALHAR**

```bash
npx jest --config jest.config.ts src/modules/catalog/services.service.spec.ts
```
Expected: FAIL.

- [ ] **Step 9.5: Implementar ServicesService**

Crie `src/modules/catalog/services.service.ts`:

```typescript
import { HttpStatus, Injectable } from '@nestjs/common';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { ServiceRepository } from './repositories/service.repository';
import { CreateServiceDto } from './dto/create-service.dto';
import { UpdateServiceDto } from './dto/update-service.dto';

@Injectable()
export class ServicesService {
  constructor(private readonly repo: ServiceRepository) {}

  list() {
    return this.repo.list();
  }

  async getById(id: string) {
    const s = await this.repo.findById(id);
    if (!s) {
      throw new DomainException({
        code: ErrorCodes.SERVICE_NOT_FOUND,
        message: 'Serviço não encontrado.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    return s;
  }

  create(dto: CreateServiceDto) {
    return this.repo.create({
      name: dto.name,
      description: dto.description,
      durationMin: dto.durationMin,
      priceCents: dto.priceCents,
      ...(dto.active !== undefined ? { active: dto.active } : {}),
    });
  }

  async update(id: string, dto: UpdateServiceDto) {
    await this.getById(id);
    return this.repo.update(id, dto);
  }

  async softDelete(id: string) {
    await this.getById(id);
    return this.repo.softDelete(id);
  }
}
```

- [ ] **Step 9.6: ServicesController**

Crie `src/modules/catalog/services.controller.ts`:

```typescript
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { TenantGuard } from 'src/common/guards/tenant.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { Roles } from 'src/common/decorators/roles.decorator';
import { ServicesService } from './services.service';
import { CreateServiceDto } from './dto/create-service.dto';
import { UpdateServiceDto } from './dto/update-service.dto';

@Controller('admin/services')
@UseGuards(TenantGuard, RolesGuard)
export class ServicesController {
  constructor(private readonly services: ServicesService) {}

  @Get()
  list() {
    return this.services.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.services.getById(id);
  }

  @Post()
  @Roles(UserRole.tenant_owner)
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateServiceDto) {
    return this.services.create(dto);
  }

  @Patch(':id')
  @Roles(UserRole.tenant_owner)
  update(@Param('id') id: string, @Body() dto: UpdateServiceDto) {
    return this.services.update(id, dto);
  }

  @Delete(':id')
  @Roles(UserRole.tenant_owner)
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Param('id') id: string) {
    await this.services.softDelete(id);
  }
}
```

- [ ] **Step 9.7: CatalogModule (placeholder; expandido na Task 10/11)**

Crie `src/modules/catalog/catalog.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { ServicesController } from './services.controller';
import { ServicesService } from './services.service';
import { ServiceRepository } from './repositories/service.repository';

@Module({
  controllers: [ServicesController],
  providers: [ServicesService, ServiceRepository],
  exports: [ServicesService, ServiceRepository],
})
export class CatalogModule {}
```

- [ ] **Step 9.8: Registrar CatalogModule**

Em `src/app.module.ts`, adicione import e inclua na lista `imports`:

```typescript
import { CatalogModule } from './modules/catalog/catalog.module';
```

- [ ] **Step 9.9: Rodar testes e ver PASSAR**

```bash
npx jest --config jest.config.ts src/modules/catalog
```
Expected: PASS 5/5.

- [ ] **Step 9.10: Lint + tests gerais**

```bash
npm run lint && npm run test
```

- [ ] **Step 9.11: Commit**

```bash
git add src/modules/catalog src/app.module.ts
git commit -m "feat(catalog): services CRUD"
```

---

## Task 10: Catalog — PUT /admin/services/:id/barbers (assign barbers)

**Files:**
- Modify: `src/modules/catalog/services.controller.ts`
- Modify: `src/modules/catalog/services.service.ts`
- Modify: `src/modules/catalog/services.service.spec.ts`
- Create: `src/modules/catalog/dto/set-service-barbers.dto.ts`
- Modify: `src/modules/catalog/catalog.module.ts` (importa BarbersModule)
- Modify: `src/modules/catalog/repositories/service.repository.ts` (transaction helper)

- [ ] **Step 10.1: DTO**

Crie `src/modules/catalog/dto/set-service-barbers.dto.ts`:

```typescript
import { ArrayUnique, IsArray, IsString } from 'class-validator';

export class SetServiceBarbersDto {
  @IsArray() @ArrayUnique() @IsString({ each: true })
  barberIds!: string[];
}
```

- [ ] **Step 10.2: Estender ServiceRepository com replace de barbers**

Edite `src/modules/catalog/repositories/service.repository.ts`. Adicione método:

```typescript
  async replaceBarbers(serviceId: string, barberIds: string[], tenantId: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.serviceBarber.deleteMany({ where: { serviceId, tenantId } });
      if (barberIds.length) {
        await tx.serviceBarber.createMany({
          data: barberIds.map((barberId) => ({ tenantId, serviceId, barberId })),
        });
      }
      return tx.serviceBarber.findMany({ where: { serviceId, tenantId } });
    });
  }
```

> Note: usamos `prisma` cru (não `scoped`) aqui porque a transação é interna; o tenantId é validado pelo controller via TenantGuard e injetado explicitamente.

- [ ] **Step 10.3: Estender ServicesService**

Edite `src/modules/catalog/services.service.ts`. Importe BarberRepository:

```typescript
import { BarberRepository } from 'src/modules/barbers/repositories/barber.repository';
```

Adicione no constructor:

```typescript
    private readonly barbers: BarberRepository,
```

Adicione método:

```typescript
  async setBarbers(serviceId: string, tenantId: string, barberIds: string[]) {
    await this.getById(serviceId);
    if (barberIds.length === 0) {
      return this.repo.replaceBarbers(serviceId, [], tenantId);
    }
    const existing = await Promise.all(barberIds.map((id) => this.barbers.findById(id)));
    const missing = barberIds.filter((_id, i) => !existing[i]);
    if (missing.length) {
      throw new DomainException({
        code: ErrorCodes.SERVICE_BARBER_MISMATCH,
        message: `Barbeiro(s) inválido(s): ${missing.join(', ')}`,
        status: HttpStatus.BAD_REQUEST,
      });
    }
    return this.repo.replaceBarbers(serviceId, barberIds, tenantId);
  }
```

- [ ] **Step 10.4: Adicionar teste**

Edite `src/modules/catalog/services.service.spec.ts`. Adicione antes de `});` (último describe):

```typescript
  describe('setBarbers()', () => {
    let barbers: { findById: jest.Mock };
    let svc2: ServicesService;

    beforeEach(() => {
      barbers = { findById: jest.fn() };
      // Reuse the existing repo mock but extend with replaceBarbers
      const repo2 = {
        ...repo,
        replaceBarbers: jest.fn().mockResolvedValue([{ tenantId: 't1' }]),
      } as unknown as ServiceRepository & { replaceBarbers: jest.Mock };
      svc2 = new ServicesService(repo2, barbers as never);
      repo.findById.mockResolvedValue({ id: 's1' } as never);
    });

    it('replaces barber list when all ids valid', async () => {
      barbers.findById.mockResolvedValueOnce({ id: 'b1' }).mockResolvedValueOnce({ id: 'b2' });
      await svc2.setBarbers('s1', 't1', ['b1', 'b2']);
      expect((svc2 as never as { repo: { replaceBarbers: jest.Mock } }).repo.replaceBarbers)
        .toHaveBeenCalledWith('s1', ['b1', 'b2'], 't1');
    });

    it('rejects unknown barberId', async () => {
      barbers.findById.mockResolvedValueOnce({ id: 'b1' }).mockResolvedValueOnce(null);
      await expect(svc2.setBarbers('s1', 't1', ['b1', 'b-missing'])).rejects.toMatchObject({
        opts: { code: ErrorCodes.SERVICE_BARBER_MISMATCH },
      });
    });

    it('accepts empty list (clears all)', async () => {
      await svc2.setBarbers('s1', 't1', []);
      expect((svc2 as never as { repo: { replaceBarbers: jest.Mock } }).repo.replaceBarbers)
        .toHaveBeenCalledWith('s1', [], 't1');
    });
  });
```

Also update the existing top-level `beforeEach` to inject a `BarberRepository` mock — at the top:

```typescript
import { BarberRepository } from 'src/modules/barbers/repositories/barber.repository';
```

And in the outer `beforeEach`:
```typescript
    const barbersRepo = { findById: jest.fn() } as unknown as BarberRepository;
    svc = new ServicesService(repo, barbersRepo);
```

- [ ] **Step 10.5: Endpoint no controller**

Edite `src/modules/catalog/services.controller.ts`. Importe DTO + helpers e adicione endpoint:

```typescript
import { Put } from '@nestjs/common';
import { CurrentTenant } from 'src/common/decorators/current-tenant.decorator';
import { SetServiceBarbersDto } from './dto/set-service-barbers.dto';
```

```typescript
  @Put(':id/barbers')
  @Roles(UserRole.tenant_owner)
  @HttpCode(HttpStatus.OK)
  setBarbers(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @Body() dto: SetServiceBarbersDto,
  ) {
    return this.services.setBarbers(id, tenantId, dto.barberIds);
  }
```

- [ ] **Step 10.6: Atualizar CatalogModule**

Edite `src/modules/catalog/catalog.module.ts`. Importe e adicione BarbersModule:

```typescript
import { Module } from '@nestjs/common';
import { BarbersModule } from 'src/modules/barbers/barbers.module';
import { ServicesController } from './services.controller';
import { ServicesService } from './services.service';
import { ServiceRepository } from './repositories/service.repository';

@Module({
  imports: [BarbersModule],
  controllers: [ServicesController],
  providers: [ServicesService, ServiceRepository],
  exports: [ServicesService, ServiceRepository],
})
export class CatalogModule {}
```

- [ ] **Step 10.7: Rodar testes**

```bash
npx jest --config jest.config.ts src/modules/catalog
```
Expected: PASS em todos (5 + 3 = 8).

- [ ] **Step 10.8: Build geral + lint**

```bash
npm run lint && npm run build && npm run test
```

- [ ] **Step 10.9: Commit**

```bash
git add src/modules/catalog
git commit -m "feat(catalog): assign barbers to a service (PUT /admin/services/:id/barbers)"
```

---

## Task 11: Catalog — Photos (presigned URL + confirm + list + delete)

**Files:**
- Create: `src/modules/catalog/photos.controller.ts`
- Create: `src/modules/catalog/photos.service.ts`
- Create: `src/modules/catalog/photos.service.spec.ts`
- Create: `src/modules/catalog/repositories/photo.repository.ts`
- Create: `src/modules/catalog/dto/create-photo-upload-url.dto.ts`
- Create: `src/modules/catalog/dto/create-photo.dto.ts`
- Modify: `src/modules/catalog/catalog.module.ts`

- [ ] **Step 11.1: DTOs**

Crie `src/modules/catalog/dto/create-photo-upload-url.dto.ts`:

```typescript
import { IsString } from 'class-validator';

export class CreatePhotoUploadUrlDto {
  @IsString() contentType!: string;
}
```

Crie `src/modules/catalog/dto/create-photo.dto.ts`:

```typescript
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreatePhotoDto {
  @IsString() @MaxLength(255) r2Key!: string;
  @IsOptional() @IsString() @MaxLength(200) caption?: string;
  @IsOptional() @IsString() serviceId?: string;
  @IsOptional() @IsString() barberId?: string;
}
```

- [ ] **Step 11.2: Repository**

Crie `src/modules/catalog/repositories/photo.repository.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class PhotoRepository {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.scoped.photo.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  findById(id: string) {
    return this.prisma.scoped.photo.findFirst({ where: { id, deletedAt: null } });
  }

  create(data: Prisma.PhotoUncheckedCreateInput) {
    return this.prisma.scoped.photo.create({ data: data as Prisma.PhotoCreateInput });
  }

  softDelete(id: string) {
    return this.prisma.scoped.photo.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}
```

- [ ] **Step 11.3: Tests do service**

Crie `src/modules/catalog/photos.service.spec.ts`:

```typescript
import { PhotosService } from './photos.service';
import { PhotoRepository } from './repositories/photo.repository';
import { StorageProvider } from 'src/modules/storage/storage.provider';
import { ErrorCodes } from 'src/common/exceptions/error-codes';

describe('PhotosService', () => {
  let repo: jest.Mocked<PhotoRepository>;
  let storage: jest.Mocked<StorageProvider>;
  let svc: PhotosService;

  beforeEach(() => {
    repo = {
      list: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      softDelete: jest.fn(),
    } as unknown as jest.Mocked<PhotoRepository>;
    storage = {
      presignUpload: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<StorageProvider>;
    svc = new PhotosService(repo, storage);
  });

  it('createUploadUrl() rejects invalid contentType', async () => {
    await expect(svc.createUploadUrl('t1', 'application/pdf')).rejects.toMatchObject({
      opts: { code: ErrorCodes.STORAGE_CONTENT_TYPE_INVALID },
    });
  });

  it('createUploadUrl() returns presigned URL for jpeg', async () => {
    storage.presignUpload.mockResolvedValue({
      uploadUrl: 'http://x/y',
      r2Key: 'tenants/t1/photos/uuid.jpg',
      expiresAt: new Date(Date.now() + 60_000),
      contentType: 'image/jpeg',
      maxBytes: 5 * 1024 * 1024,
    });
    const out = await svc.createUploadUrl('t1', 'image/jpeg');
    expect(out.r2Key).toMatch(/tenants\/t1\/photos\//);
    expect(out.uploadUrl).toBe('http://x/y');
    expect(storage.presignUpload).toHaveBeenCalledWith({
      tenantId: 't1',
      contentType: 'image/jpeg',
      extension: 'jpg',
      maxBytes: 5 * 1024 * 1024,
      ttlSeconds: 60,
    });
  });

  it('confirm() persists photo record', async () => {
    repo.create.mockResolvedValue({ id: 'p1', r2Key: 'k', tenantId: 't1' } as never);
    const out = await svc.confirm({ r2Key: 'k', caption: 'cap' });
    expect(repo.create).toHaveBeenCalledWith({ r2Key: 'k', caption: 'cap' });
    expect(out.id).toBe('p1');
  });

  it('delete() throws when not found', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(svc.delete('p1')).rejects.toMatchObject({
      opts: { code: ErrorCodes.PHOTO_NOT_FOUND },
    });
  });

  it('delete() marks deleted (storage cleanup deferred to cron)', async () => {
    repo.findById.mockResolvedValue({ id: 'p1', r2Key: 'k' } as never);
    await svc.delete('p1');
    expect(repo.softDelete).toHaveBeenCalledWith('p1');
    expect(storage.delete).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 11.4: Rodar e ver FALHAR**

```bash
npx jest --config jest.config.ts src/modules/catalog/photos.service.spec.ts
```
Expected: FAIL.

- [ ] **Step 11.5: Implementar PhotosService**

Crie `src/modules/catalog/photos.service.ts`:

```typescript
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import {
  ALLOWED_PHOTO_CONTENT_TYPES,
  PHOTO_MAX_BYTES,
  STORAGE_PROVIDER,
  extensionFromContentType,
} from 'src/modules/storage/storage.provider';
import type { StorageProvider } from 'src/modules/storage/storage.provider';
import { PhotoRepository } from './repositories/photo.repository';
import { CreatePhotoDto } from './dto/create-photo.dto';

const UPLOAD_URL_TTL_SECONDS = 60;

@Injectable()
export class PhotosService {
  constructor(
    private readonly repo: PhotoRepository,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  list() {
    return this.repo.list();
  }

  async createUploadUrl(tenantId: string, contentType: string) {
    if (!ALLOWED_PHOTO_CONTENT_TYPES.has(contentType)) {
      throw new DomainException({
        code: ErrorCodes.STORAGE_CONTENT_TYPE_INVALID,
        message: `Content type não suportado: ${contentType}.`,
        status: HttpStatus.BAD_REQUEST,
        details: { allowed: Array.from(ALLOWED_PHOTO_CONTENT_TYPES) },
      });
    }
    const presigned = await this.storage.presignUpload({
      tenantId,
      contentType,
      extension: extensionFromContentType(contentType),
      maxBytes: PHOTO_MAX_BYTES,
      ttlSeconds: UPLOAD_URL_TTL_SECONDS,
    });
    return presigned;
  }

  confirm(dto: CreatePhotoDto) {
    return this.repo.create({
      r2Key: dto.r2Key,
      caption: dto.caption,
      serviceId: dto.serviceId,
      barberId: dto.barberId,
    });
  }

  async delete(id: string) {
    const photo = await this.repo.findById(id);
    if (!photo) {
      throw new DomainException({
        code: ErrorCodes.PHOTO_NOT_FOUND,
        message: 'Foto não encontrada.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    // Storage cleanup deferred to cron (LGPD job — Phase 6). DB soft-delete is the source of truth.
    await this.repo.softDelete(id);
  }
}
```

- [ ] **Step 11.6: Controller**

Crie `src/modules/catalog/photos.controller.ts`:

```typescript
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { TenantGuard } from 'src/common/guards/tenant.guard';
import { CurrentTenant } from 'src/common/decorators/current-tenant.decorator';
import { PhotosService } from './photos.service';
import { CreatePhotoUploadUrlDto } from './dto/create-photo-upload-url.dto';
import { CreatePhotoDto } from './dto/create-photo.dto';

@Controller('admin/photos')
@UseGuards(TenantGuard)
export class PhotosController {
  constructor(private readonly photos: PhotosService) {}

  @Get()
  list() {
    return this.photos.list();
  }

  @Post('upload-url')
  @HttpCode(HttpStatus.OK)
  createUploadUrl(@CurrentTenant() tenantId: string, @Body() dto: CreatePhotoUploadUrlDto) {
    return this.photos.createUploadUrl(tenantId, dto.contentType);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  confirm(@Body() dto: CreatePhotoDto) {
    return this.photos.confirm(dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Param('id') id: string) {
    await this.photos.delete(id);
  }
}
```

- [ ] **Step 11.7: Atualizar CatalogModule**

Edite `src/modules/catalog/catalog.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { BarbersModule } from 'src/modules/barbers/barbers.module';
import { ServicesController } from './services.controller';
import { ServicesService } from './services.service';
import { ServiceRepository } from './repositories/service.repository';
import { PhotosController } from './photos.controller';
import { PhotosService } from './photos.service';
import { PhotoRepository } from './repositories/photo.repository';

@Module({
  imports: [BarbersModule],
  controllers: [ServicesController, PhotosController],
  providers: [ServicesService, ServiceRepository, PhotosService, PhotoRepository],
  exports: [ServicesService, ServiceRepository],
})
export class CatalogModule {}
```

- [ ] **Step 11.8: Rodar testes e ver PASSAR**

```bash
npx jest --config jest.config.ts src/modules/catalog
```
Expected: PASS em todos.

- [ ] **Step 11.9: Build geral + lint**

```bash
npm run lint && npm run build && npm run test
```

- [ ] **Step 11.10: Commit**

```bash
git add src/modules/catalog
git commit -m "feat(catalog): photos upload-url + confirm + delete via StorageProvider"
```

---

## Task 12: Configurar implementação R2 (Cloudflare) do StorageProvider

**Files:**
- Modify: `package.json`
- Create: `src/modules/storage/providers/r2-storage.provider.ts`
- Modify: `src/modules/storage/storage.module.ts`

> Esta task adiciona a impl real. Testes E2E continuam com `STORAGE_PROVIDER=console`.

- [ ] **Step 12.1: Instalar dependências**

Run:
```bash
npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

- [ ] **Step 12.2: Implementar provider**

Crie `src/modules/storage/providers/r2-storage.provider.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { S3Client, DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PresignedUpload, StorageProvider } from '../storage.provider';

@Injectable()
export class R2StorageProvider implements StorageProvider {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(cfg: ConfigService) {
    const accountId = cfg.getOrThrow<string>('R2_ACCOUNT_ID');
    this.bucket = cfg.getOrThrow<string>('R2_BUCKET');
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: cfg.getOrThrow<string>('R2_ACCESS_KEY_ID'),
        secretAccessKey: cfg.getOrThrow<string>('R2_SECRET_ACCESS_KEY'),
      },
    });
  }

  async presignUpload(input: {
    tenantId: string;
    contentType: string;
    extension: string;
    maxBytes: number;
    ttlSeconds: number;
  }): Promise<PresignedUpload> {
    const r2Key = `tenants/${input.tenantId}/photos/${randomUUID()}.${input.extension}`;
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: r2Key,
      ContentType: input.contentType,
      ContentLength: input.maxBytes,
    });
    const uploadUrl = await getSignedUrl(this.client, cmd, { expiresIn: input.ttlSeconds });
    return {
      uploadUrl,
      r2Key,
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000),
      contentType: input.contentType,
      maxBytes: input.maxBytes,
    };
  }

  async delete(r2Key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: r2Key }));
    } catch {
      // best-effort
    }
  }
}
```

- [ ] **Step 12.3: Atualizar StorageModule**

Edite `src/modules/storage/storage.module.ts`. Substitua a useFactory:

```typescript
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { STORAGE_PROVIDER } from './storage.provider';
import { ConsoleStorageProvider } from './providers/console-storage.provider';
import { R2StorageProvider } from './providers/r2-storage.provider';

@Global()
@Module({
  providers: [
    {
      provide: STORAGE_PROVIDER,
      useFactory: (cfg: ConfigService) => {
        const provider = cfg.get<string>('STORAGE_PROVIDER');
        if (provider === 'console') return new ConsoleStorageProvider();
        if (provider === 'r2') return new R2StorageProvider(cfg);
        throw new Error(`Unsupported STORAGE_PROVIDER: ${provider}`);
      },
      inject: [ConfigService],
    },
  ],
  exports: [STORAGE_PROVIDER],
})
export class StorageModule {}
```

- [ ] **Step 12.4: Verificar build + lint**

```bash
npm run lint && npm run build && npm run test
```
Expected: tudo verde. (Sem testes unitários novos pro R2 — chamadas reais só em sandbox manual.)

- [ ] **Step 12.5: Commit**

```bash
git add package.json package-lock.json src/modules/storage
git commit -m "feat(storage): Cloudflare R2 provider implementation"
```

---

## Task 13: Estender ConfigModule + .env.example (final)

> Garante que dev local funciona com `STORAGE_PROVIDER=console` e que prod precisa das vars R2.

- [ ] **Step 13.1: Verificar `src/config/config.module.ts`**

Não deve precisar mudar — `Joi` schema já valida (Task 4). Apenas confira que existe export correto.

- [ ] **Step 13.2: Verificar `.env` local**

Garanta que `.env` tem `STORAGE_PROVIDER=console`. Se não tiver, adicione (não commitar `.env`).

```bash
grep -E '^STORAGE_PROVIDER=' .env || echo "STORAGE_PROVIDER=console" >> .env
```

- [ ] **Step 13.3: Boot smoke**

Run:
```bash
npm run start
```
Expected: aplicação sobe na porta padrão, `/health/ready` retorna 200 (assumindo Postgres rodando). Mate o processo após confirmar.

- [ ] **Step 13.4: Commit (apenas se houve mudança em config)**

```bash
git status
# Se nada mudou, pular commit.
```

---

## Task 14: E2E happy-path — "configura barbearia inteira" (critério de aceite da Fase 2)

**Files:**
- Create: `test/e2e/barber-panel-setup.e2e-spec.ts`

- [ ] **Step 14.1: Escrever o teste**

Crie `test/e2e/barber-panel-setup.e2e-spec.ts`:

```typescript
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';

interface AuthResponse {
  user: { id: string; email: string; role: string };
  tenant?: { id: string; slug: string };
  accessToken: string;
  refreshToken: string;
  tenantId?: string;
}

interface BarberResponse {
  id: string;
  displayName: string;
}

interface ServiceResponse {
  id: string;
  name: string;
  durationMin: number;
  priceCents: number;
}

interface PhotoUploadUrlResponse {
  uploadUrl: string;
  r2Key: string;
  expiresAt: string;
  contentType: string;
  maxBytes: number;
}

interface PhotoResponse {
  id: string;
  r2Key: string;
}

interface TenantResponse {
  id: string;
  slug: string;
  name: string;
  bio: string | null;
  address: string | null;
  businessHours: unknown;
}

describe('Painel do Barbeiro — configura barbearia inteira (e2e)', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    setTestEnv();
    process.env.STORAGE_PROVIDER = 'console';
    container = await startTestPostgres();
    app = await buildTestApp();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('configura perfil, horário, 3 barbeiros, 5 serviços, 10 fotos (acceptance)', async () => {
    // ---- 1. Cadastra owner + tenant
    const reg = await request(app.getHttpServer())
      .post('/auth/register/owner')
      .send({
        email: 'dono@barbearia.test',
        password: 'StrongPass!1',
        name: 'Dono',
        tenantName: 'Studio do Bigode',
        slug: 'studio-bigode',
      })
      .expect(201);
    const ownerAuth = reg.body as AuthResponse;
    const ownerToken = ownerAuth.accessToken;

    // ---- 2. PATCH /admin/tenant — perfil
    await request(app.getHttpServer())
      .patch('/admin/tenant')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        bio: 'A barbearia mais foda da Zona Sul.',
        address: 'Rua das Tesouras, 42',
        phone: '+55 11 99999-0000',
      })
      .expect(200);

    // ---- 3. PATCH /admin/tenant/business-hours
    await request(app.getHttpServer())
      .patch('/admin/tenant/business-hours')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        businessHours: {
          days: [
            { open: false, intervals: [] },
            { open: true, intervals: [{ startMin: 540, endMin: 1080 }] },
            { open: true, intervals: [{ startMin: 540, endMin: 1080 }] },
            { open: true, intervals: [{ startMin: 540, endMin: 1080 }] },
            { open: true, intervals: [{ startMin: 540, endMin: 1080 }] },
            { open: true, intervals: [{ startMin: 540, endMin: 1140 }] },
            { open: true, intervals: [{ startMin: 600, endMin: 1020 }] },
          ],
        },
      })
      .expect(200);

    // ---- 4. POST /admin/barbers (3 barbeiros)
    const barberIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await request(app.getHttpServer())
        .post('/admin/barbers')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ displayName: `Barbeiro ${i + 1}`, bio: `Bio ${i + 1}` })
        .expect(201);
      const body = res.body as BarberResponse;
      expect(body.id).toBeDefined();
      barberIds.push(body.id);
    }

    // Time-off para o primeiro barbeiro
    await request(app.getHttpServer())
      .post(`/admin/barbers/${barberIds[0]}/time-off`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        startsAt: '2026-06-01T00:00:00Z',
        endsAt: '2026-06-08T00:00:00Z',
        reason: 'férias',
      })
      .expect(201);

    // ---- 5. POST /admin/services (5 serviços)
    const services: ServiceResponse[] = [];
    const catalog = [
      { name: 'Corte tradicional', durationMin: 30, priceCents: 5000 },
      { name: 'Corte + barba', durationMin: 60, priceCents: 9000 },
      { name: 'Barba', durationMin: 25, priceCents: 4000 },
      { name: 'Pigmentação', durationMin: 45, priceCents: 8000 },
      { name: 'Sobrancelha', durationMin: 15, priceCents: 2500 },
    ];
    for (const s of catalog) {
      const res = await request(app.getHttpServer())
        .post('/admin/services')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(s)
        .expect(201);
      services.push(res.body as ServiceResponse);
    }

    // Vincula barbeiros nos serviços
    for (const svc of services) {
      await request(app.getHttpServer())
        .put(`/admin/services/${svc.id}/barbers`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ barberIds })
        .expect(200);
    }

    // ---- 6. Upload de 10 fotos
    for (let i = 0; i < 10; i++) {
      const presign = await request(app.getHttpServer())
        .post('/admin/photos/upload-url')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ contentType: 'image/jpeg' })
        .expect(200);
      const presignBody = presign.body as PhotoUploadUrlResponse;
      expect(presignBody.r2Key).toMatch(/tenants\/.*\/photos\//);

      const confirmed = await request(app.getHttpServer())
        .post('/admin/photos')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ r2Key: presignBody.r2Key, caption: `Foto ${i + 1}` })
        .expect(201);
      expect((confirmed.body as PhotoResponse).id).toBeDefined();
    }

    // ---- 7. GETs finais validam estado
    const list = await request(app.getHttpServer())
      .get('/admin/photos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect((list.body as PhotoResponse[]).length).toBe(10);

    const tenantState = await request(app.getHttpServer())
      .get('/admin/tenant')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const t = tenantState.body as TenantResponse;
    expect(t.bio).toContain('Zona Sul');
    expect(t.address).toContain('Tesouras');
    expect(t.businessHours).toBeTruthy();

    const barbersList = await request(app.getHttpServer())
      .get('/admin/barbers')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect((barbersList.body as BarberResponse[]).length).toBe(3);

    const servicesList = await request(app.getHttpServer())
      .get('/admin/services')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect((servicesList.body as ServiceResponse[]).length).toBe(5);
  }, 120_000);

  it('barbeiro convidado consegue fazer login e editar próprio perfil', async () => {
    // Registra outro tenant pra testar o fluxo de convite isoladamente
    const reg = await request(app.getHttpServer())
      .post('/auth/register/owner')
      .send({
        email: 'dono2@barbearia.test',
        password: 'StrongPass!1',
        name: 'Dono 2',
        tenantName: 'Outra Barbearia',
        slug: 'outra-barbearia',
      })
      .expect(201);
    const ownerAuth = reg.body as AuthResponse;

    // Cria barber com email → dispara convite. ConsoleEmailProvider só loga; capturamos o token via banco.
    const create = await request(app.getHttpServer())
      .post('/admin/barbers')
      .set('Authorization', `Bearer ${ownerAuth.accessToken}`)
      .send({ displayName: 'Joaquim', email: 'joaquim@barbeiros.test' })
      .expect(201);
    const barber = create.body as BarberResponse;

    // Tira o token plain do banco (ConsoleEmailProvider não retorna; em prod seria via email).
    // Pegamos o hash + emitimos o mesmo plain reproduzindo a lógica do service? Não — em vez disso,
    // expomos o token re-emitindo via direct DB lookup: reissue is the safest test hook.
    //
    // ALTERNATIVA SIMPLES (recomendada): no console provider de email guardamos em memória os emails enviados.
    // Para evitar mexer no provider, fazemos issue manualmente via service no contexto do teste.
    const { PrismaService } = await import('src/infra/prisma/prisma.service');
    const { BarberInvitationsService } = await import(
      'src/modules/barbers/barber-invitations.service'
    );
    const prisma = app.get(PrismaService);
    const invitationsSvc = app.get(BarberInvitationsService);

    // Reemite convite e captura o plain token (substitui o de produção; aceita-se o impacto no teste)
    let tokenPlain = '';
    await prisma.withTenant(ownerAuth.tenant!.id, async () => {
      const issued = await invitationsSvc.issue({
        barberId: barber.id,
        email: 'joaquim@barbeiros.test',
        displayName: 'Joaquim',
      });
      tokenPlain = issued.tokenPlain;
    });
    expect(tokenPlain.length).toBeGreaterThan(20);

    // Aceita o convite
    const accept = await request(app.getHttpServer())
      .post('/auth/barbers/accept-invite')
      .send({ token: tokenPlain, password: 'StrongPass!1', name: 'Joaquim' })
      .expect(200);
    const acceptBody = accept.body as AuthResponse;
    expect(acceptBody.user.role).toBe('barber_member');
    expect(acceptBody.tenantId).toBe(ownerAuth.tenant!.id);

    // Joaquim edita o próprio perfil
    await request(app.getHttpServer())
      .patch(`/admin/barbers/${barber.id}`)
      .set('Authorization', `Bearer ${acceptBody.accessToken}`)
      .send({ bio: 'Especialista em barba' })
      .expect(200);

    // Joaquim tenta criar outro barbeiro — deve falhar (role barber_member não tem permissão)
    const denied = await request(app.getHttpServer())
      .post('/admin/barbers')
      .set('Authorization', `Bearer ${acceptBody.accessToken}`)
      .send({ displayName: 'X' });
    expect(denied.status).toBe(403);
  }, 120_000);
});
```

- [ ] **Step 14.2: Rodar o E2E**

Run:
```bash
npm run test:e2e -- --testPathPattern barber-panel-setup
```
Expected: PASS em ambos os testes.

- [ ] **Step 14.3: Rodar tudo (regressão completa)**

Run:
```bash
npm run lint && npm run build && npm run test && npm run test:e2e
```
Expected: tudo verde.

- [ ] **Step 14.4: Commit**

```bash
git add test/e2e/barber-panel-setup.e2e-spec.ts
git commit -m "test(e2e): phase 2 acceptance — barber configures full barbershop"
```

---

## Critério de aceite final da Fase 2

✅ O E2E `barber-panel-setup.e2e-spec.ts` passa: um tenant_owner registra a conta, atualiza o perfil da barbearia, define horário de funcionamento, cria 3 barbeiros (1 com convite + aceite + edit own profile), 5 serviços, vincula barbeiros↔serviços e sobe 10 fotos via presigned URL → todos os endpoints respondem como esperado.

✅ O E2E `tenant-isolation.e2e-spec.ts` continua passando, agora incluindo regressão pra `Barber` (e por extensão pros demais modelos `TENANT_SCOPED_MODELS`).

✅ `npm run lint && npm run build && npm run test && npm run test:e2e` — tudo verde.

---

## Notas pra Fase 3 (não fazer agora)

- O frontend pública (`/public/{slug}/*`) consome o que foi escrito aqui. Garantir que `bio`, `address`, `businessHours`, `photos`, `services`, `barbers` retornem todos os campos necessários.
- `AvailabilityService` (Fase 3) vai precisar:
  - `Tenant.businessHours` no formato definido em `business-hours.ts`.
  - `Service.durationMin`.
  - `Appointment` ainda não existe — vai surgir com a Fase 3.
  - `TimeOff` overlap-aware.
- `R2_PUBLIC_URL` opcional para servir storefront — deixar pra Fase 3 quando precisar.
- Limpeza de fotos no R2 quando `deletedAt` é setado: cron de Fase 6 (LGPD job).
- Endpoint de "reenviar convite" pra barbeiro órfão: parking lot.
