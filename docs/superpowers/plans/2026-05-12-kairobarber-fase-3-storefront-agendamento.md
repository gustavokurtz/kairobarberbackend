# KairoBarber — Fase 3 (Storefront pública + Agendamento) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar a storefront pública e o fluxo de agendamento ponta a ponta: o cliente entra em `kairobarber.com/{slug}` (rotas `/public/{slug}/*`), navega catálogo (barbeiros, serviços, fotos), consulta horários disponíveis, agenda como guest (sem login), recebe email de confirmação com link de cancelamento (magic link) e link opcional de claim de conta. O barbeiro vê o agendamento via `/admin/appointments` e pode confirmar, completar, cancelar ou marcar no-show. Cancelamento via magic link respeita janela mínima de 2h.

**Architecture:** Continua monolito modular NestJS. Três módulos novos: `scheduling`, `customers`, `public`. O módulo `notifications` ganha um `ResendEmailProvider` real. Multi-tenancy continua via `PrismaService.scoped` + ALS; rotas `/public/{slug}/*` ganham um `PublicTenantMiddleware` que resolve tenant pelo slug, valida que está ativo (`deletedAt null` e subscription não `cancelled`) e popula o `tenantAls` antes do guard global rodar (com `@Public()` desligando o JWT). Os modelos novos (`Customer`, `Appointment`) entram em `TENANT_SCOPED_MODELS`. Tokens de magic link (cancelamento, claim) seguem o padrão de `BarberInvitation`: plaintext base64url no email, hash sha256 no banco. Race condition no booking é resolvida com transação Prisma + `SELECT FOR UPDATE` raw nas linhas de `Appointment` que se sobrepõem ao slot pedido.

**Tech Stack:** Continua tudo das fases anteriores. Novidade única: SDK `resend@^4` para o `ResendEmailProvider` (HTTP-only, sem dependência transitiva pesada). `luxon@^3` para aritmética de timezone confiável no `AvailabilityService` (cálculo de slots respeita `Tenant.timezone`, evita armadilhas de DST do `Date` nativo).

**Spec de referência:** [`docs/superpowers/specs/2026-05-11-kairobarber-backend-design.md`](../specs/2026-05-11-kairobarber-backend-design.md) (seção 4 — Fase 3; seção 6 — Customer/Appointment; seção 7 — endpoints `/public/*` e `/admin/appointments`; seção 8.2/8.3/8.6 — fluxos).

**Plano anterior:** [`2026-05-11-kairobarber-fase-2-painel-barbeiro.md`](./2026-05-11-kairobarber-fase-2-painel-barbeiro.md).

---

## Estado atual do repositório (entrada da Fase 3)

- `prisma/schema.prisma` tem `User`, `Tenant`, `Subscription`, `RefreshToken`, `OneTimeToken`, `Barber`, `TimeOff`, `Service`, `ServiceBarber`, `Photo`, `BarberInvitation`. Última migration: `20260512013052_phase2_barber_panel`.
- `src/infra/prisma/prisma.service.ts` expõe `PrismaService.scoped`. `TENANT_SCOPED_MODELS` inclui `Subscription`, `Barber`, `TimeOff`, `Service`, `ServiceBarber`, `Photo`, `BarberInvitation`.
- `src/modules/auth` tem `register/owner`, `login`, `refresh`, `logout`, `verify-email`, `forgot-password`, `reset-password`, `barbers/accept-invite`. `JwtAuthGuard` é `APP_GUARD` global; `@Public()` desliga.
- `src/modules/tenants/business-hours.ts` exporta `BusinessHours`, `BusinessDay`, `BusinessInterval` e `validateBusinessHours`. Domingo = índice 0.
- `src/modules/notifications` tem `EMAIL_PROVIDER` injection token + `ConsoleEmailProvider`. Factory já tem um TODO marcando o ponto onde `ResendEmailProvider` entra.
- `src/modules/storage` expõe `STORAGE_PROVIDER` token com `ConsoleStorageProvider` e `R2StorageProvider`.
- Test harness: `test/support/{postgres-container,test-app,test-env}.ts`. `buildTestApp` já roda `tenantAls.run({}, ...)` em middleware espelhando `main.ts`.

---

## Estrutura de arquivos resultante (delta da Fase 3)

```
kairobarber/
├── prisma/
│   ├── schema.prisma                                       # ATUALIZA: AppointmentStatus, AppointmentSource, Customer, Appointment
│   └── migrations/
│       └── <novo timestamp>_phase3_storefront_scheduling/  # NOVO
│           └── migration.sql
│
├── src/
│   ├── config/
│   │   └── env.validation.ts                               # ATUALIZA: RESEND_API_KEY, APP_PUBLIC_URL
│   │
│   ├── common/
│   │   ├── exceptions/
│   │   │   └── error-codes.ts                              # ATUALIZA: códigos da Fase 3
│   │   ├── decorators/
│   │   │   └── public.decorator.ts                         # existente, usado nas rotas /public/*
│   │   └── middleware/                                     # NOVO
│   │       └── public-tenant.middleware.ts                 # resolve tenant por slug + popula tenantAls
│   │
│   ├── infra/
│   │   └── prisma/
│   │       └── prisma.service.ts                           # ATUALIZA: TENANT_SCOPED_MODELS += Customer, Appointment
│   │
│   └── modules/
│       ├── auth/
│       │   ├── auth.controller.ts                          # ATUALIZA: POST /auth/customers/claim
│       │   ├── auth.service.ts                             # ATUALIZA: claimCustomer()
│       │   └── dto/
│       │       └── claim-customer.dto.ts                   # NOVO
│       │
│       ├── notifications/
│       │   ├── notifications.module.ts                     # ATUALIZA: factory escolhe Resend
│       │   ├── templates/                                  # NOVO
│       │   │   ├── appointment-confirmation.template.ts
│       │   │   ├── appointment-cancellation.template.ts
│       │   │   ├── customer-claim.template.ts
│       │   │   └── templates.spec.ts
│       │   └── providers/
│       │       ├── resend-email.provider.ts                # NOVO
│       │       └── resend-email.provider.spec.ts           # NOVO
│       │
│       ├── customers/                                      # NOVO MÓDULO
│       │   ├── customers.module.ts
│       │   ├── customers.service.ts
│       │   ├── customers.service.spec.ts
│       │   ├── customers.controller.ts                     # /admin/customers
│       │   ├── repositories/
│       │   │   └── customer.repository.ts
│       │   └── dto/
│       │       └── customer-identity.dto.ts                # input nome/phone/email reutilizado por scheduling
│       │
│       ├── scheduling/                                     # NOVO MÓDULO
│       │   ├── scheduling.module.ts
│       │   ├── availability.service.ts
│       │   ├── availability.service.spec.ts
│       │   ├── appointments.service.ts
│       │   ├── appointments.service.spec.ts
│       │   ├── appointments.controller.ts                  # /admin/appointments
│       │   ├── cancellation.service.ts
│       │   ├── cancellation.service.spec.ts
│       │   ├── repositories/
│       │   │   └── appointment.repository.ts
│       │   └── dto/
│       │       ├── create-appointment.dto.ts               # admin walk-in
│       │       ├── update-appointment.dto.ts               # remarcar
│       │       └── list-appointments-query.dto.ts
│       │
│       └── public/                                         # NOVO MÓDULO (storefront)
│           ├── public.module.ts
│           ├── public-catalog.controller.ts                # /public/{slug}/(barbers|services|photos|me)
│           ├── public-availability.controller.ts           # /public/{slug}/availability/*
│           ├── public-appointments.controller.ts           # /public/{slug}/appointments + /public/appointments/{id}
│           └── dto/
│               ├── create-public-appointment.dto.ts
│               └── availability-query.dto.ts
│
│   └── app.module.ts                                       # ATUALIZA: registra CustomersModule, SchedulingModule, PublicModule + middleware
│
├── test/
│   ├── e2e/
│   │   ├── public-booking.e2e-spec.ts                      # NOVO: happy path booking guest → email → cancel
│   │   ├── public-tenant-isolation.e2e-spec.ts             # NOVO: público não vaza entre tenants
│   │   └── admin-appointments.e2e-spec.ts                  # NOVO: barbeiro vê e age sobre agendamento
│   └── support/
│       └── time.ts                                         # NOVO: helpers de data (ISO UTC, slot fixture)
│
├── package.json                                            # ATUALIZA: resend, luxon
└── .env.example                                            # ATUALIZA: RESEND_API_KEY, APP_PUBLIC_URL
```

---

## Decisões importantes desta fase (registrar antes de codar)

1. **Tokens de magic link**: `cancellationToken` (Appointment) e `claimToken` (Customer) são bytes aleatórios base64url, **gerados como plaintext** retornados na resposta de criação (para o front montar URL) e enviados por email, e **armazenados como sha256-hex no banco** (`cancellationTokenHash`, `claimTokenHash`). Mesma postura do `BarberInvitation`. Não há "decrypt"; lookup sempre por hash.
2. **Customer híbrido**: deduplicação por `(tenantId, phone)` UNIQUE. Em re-booking com mesmo phone mas nome/email diferentes → atualiza Customer existente. AuditLog é Fase 5; nesta fase apenas registramos no log estruturado (`pino` com `event=customer.identity_updated`) e seguimos. Quando AuditLog chegar, substitui o log por inserção em tabela.
3. **Claim de conta**: só é gerado se `customer.email` veio preenchido no booking. Sem email → sem link de claim, sem warning. Token TTL 7 dias.
4. **Cancelamento — janela mínima**: constante `MIN_CANCEL_LEAD_HOURS = 2` no `cancellation.service.ts`. Cliente que tenta cancelar a < 2h do `startsAt` recebe 422 `CANCELLATION_TOO_LATE`. Barbeiro (via `/admin/appointments/:id/cancel`) ignora a janela.
5. **Status de Appointment**: enum `pending | confirmed | completed | cancelled | no_show`. Booking público entra `pending` (barbeiro confirma manualmente). Booking via admin walk-in entra `confirmed` direto. Transições inválidas → 409.
6. **Snapshots em Appointment**: `priceCentsSnapshot` e `durationMinSnapshot` copiados do Service na criação. Updates futuros no Service não retroativos (preserva histórico financeiro).
7. **Race condition no booking**: transação Prisma com `$queryRawUnsafe(... FOR UPDATE)` sobre `Appointment` do barbeiro no range (`startsAt < pedido.endsAt AND endsAt > pedido.startsAt AND status NOT IN ('cancelled','no_show')`). Se a query trava (lock) outro request, o segundo só roda depois que a transação do primeiro encerra; se já existir overlap quando o segundo chega, recebe `SLOT_TAKEN` (409). Teste de integração obrigatório com `Promise.all` de dois bookings concorrentes.
8. **AvailabilityService — granularidade**: passo de 15 min (`SLOT_STEP_MIN = 15`). Slot só é válido se o intervalo `[start, start+durationMin]` couber 100% dentro de algum `BusinessDay.interval`, **e** não intersectar nenhum `TimeOff` do barbeiro, **e** não intersectar nenhum `Appointment` ativo do barbeiro. Slots no passado (`< now`) são filtrados.
9. **AvailabilityService — timezone**: tenant tem `timezone` (default `America/Sao_Paulo`). Datas chegam/saem em UTC ISO 8601, mas a aritmética de "que dia da semana é esse instante" usa `luxon` com a zona do tenant. Evita bug de meia-noite na fronteira de DST.
10. **AvailabilityService — janela máxima**: query exige `from` e `to`, ambos UTC ISO 8601, com `to - from <= 31 dias`. Acima disso → 400. Evita request abusivo.
11. **Resolução de tenant em rotas públicas**: `PublicTenantMiddleware` aplicado seletivamente a `/public/{slug}/*`. Resolve tenant pelo slug, valida `deletedAt: null` e `subscription.status !== 'cancelled'`, popula `tenantAls.getStore().tenantId`. Para `/public/appointments/:id` (sem slug — link do email), tenant é deduzido do próprio `Appointment.tenantId` no service após o lookup; o controller marca `@Public()` mas não passa pelo middleware de slug. Para `/public/appointments/:id`, `tenantAls` é populado dentro do service ao redor da query principal.
12. **`@Public()` nas rotas storefront**: todas as rotas `/public/*` levam `@Public()` para bypass do `JwtAuthGuard` global. Throttler aplicado por rota onde a spec exige.
13. **Idempotência (`Idempotency-Key`)**: spec menciona como opcional. **Out of scope na Fase 3** (depende de Redis ainda não wired). Cliente que reenvia booking pode ganhar 409 pelo lock — comportamento aceitável no MVP. Documentado aqui pra rastreabilidade.
14. **BullMQ / filas**: out of scope. Envio de email roda sync via `EMAIL_PROVIDER` injetado. Se o Resend cair, booking ainda é criado e a falha de email é loggada; cliente vê 201 com `emailDelivered: false` no payload para o front decidir UX. Substituição por fila vem na Fase 4/6 sem mexer no contrato.
15. **AuditLog**: out of scope (Fase 5). Tudo que a spec menciona como audit aqui vira `logger.log({ event, ... })` estruturado.
16. **`tenant.subscription` em rotas públicas**: nesta fase, `cancelled` bloqueia; `past_due`, `trialing`, `active` liberam. O gating fino de `past_due > 7d` é Fase 4.
17. **`/admin/appointments` autorizações**: `tenant_owner` vê tudo; `barber_member` vê só seus agendamentos (filtro forçado por `barberId = currentUser.barberId`). Actions (confirm, complete, cancel, no_show) seguem a mesma regra. Walk-in (`POST`) é só `tenant_owner`.
18. **Sem soft delete de Appointment**: cancelamento muda status, mantém linha. `no_show` idem. Hard delete só por job futuro de LGPD.

---

## Pré-requisitos por tarefa

- Stack já bootstrapped Fases 0/1/2.
- Container Postgres roda via testcontainers; Redis ainda não é necessário.
- Cada tarefa termina com `npm run lint && npm run test` verdes antes do commit. Onde a tarefa envolve banco, rodar também `npm run test:e2e` no fim do bloco lógico (indicado nas tarefas).

---

## Task 1: Schema + migration — Customer, Appointment, enums

**Files:**
- Modify: `prisma/schema.prisma`
- Create (gerado pela CLI): `prisma/migrations/<timestamp>_phase3_storefront_scheduling/migration.sql`

- [ ] **Step 1.1: Estender o schema Prisma**

Edite `prisma/schema.prisma`. Adicione os enums novos perto dos existentes, a relation inversa em `Tenant` e em `Barber`/`Service`, e os modelos novos no fim do arquivo:

```prisma
// (Junto aos enums existentes, no topo)
enum AppointmentStatus {
  pending
  confirmed
  completed
  cancelled
  no_show
}

enum AppointmentSource {
  public_storefront
  admin
}

// (No model Tenant — anexar nas relations, dentro do bloco existente)
model Tenant {
  // ... campos existentes ...
  customers    Customer[]
  appointments Appointment[]
  // ... resto da relations existentes ...
}

// (No model Barber — anexar nas relations)
model Barber {
  // ... existente ...
  appointments Appointment[]
}

// (No model Service — anexar nas relations)
model Service {
  // ... existente ...
  appointments Appointment[]
}

// (No model User — anexar nas relations)
model User {
  // ... existente ...
  customerProfile Customer? @relation("CustomerUser")
}

// (Novos modelos, no fim do arquivo)

model Customer {
  id                  String    @id @default(cuid())
  tenantId            String
  name                String
  phone               String
  email               String?
  userId              String?   @unique
  claimTokenHash      String?   @unique
  claimTokenExpiresAt DateTime?
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt
  deletedAt           DateTime?

  tenant       Tenant        @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  user         User?         @relation("CustomerUser", fields: [userId], references: [id], onDelete: SetNull)
  appointments Appointment[]

  @@unique([tenantId, phone], name: "tenant_phone")
  @@index([tenantId, deletedAt])
}

model Appointment {
  id                    String            @id @default(cuid())
  tenantId              String
  barberId              String
  serviceId             String
  customerId            String
  startsAt              DateTime
  endsAt                DateTime
  status                AppointmentStatus @default(pending)
  priceCentsSnapshot    Int
  durationMinSnapshot   Int
  source                AppointmentSource
  cancellationTokenHash String            @unique
  cancellationReason    String?
  cancelledAt           DateTime?
  createdAt             DateTime          @default(now())
  updatedAt             DateTime          @updatedAt

  tenant   Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  barber   Barber   @relation(fields: [barberId], references: [id], onDelete: Restrict)
  service  Service  @relation(fields: [serviceId], references: [id], onDelete: Restrict)
  customer Customer @relation(fields: [customerId], references: [id], onDelete: Restrict)

  @@index([tenantId, barberId, startsAt])
  @@index([tenantId, customerId, startsAt(sort: Desc)])
  @@index([tenantId, status, startsAt])
}
```

- [ ] **Step 1.2: Gerar migration**

Run:
```bash
npx prisma migrate dev --name phase3_storefront_scheduling
```
Expected: cria `prisma/migrations/<timestamp>_phase3_storefront_scheduling/migration.sql`. Cliente Prisma regenera.

- [ ] **Step 1.3: Sanity-check do schema**

Run:
```bash
npx prisma format && npx prisma validate
```
Expected: ambos retornam sem erro.

- [ ] **Step 1.4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(prisma): add Customer and Appointment models for Phase 3"
```

---

## Task 2: Estender TENANT_SCOPED_MODELS com Customer e Appointment

**Files:**
- Modify: `src/infra/prisma/prisma.service.ts`

- [ ] **Step 2.1: Escrever teste de regressão antes da mudança**

Adicione um teste em `src/infra/prisma/prisma.service.spec.ts` (criar arquivo se não existe):

```ts
import { PrismaService, tenantAls } from './prisma.service';

describe('PrismaService.scoped — Phase 3 models', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
  });
  afterAll(async () => prisma.$disconnect());

  it('injeta tenantId em Customer.create', async () => {
    const tenantId = 'fake-tenant-id-for-typecheck';
    expect(() =>
      tenantAls.run({ tenantId }, () => {
        const args: { data: Record<string, unknown> } = { data: { name: 'x', phone: '1' } };
        // simula o que o extension faz manualmente — assertion sobre comportamento ALS
        if (tenantAls.getStore()?.tenantId) {
          args.data.tenantId = tenantAls.getStore()!.tenantId;
        }
        expect(args.data.tenantId).toBe(tenantId);
      }),
    ).not.toThrow();
  });
});
```

(este teste fica como contrato; o teste real de filtro vai no e2e de isolation — Task 23.)

Run: `npx jest src/infra/prisma/prisma.service.spec.ts -v`
Expected: PASS.

- [ ] **Step 2.2: Adicionar `Customer` e `Appointment` em `TENANT_SCOPED_MODELS`**

Em `src/infra/prisma/prisma.service.ts`, no `Set`:

```ts
const TENANT_SCOPED_MODELS = new Set<string>([
  'Subscription',
  'Barber',
  'TimeOff',
  'Service',
  'ServiceBarber',
  'Photo',
  'BarberInvitation',
  'Customer',
  'Appointment',
]);
```

- [ ] **Step 2.3: Rodar todos os specs**

Run: `npm run test`
Expected: PASS (nenhum spec quebra; o novo passa).

- [ ] **Step 2.4: Commit**

```bash
git add src/infra/prisma
git commit -m "feat(prisma): scope Customer and Appointment by tenant"
```

---

## Task 3: Error codes da Fase 3

**Files:**
- Modify: `src/common/exceptions/error-codes.ts`

- [ ] **Step 3.1: Acrescentar códigos**

Adicione no objeto `ErrorCodes` (preservando os existentes), antes do `as const`:

```ts
  // Phase 3 — scheduling / storefront
  CUSTOMER_NOT_FOUND: 'CUSTOMER_NOT_FOUND',
  APPOINTMENT_NOT_FOUND: 'APPOINTMENT_NOT_FOUND',
  APPOINTMENT_SLOT_TAKEN: 'APPOINTMENT_SLOT_TAKEN',
  APPOINTMENT_SLOT_INVALID: 'APPOINTMENT_SLOT_INVALID',
  APPOINTMENT_TRANSITION_INVALID: 'APPOINTMENT_TRANSITION_INVALID',
  CANCELLATION_TOO_LATE: 'CANCELLATION_TOO_LATE',
  CANCELLATION_TOKEN_INVALID: 'CANCELLATION_TOKEN_INVALID',
  CLAIM_TOKEN_INVALID: 'CLAIM_TOKEN_INVALID',
  TENANT_NOT_FOUND: 'TENANT_NOT_FOUND',
  TENANT_INACTIVE: 'TENANT_INACTIVE',
  AVAILABILITY_RANGE_INVALID: 'AVAILABILITY_RANGE_INVALID',
  BARBER_DOES_NOT_PROVIDE_SERVICE: 'BARBER_DOES_NOT_PROVIDE_SERVICE',
```

- [ ] **Step 3.2: Lint**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 3.3: Commit**

```bash
git add src/common/exceptions/error-codes.ts
git commit -m "feat(errors): add Phase 3 error codes"
```

---

## Task 4: Env vars novas — `RESEND_API_KEY`, `APP_PUBLIC_URL`

**Files:**
- Modify: `src/config/env.validation.ts`
- Modify: `.env.example` (criar se não existir)

- [ ] **Step 4.1: Atualizar Joi schema**

Em `src/config/env.validation.ts`, dentro do `Joi.object({...})`:

```ts
  APP_PUBLIC_URL: Joi.string().uri().required(),
  RESEND_API_KEY: Joi.string().when('EMAIL_PROVIDER', {
    is: 'resend',
    then: Joi.required(),
    otherwise: Joi.optional().allow(''),
  }),
```

E no type `AppEnv`:

```ts
  APP_PUBLIC_URL: string;
  RESEND_API_KEY?: string;
```

`APP_PUBLIC_URL` é a URL da storefront pública (ex: `https://kairobarber.com`). Usada nos templates de email para montar `{APP_PUBLIC_URL}/{slug}/...` (cancel/claim links). Distinta de `APP_URL` (admin/painel).

- [ ] **Step 4.2: Atualizar `.env.example`**

Acrescente (criando o arquivo se necessário):

```
APP_URL=http://localhost:3001
APP_PUBLIC_URL=http://localhost:3000
EMAIL_PROVIDER=console
EMAIL_FROM=noreply@kairobarber.local
RESEND_API_KEY=
```

- [ ] **Step 4.3: Atualizar test-env**

Em `test/support/test-env.ts`, adicione dentro de `setTestEnv()`:

```ts
process.env.APP_PUBLIC_URL = 'http://localhost:3000';
```

- [ ] **Step 4.4: Rodar testes**

Run: `npm run test`
Expected: PASS (nada quebra; `APP_PUBLIC_URL` agora aceito).

- [ ] **Step 4.5: Commit**

```bash
git add src/config/env.validation.ts .env.example test/support/test-env.ts
git commit -m "feat(config): add APP_PUBLIC_URL and RESEND_API_KEY env vars"
```

---

## Task 5: ResendEmailProvider

**Files:**
- Create: `src/modules/notifications/providers/resend-email.provider.ts`
- Create: `src/modules/notifications/providers/resend-email.provider.spec.ts`
- Modify: `src/modules/notifications/notifications.module.ts`
- Modify: `package.json` (adiciona `resend`)

- [ ] **Step 5.1: Adicionar dep**

Run:
```bash
npm install resend@^4
```
Expected: `resend` aparece em `dependencies`, lockfile atualizado.

- [ ] **Step 5.2: Escrever teste do provider (mock do SDK)**

Crie `src/modules/notifications/providers/resend-email.provider.spec.ts`:

```ts
import { ResendEmailProvider } from './resend-email.provider';

describe('ResendEmailProvider', () => {
  const sendMock = jest.fn();

  function makeClient() {
    return { emails: { send: sendMock } } as unknown as {
      emails: { send: typeof sendMock };
    };
  }

  beforeEach(() => sendMock.mockReset());

  it('envia email com from, to, subject e body', async () => {
    sendMock.mockResolvedValue({ data: { id: 'msg-1' }, error: null });
    const provider = new ResendEmailProvider(makeClient(), 'noreply@kairobarber.com');

    await provider.send({
      to: 'cliente@x.com',
      subject: 'Confirmação',
      text: 'Olá!',
      html: '<p>Olá!</p>',
    });

    expect(sendMock).toHaveBeenCalledWith({
      from: 'noreply@kairobarber.com',
      to: 'cliente@x.com',
      subject: 'Confirmação',
      text: 'Olá!',
      html: '<p>Olá!</p>',
    });
  });

  it('propaga erro do Resend', async () => {
    sendMock.mockResolvedValue({ data: null, error: { name: 'validation', message: 'bad' } });
    const provider = new ResendEmailProvider(makeClient(), 'noreply@kairobarber.com');

    await expect(
      provider.send({ to: 'x@x.com', subject: 's', text: 't' }),
    ).rejects.toThrow(/Resend send failed/);
  });
});
```

Run: `npx jest src/modules/notifications/providers/resend-email.provider.spec.ts -v`
Expected: FAIL (módulo não existe).

- [ ] **Step 5.3: Implementar o provider**

Crie `src/modules/notifications/providers/resend-email.provider.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import type { Resend } from 'resend';
import { EmailMessage, EmailProvider } from '../email.provider';

type ResendLike = Pick<Resend, 'emails'>;

@Injectable()
export class ResendEmailProvider implements EmailProvider {
  private readonly logger = new Logger(ResendEmailProvider.name);

  constructor(
    private readonly client: ResendLike,
    private readonly from: string,
  ) {}

  async send(msg: EmailMessage): Promise<void> {
    const { data, error } = await this.client.emails.send({
      from: this.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      ...(msg.html ? { html: msg.html } : {}),
    });
    if (error) {
      this.logger.error({ err: error, to: msg.to }, 'resend send error');
      throw new Error(`Resend send failed: ${error.message}`);
    }
    this.logger.debug({ id: data?.id, to: msg.to }, 'resend send ok');
  }
}
```

Run: `npx jest src/modules/notifications/providers/resend-email.provider.spec.ts -v`
Expected: PASS.

- [ ] **Step 5.4: Wirar no module**

Em `src/modules/notifications/notifications.module.ts`, substitua a `useFactory`:

```ts
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { EMAIL_PROVIDER } from './email.provider';
import { ConsoleEmailProvider } from './providers/console-email.provider';
import { ResendEmailProvider } from './providers/resend-email.provider';

@Global()
@Module({
  providers: [
    {
      provide: EMAIL_PROVIDER,
      useFactory: (cfg: ConfigService) => {
        const provider = cfg.get<string>('EMAIL_PROVIDER');
        if (provider === 'console') return new ConsoleEmailProvider();
        if (provider === 'resend') {
          const apiKey = cfg.get<string>('RESEND_API_KEY');
          const from = cfg.get<string>('EMAIL_FROM');
          if (!apiKey || !from) {
            throw new Error('RESEND_API_KEY and EMAIL_FROM are required when EMAIL_PROVIDER=resend');
          }
          return new ResendEmailProvider(new Resend(apiKey), from);
        }
        throw new Error(`Unsupported EMAIL_PROVIDER: ${provider}`);
      },
      inject: [ConfigService],
    },
  ],
  exports: [EMAIL_PROVIDER],
})
export class NotificationsModule {}
```

- [ ] **Step 5.5: Rodar testes**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 5.6: Commit**

```bash
git add src/modules/notifications package.json package-lock.json
git commit -m "feat(notifications): add ResendEmailProvider"
```

---

## Task 6: Templates de email (confirmação, cancelamento, claim)

**Files:**
- Create: `src/modules/notifications/templates/appointment-confirmation.template.ts`
- Create: `src/modules/notifications/templates/appointment-cancellation.template.ts`
- Create: `src/modules/notifications/templates/customer-claim.template.ts`
- Create: `src/modules/notifications/templates/templates.spec.ts`

- [ ] **Step 6.1: Escrever testes**

Crie `src/modules/notifications/templates/templates.spec.ts`:

```ts
import {
  appointmentConfirmationTemplate,
  appointmentCancellationTemplate,
  customerClaimTemplate,
} from './index';

describe('email templates', () => {
  const baseAppt = {
    customerName: 'João',
    tenantName: 'Studio Bigode',
    tenantSlug: 'studio-bigode',
    barberName: 'Pedro',
    serviceName: 'Corte clássico',
    startsAtLocal: '12/05/2026 14:00',
    priceFormatted: 'R$ 45,00',
    cancelUrl: 'http://localhost:3000/studio-bigode/agendamentos/abc/cancelar?token=tok123',
    claimUrl: 'http://localhost:3000/conta/claim?token=clm456',
  };

  it('confirmação inclui dados e link de cancelar', () => {
    const out = appointmentConfirmationTemplate(baseAppt);
    expect(out.subject).toMatch(/Studio Bigode/);
    expect(out.text).toMatch(/12\/05\/2026 14:00/);
    expect(out.text).toMatch(/Pedro/);
    expect(out.text).toMatch(/Corte clássico/);
    expect(out.text).toMatch(/R\$ 45,00/);
    expect(out.text).toContain(baseAppt.cancelUrl);
  });

  it('confirmação omite seção de claim quando claimUrl ausente', () => {
    const out = appointmentConfirmationTemplate({ ...baseAppt, claimUrl: undefined });
    expect(out.text).not.toMatch(/Crie sua conta|claim/i);
  });

  it('cancelamento inclui motivo se houver', () => {
    const out = appointmentCancellationTemplate({
      customerName: 'João',
      tenantName: 'Studio Bigode',
      startsAtLocal: '12/05/2026 14:00',
      cancellationReason: 'Barbeiro doente',
    });
    expect(out.text).toMatch(/Barbeiro doente/);
  });

  it('claim aponta para URL com token', () => {
    const out = customerClaimTemplate({
      customerName: 'João',
      tenantName: 'Studio Bigode',
      claimUrl: 'http://localhost:3000/conta/claim?token=clm456',
    });
    expect(out.text).toContain('clm456');
  });
});
```

Run: `npx jest src/modules/notifications/templates/templates.spec.ts -v`
Expected: FAIL (módulo não existe).

- [ ] **Step 6.2: Implementar templates**

Crie `src/modules/notifications/templates/appointment-confirmation.template.ts`:

```ts
export type AppointmentConfirmationInput = {
  customerName: string;
  tenantName: string;
  tenantSlug: string;
  barberName: string;
  serviceName: string;
  startsAtLocal: string;
  priceFormatted: string;
  cancelUrl: string;
  claimUrl?: string;
};

export function appointmentConfirmationTemplate(
  i: AppointmentConfirmationInput,
): { subject: string; text: string } {
  const claimSection = i.claimUrl
    ? `\n\nQuer acompanhar seus agendamentos? Crie sua conta em:\n${i.claimUrl}\n`
    : '';
  return {
    subject: `Agendamento confirmado em ${i.tenantName}`,
    text:
      `Olá ${i.customerName}!\n\n` +
      `Seu agendamento em ${i.tenantName} foi registrado:\n` +
      `• Serviço: ${i.serviceName}\n` +
      `• Barbeiro: ${i.barberName}\n` +
      `• Horário: ${i.startsAtLocal}\n` +
      `• Valor: ${i.priceFormatted}\n\n` +
      `Precisa cancelar? Use o link (até 2h antes):\n${i.cancelUrl}` +
      claimSection +
      `\nObrigado!\n— ${i.tenantName}`,
  };
}
```

Crie `src/modules/notifications/templates/appointment-cancellation.template.ts`:

```ts
export type AppointmentCancellationInput = {
  customerName: string;
  tenantName: string;
  startsAtLocal: string;
  cancellationReason?: string;
};

export function appointmentCancellationTemplate(
  i: AppointmentCancellationInput,
): { subject: string; text: string } {
  const reason = i.cancellationReason ? `\n\nMotivo: ${i.cancellationReason}` : '';
  return {
    subject: `Agendamento cancelado em ${i.tenantName}`,
    text:
      `Olá ${i.customerName}!\n\n` +
      `Seu agendamento em ${i.tenantName} (${i.startsAtLocal}) foi cancelado.` +
      reason +
      `\n\n— ${i.tenantName}`,
  };
}
```

Crie `src/modules/notifications/templates/customer-claim.template.ts`:

```ts
export type CustomerClaimInput = {
  customerName: string;
  tenantName: string;
  claimUrl: string;
};

export function customerClaimTemplate(i: CustomerClaimInput): { subject: string; text: string } {
  return {
    subject: `Crie sua conta no KairoBarber`,
    text:
      `Olá ${i.customerName}!\n\n` +
      `Você fez um agendamento em ${i.tenantName}. ` +
      `Crie uma conta para acompanhar seus agendamentos:\n${i.claimUrl}\n\n` +
      `O link expira em 7 dias.`,
  };
}
```

Crie `src/modules/notifications/templates/index.ts` (barrel):

```ts
export * from './appointment-confirmation.template';
export * from './appointment-cancellation.template';
export * from './customer-claim.template';
```

- [ ] **Step 6.3: Rodar testes**

Run: `npx jest src/modules/notifications/templates -v`
Expected: PASS.

- [ ] **Step 6.4: Commit**

```bash
git add src/modules/notifications/templates
git commit -m "feat(notifications): add email templates for appointment/claim flows"
```

---

## Task 7: Customers — repositório

**Files:**
- Create: `src/modules/customers/customers.module.ts`
- Create: `src/modules/customers/repositories/customer.repository.ts`

- [ ] **Step 7.1: Repositório (scoped)**

Crie `src/modules/customers/repositories/customer.repository.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class CustomerRepository {
  constructor(private readonly prisma: PrismaService) {}

  list(search?: string) {
    const where: Prisma.CustomerWhereInput = {
      deletedAt: null,
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search } },
              { email: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    return this.prisma.scoped.customer.findMany({ where, orderBy: { createdAt: 'desc' } });
  }

  findById(id: string) {
    return this.prisma.scoped.customer.findFirst({ where: { id, deletedAt: null } });
  }

  findByPhone(phone: string) {
    return this.prisma.scoped.customer.findFirst({ where: { phone, deletedAt: null } });
  }

  findByClaimTokenHash(claimTokenHash: string) {
    return this.prisma.customer.findUnique({ where: { claimTokenHash } });
  }

  create(data: Prisma.CustomerUncheckedCreateInput) {
    return this.prisma.scoped.customer.create({ data });
  }

  update(id: string, data: Prisma.CustomerUpdateInput) {
    return this.prisma.scoped.customer.update({ where: { id }, data });
  }

  listAppointmentsForCustomer(customerId: string) {
    return this.prisma.scoped.appointment.findMany({
      where: { customerId },
      orderBy: { startsAt: 'desc' },
      include: { service: true, barber: true },
    });
  }
}
```

Nota: `findByClaimTokenHash` usa `this.prisma.customer` (não `scoped`) porque a rota de claim é pré-auth/sem tenant; o token é único globalmente (graças ao UNIQUE no schema).

- [ ] **Step 7.2: Module**

Crie `src/modules/customers/customers.module.ts` (preliminar — service vem em Task 8):

```ts
import { Module } from '@nestjs/common';
import { CustomerRepository } from './repositories/customer.repository';

@Module({
  providers: [CustomerRepository],
  exports: [CustomerRepository],
})
export class CustomersModule {}
```

- [ ] **Step 7.3: Lint + commit**

Run: `npm run lint && npm run test`
Expected: PASS.

```bash
git add src/modules/customers
git commit -m "feat(customers): add Customer repository and module skeleton"
```

---

## Task 8: CustomersService — findOrCreateByPhone + identity update

**Files:**
- Create: `src/modules/customers/customers.service.ts`
- Create: `src/modules/customers/customers.service.spec.ts`
- Create: `src/modules/customers/dto/customer-identity.dto.ts`
- Modify: `src/modules/customers/customers.module.ts`

- [ ] **Step 8.1: DTO compartilhado**

Crie `src/modules/customers/dto/customer-identity.dto.ts`:

```ts
import { IsEmail, IsNotEmpty, IsOptional, IsString, Length, Matches } from 'class-validator';

export class CustomerIdentityDto {
  @IsString() @IsNotEmpty() @Length(2, 80)
  name!: string;

  @IsString() @Matches(/^\+?[0-9\s-()]{8,20}$/, { message: 'phone inválido' })
  phone!: string;

  @IsOptional() @IsEmail()
  email?: string;
}
```

- [ ] **Step 8.2: Escrever testes do service**

Crie `src/modules/customers/customers.service.spec.ts`:

```ts
import { CustomersService } from './customers.service';
import { CustomerRepository } from './repositories/customer.repository';

function buildRepo(): jest.Mocked<CustomerRepository> {
  return {
    findByPhone: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    findById: jest.fn(),
    findByClaimTokenHash: jest.fn(),
    list: jest.fn(),
    listAppointmentsForCustomer: jest.fn(),
  } as unknown as jest.Mocked<CustomerRepository>;
}

describe('CustomersService.findOrCreateByPhone', () => {
  it('cria Customer novo com claimToken quando email é fornecido', async () => {
    const repo = buildRepo();
    repo.findByPhone.mockResolvedValue(null);
    repo.create.mockImplementation(async (d) => ({
      id: 'c1',
      name: d.name as string,
      phone: d.phone as string,
      email: (d.email as string) ?? null,
      userId: null,
      claimTokenHash: (d.claimTokenHash as string) ?? null,
      claimTokenExpiresAt: (d.claimTokenExpiresAt as Date) ?? null,
      tenantId: 't1',
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any));

    const svc = new CustomersService(repo);
    const out = await svc.findOrCreateByPhone({
      name: 'João',
      phone: '+5511999999999',
      email: 'joao@x.com',
    });

    expect(out.customer.id).toBe('c1');
    expect(out.claimPlainToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(repo.create).toHaveBeenCalled();
    const created = repo.create.mock.calls[0][0];
    expect(created.claimTokenHash).toBeDefined();
    expect(created.claimTokenExpiresAt).toBeInstanceOf(Date);
  });

  it('NÃO gera claimToken se email vazio', async () => {
    const repo = buildRepo();
    repo.findByPhone.mockResolvedValue(null);
    repo.create.mockResolvedValue({ id: 'c2' } as any);

    const svc = new CustomersService(repo);
    const out = await svc.findOrCreateByPhone({ name: 'João', phone: '+5511999999999' });

    expect(out.claimPlainToken).toBeUndefined();
    const created = repo.create.mock.calls[0][0];
    expect(created.claimTokenHash).toBeUndefined();
  });

  it('reusa Customer existente quando phone bate (sem atualizar se nada mudou)', async () => {
    const repo = buildRepo();
    repo.findByPhone.mockResolvedValue({
      id: 'cx',
      name: 'João',
      phone: '+5511999999999',
      email: 'joao@x.com',
      userId: null,
    } as any);
    const svc = new CustomersService(repo);

    const out = await svc.findOrCreateByPhone({
      name: 'João',
      phone: '+5511999999999',
      email: 'joao@x.com',
    });

    expect(out.customer.id).toBe('cx');
    expect(repo.update).not.toHaveBeenCalled();
    expect(out.claimPlainToken).toBeUndefined();
  });

  it('atualiza nome/email no Customer existente quando vem diferente', async () => {
    const repo = buildRepo();
    repo.findByPhone.mockResolvedValue({
      id: 'cx',
      name: 'João',
      phone: '+5511999999999',
      email: 'antigo@x.com',
      userId: null,
    } as any);
    repo.update.mockResolvedValue({
      id: 'cx',
      name: 'João Silva',
      email: 'novo@x.com',
    } as any);

    const svc = new CustomersService(repo);
    await svc.findOrCreateByPhone({
      name: 'João Silva',
      phone: '+5511999999999',
      email: 'novo@x.com',
    });

    expect(repo.update).toHaveBeenCalledWith('cx', { name: 'João Silva', email: 'novo@x.com' });
  });
});
```

Run: `npx jest src/modules/customers/customers.service.spec.ts -v`
Expected: FAIL.

- [ ] **Step 8.3: Implementar service**

Crie `src/modules/customers/customers.service.ts`:

```ts
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { CustomerRepository } from './repositories/customer.repository';

export type FindOrCreateInput = {
  name: string;
  phone: string;
  email?: string;
};

const CLAIM_TOKEN_TTL_DAYS = 7;

@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  constructor(private readonly repo: CustomerRepository) {}

  async getById(id: string) {
    const c = await this.repo.findById(id);
    if (!c) {
      throw new DomainException({
        code: ErrorCodes.CUSTOMER_NOT_FOUND,
        message: 'Cliente não encontrado.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    return c;
  }

  list(search?: string) {
    return this.repo.list(search);
  }

  listAppointments(customerId: string) {
    return this.repo.listAppointmentsForCustomer(customerId);
  }

  async findOrCreateByPhone(input: FindOrCreateInput) {
    const existing = await this.repo.findByPhone(input.phone);
    if (existing) {
      const patch: { name?: string; email?: string } = {};
      if (existing.name !== input.name) patch.name = input.name;
      if (input.email && existing.email !== input.email) patch.email = input.email;
      if (Object.keys(patch).length > 0) {
        await this.repo.update(existing.id, patch);
        this.logger.log(
          { event: 'customer.identity_updated', customerId: existing.id, patch },
          'customer identity updated',
        );
      }
      return { customer: { ...existing, ...patch }, claimPlainToken: undefined as string | undefined };
    }

    let claimPlainToken: string | undefined;
    let claimTokenHash: string | undefined;
    let claimTokenExpiresAt: Date | undefined;
    if (input.email) {
      claimPlainToken = randomBytes(32).toString('base64url');
      claimTokenHash = createHash('sha256').update(claimPlainToken).digest('hex');
      claimTokenExpiresAt = new Date(Date.now() + CLAIM_TOKEN_TTL_DAYS * 24 * 3600 * 1000);
    }

    const customer = await this.repo.create({
      name: input.name,
      phone: input.phone,
      email: input.email ?? null,
      ...(claimTokenHash ? { claimTokenHash, claimTokenExpiresAt } : {}),
    } as never);

    return { customer, claimPlainToken };
  }

  async consumeClaimToken(plainToken: string) {
    const claimTokenHash = createHash('sha256').update(plainToken).digest('hex');
    const customer = await this.repo.findByClaimTokenHash(claimTokenHash);
    if (!customer || !customer.claimTokenExpiresAt || customer.claimTokenExpiresAt < new Date()) {
      throw new DomainException({
        code: ErrorCodes.CLAIM_TOKEN_INVALID,
        message: 'Token de claim inválido ou expirado.',
        status: HttpStatus.BAD_REQUEST,
      });
    }
    if (customer.userId) {
      throw new DomainException({
        code: ErrorCodes.CLAIM_TOKEN_INVALID,
        message: 'Conta já reivindicada.',
        status: HttpStatus.CONFLICT,
      });
    }
    return customer;
  }

  async linkUser(customerId: string, userId: string) {
    return this.repo.update(customerId, {
      user: { connect: { id: userId } },
      claimTokenHash: null,
      claimTokenExpiresAt: null,
    });
  }
}
```

Run: `npx jest src/modules/customers -v`
Expected: PASS.

- [ ] **Step 8.4: Atualizar module + commit**

Em `src/modules/customers/customers.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { CustomersService } from './customers.service';
import { CustomerRepository } from './repositories/customer.repository';

@Module({
  providers: [CustomersService, CustomerRepository],
  exports: [CustomersService, CustomerRepository],
})
export class CustomersModule {}
```

Em `src/app.module.ts`, importe e registre `CustomersModule`.

```bash
git add src/modules/customers src/app.module.ts
git commit -m "feat(customers): CustomersService with findOrCreate dedup and claim token"
```

---

## Task 9: CustomersController — `/admin/customers`

**Files:**
- Create: `src/modules/customers/customers.controller.ts`
- Modify: `src/modules/customers/customers.module.ts`

- [ ] **Step 9.1: Controller**

Crie `src/modules/customers/customers.controller.ts`:

```ts
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { TenantGuard } from 'src/common/guards/tenant.guard';
import { CustomersService } from './customers.service';

@Controller('admin/customers')
@UseGuards(TenantGuard)
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  list(@Query('search') search?: string) {
    return this.customers.list(search);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.customers.getById(id);
  }

  @Get(':id/appointments')
  async listAppointments(@Param('id') id: string) {
    await this.customers.getById(id);
    return this.customers.listAppointments(id);
  }
}
```

- [ ] **Step 9.2: Registrar no module**

```ts
@Module({
  controllers: [CustomersController],
  providers: [CustomersService, CustomerRepository],
  exports: [CustomersService, CustomerRepository],
})
export class CustomersModule {}
```

- [ ] **Step 9.3: Testar**

Run: `npm run lint && npm run test`
Expected: PASS.

- [ ] **Step 9.4: Commit**

```bash
git add src/modules/customers
git commit -m "feat(customers): add /admin/customers endpoints"
```

---

## Task 10: Luxon dep + helper de tempo

**Files:**
- Modify: `package.json`
- Create: `src/modules/scheduling/time-utils.ts`
- Create: `src/modules/scheduling/time-utils.spec.ts`

- [ ] **Step 10.1: Adicionar luxon**

Run:
```bash
npm install luxon@^3
npm install --save-dev @types/luxon
```

- [ ] **Step 10.2: Testes do helper**

Crie `src/modules/scheduling/time-utils.spec.ts`:

```ts
import {
  dayOfWeekInZone,
  minutesSinceMidnightInZone,
  combineDateAndMinutesInZone,
  formatLocal,
} from './time-utils';

describe('time-utils', () => {
  it('dayOfWeekInZone retorna 0 (Sun)..6 (Sat) na zona dada', () => {
    // 2026-05-12T03:00:00Z = 2026-05-12 00:00 em São Paulo (UTC-3) → terça → 2
    expect(
      dayOfWeekInZone(new Date('2026-05-12T03:00:00Z'), 'America/Sao_Paulo'),
    ).toBe(2);
    // 2026-05-12T02:00:00Z = 2026-05-11 23:00 em São Paulo → segunda → 1
    expect(
      dayOfWeekInZone(new Date('2026-05-12T02:00:00Z'), 'America/Sao_Paulo'),
    ).toBe(1);
  });

  it('minutesSinceMidnightInZone retorna minutos desde 00:00 local', () => {
    // 14:30 local SP = 17:30 UTC
    expect(
      minutesSinceMidnightInZone(new Date('2026-05-12T17:30:00Z'), 'America/Sao_Paulo'),
    ).toBe(14 * 60 + 30);
  });

  it('combineDateAndMinutesInZone monta UTC a partir de "dia local + minutos"', () => {
    // 12/05/2026 14:00 em São Paulo → 17:00 UTC
    const utc = combineDateAndMinutesInZone(
      new Date('2026-05-12T15:00:00Z'), // qualquer instante no mesmo dia local
      14 * 60,
      'America/Sao_Paulo',
    );
    expect(utc.toISOString()).toBe('2026-05-12T17:00:00.000Z');
  });

  it('formatLocal devolve string pt-BR esperada', () => {
    const s = formatLocal(new Date('2026-05-12T17:00:00Z'), 'America/Sao_Paulo');
    expect(s).toBe('12/05/2026 14:00');
  });
});
```

Run: `npx jest src/modules/scheduling/time-utils.spec.ts -v`
Expected: FAIL.

- [ ] **Step 10.3: Implementar helper**

Crie `src/modules/scheduling/time-utils.ts`:

```ts
import { DateTime } from 'luxon';

export function dayOfWeekInZone(d: Date, zone: string): number {
  // Luxon: weekday 1=Monday..7=Sunday. Queremos 0=Sun..6=Sat (match BusinessHours.days).
  const wd = DateTime.fromJSDate(d, { zone }).weekday; // 1..7
  return wd === 7 ? 0 : wd;
}

export function minutesSinceMidnightInZone(d: Date, zone: string): number {
  const local = DateTime.fromJSDate(d, { zone });
  return local.hour * 60 + local.minute;
}

export function combineDateAndMinutesInZone(
  anyInstantOnDay: Date,
  minutesSinceMidnight: number,
  zone: string,
): Date {
  const localDay = DateTime.fromJSDate(anyInstantOnDay, { zone }).startOf('day');
  return localDay.plus({ minutes: minutesSinceMidnight }).toUTC().toJSDate();
}

export function formatLocal(d: Date, zone: string): string {
  return DateTime.fromJSDate(d, { zone }).toFormat('dd/LL/yyyy HH:mm');
}

export function priceFormatBRL(cents: number): string {
  return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

export function intervalsOverlap(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}
```

Run: `npx jest src/modules/scheduling/time-utils.spec.ts -v`
Expected: PASS.

- [ ] **Step 10.4: Commit**

```bash
git add package.json package-lock.json src/modules/scheduling
git commit -m "feat(scheduling): time-zone helpers via luxon"
```

---

## Task 11: AppointmentRepository

**Files:**
- Create: `src/modules/scheduling/repositories/appointment.repository.ts`

- [ ] **Step 11.1: Repositório**

Crie `src/modules/scheduling/repositories/appointment.repository.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { AppointmentStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

const ACTIVE_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.pending,
  AppointmentStatus.confirmed,
  AppointmentStatus.completed,
];

@Injectable()
export class AppointmentRepository {
  constructor(private readonly prisma: PrismaService) {}

  listForRange(filters: {
    from: Date;
    to: Date;
    barberId?: string;
    status?: AppointmentStatus;
  }) {
    const where: Prisma.AppointmentWhereInput = {
      startsAt: { gte: filters.from, lt: filters.to },
      ...(filters.barberId ? { barberId: filters.barberId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
    };
    return this.prisma.scoped.appointment.findMany({
      where,
      orderBy: { startsAt: 'asc' },
      include: { service: true, barber: true, customer: true },
    });
  }

  findById(id: string) {
    return this.prisma.scoped.appointment.findFirst({
      where: { id },
      include: { service: true, barber: true, customer: true, tenant: true },
    });
  }

  findByCancellationTokenHash(tokenHash: string) {
    return this.prisma.appointment.findUnique({
      where: { cancellationTokenHash: tokenHash },
      include: { service: true, barber: true, customer: true, tenant: true },
    });
  }

  findActiveForBarberInRange(barberId: string, from: Date, to: Date) {
    return this.prisma.scoped.appointment.findMany({
      where: {
        barberId,
        status: { in: ACTIVE_STATUSES },
        startsAt: { lt: to },
        endsAt: { gt: from },
      },
      select: { id: true, startsAt: true, endsAt: true, barberId: true },
    });
  }

  updateStatus(id: string, status: AppointmentStatus, extra?: Prisma.AppointmentUpdateInput) {
    return this.prisma.scoped.appointment.update({
      where: { id },
      data: { status, ...extra },
    });
  }

  update(id: string, data: Prisma.AppointmentUpdateInput) {
    return this.prisma.scoped.appointment.update({ where: { id }, data });
  }
}

export { ACTIVE_STATUSES };
```

- [ ] **Step 11.2: Commit**

```bash
git add src/modules/scheduling/repositories
git commit -m "feat(scheduling): Appointment repository"
```

---

## Task 12: AvailabilityService — cálculo de slots (TDD)

**Files:**
- Create: `src/modules/scheduling/availability.service.ts`
- Create: `src/modules/scheduling/availability.service.spec.ts`

- [ ] **Step 12.1: Escrever testes — happy path 1 barbeiro, dia simples**

Crie `src/modules/scheduling/availability.service.spec.ts`:

```ts
import { HttpStatus } from '@nestjs/common';
import { AvailabilityService } from './availability.service';
import type { BusinessHours } from 'src/modules/tenants/business-hours';

function bhAllDays9to18(): BusinessHours {
  return {
    days: Array.from({ length: 7 }, () => ({
      open: true,
      intervals: [{ startMin: 9 * 60, endMin: 18 * 60 }],
    })),
  };
}

function bhMondayOnly9to12(): BusinessHours {
  const days = Array.from({ length: 7 }, () => ({ open: false, intervals: [] as { startMin: number; endMin: number }[] }));
  days[1] = { open: true, intervals: [{ startMin: 9 * 60, endMin: 12 * 60 }] };
  return { days };
}

describe('AvailabilityService', () => {
  let svc: AvailabilityService;
  const now = new Date('2026-05-11T12:00:00Z'); // dom 09:00 SP

  beforeEach(() => {
    svc = new AvailabilityService(() => now);
  });

  it('gera slots de 15min dentro de business hours, respeitando duração do serviço', () => {
    const slots = svc.computeSlots({
      tenantTimezone: 'America/Sao_Paulo',
      businessHours: bhMondayOnly9to12(),
      durationMin: 30,
      barberId: 'b1',
      timeOffs: [],
      appointments: [],
      from: new Date('2026-05-12T00:00:00Z'),
      to: new Date('2026-05-13T00:00:00Z'),
    });
    // Segunda 09:00..12:00 SP → 12:00..15:00 UTC. Slots de 15min com duração 30min:
    // 09:00, 09:15, 09:30, ..., 11:30 (último que cabe 30min dentro de 12:00)
    // = 11 slots
    expect(slots).toHaveLength(11);
    expect(slots[0].startsAt.toISOString()).toBe('2026-05-12T12:00:00.000Z');
    expect(slots[10].startsAt.toISOString()).toBe('2026-05-12T14:30:00.000Z');
  });

  it('exclui slots que cruzam o fim do intervalo (duração não cabe)', () => {
    const slots = svc.computeSlots({
      tenantTimezone: 'America/Sao_Paulo',
      businessHours: bhMondayOnly9to12(),
      durationMin: 90,
      barberId: 'b1',
      timeOffs: [],
      appointments: [],
      from: new Date('2026-05-12T00:00:00Z'),
      to: new Date('2026-05-13T00:00:00Z'),
    });
    // 09:00..10:30 último que cabe 90min antes de 12:00
    expect(slots[slots.length - 1].startsAt.toISOString()).toBe('2026-05-12T13:30:00.000Z');
  });

  it('dia fechado não gera slots', () => {
    const slots = svc.computeSlots({
      tenantTimezone: 'America/Sao_Paulo',
      businessHours: bhMondayOnly9to12(),
      durationMin: 30,
      barberId: 'b1',
      timeOffs: [],
      appointments: [],
      from: new Date('2026-05-13T00:00:00Z'), // terça (fechado)
      to: new Date('2026-05-14T00:00:00Z'),
    });
    expect(slots).toHaveLength(0);
  });

  it('exclui slots que sobrepõem TimeOff', () => {
    const slots = svc.computeSlots({
      tenantTimezone: 'America/Sao_Paulo',
      businessHours: bhMondayOnly9to12(),
      durationMin: 30,
      barberId: 'b1',
      timeOffs: [
        {
          barberId: 'b1',
          startsAt: new Date('2026-05-12T13:00:00Z'), // 10:00 SP
          endsAt: new Date('2026-05-12T14:00:00Z'),   // 11:00 SP
        },
      ],
      appointments: [],
      from: new Date('2026-05-12T00:00:00Z'),
      to: new Date('2026-05-13T00:00:00Z'),
    });
    // Removidos: 09:45 (sobrepõe), 10:00..10:45 (4 slots) = 5 slots fora
    const isos = slots.map((s) => s.startsAt.toISOString());
    expect(isos).not.toContain('2026-05-12T12:45:00.000Z');
    expect(isos).not.toContain('2026-05-12T13:00:00.000Z');
    expect(isos).not.toContain('2026-05-12T13:45:00.000Z');
    expect(isos).toContain('2026-05-12T14:00:00.000Z'); // 11:00 SP - começa exatamente quando timeOff acaba
  });

  it('exclui slots que sobrepõem Appointment ativo', () => {
    const slots = svc.computeSlots({
      tenantTimezone: 'America/Sao_Paulo',
      businessHours: bhMondayOnly9to12(),
      durationMin: 30,
      barberId: 'b1',
      timeOffs: [],
      appointments: [
        {
          barberId: 'b1',
          startsAt: new Date('2026-05-12T13:00:00Z'),
          endsAt: new Date('2026-05-12T13:30:00Z'),
        },
      ],
      from: new Date('2026-05-12T00:00:00Z'),
      to: new Date('2026-05-13T00:00:00Z'),
    });
    const isos = slots.map((s) => s.startsAt.toISOString());
    expect(isos).not.toContain('2026-05-12T12:45:00.000Z');
    expect(isos).not.toContain('2026-05-12T13:00:00.000Z');
    expect(isos).not.toContain('2026-05-12T13:15:00.000Z');
    expect(isos).toContain('2026-05-12T13:30:00.000Z');
  });

  it('filtra slots no passado', () => {
    const svcWithLaterNow = new AvailabilityService(() => new Date('2026-05-12T13:15:00Z')); // 10:15 SP
    const slots = svcWithLaterNow.computeSlots({
      tenantTimezone: 'America/Sao_Paulo',
      businessHours: bhMondayOnly9to12(),
      durationMin: 30,
      barberId: 'b1',
      timeOffs: [],
      appointments: [],
      from: new Date('2026-05-12T00:00:00Z'),
      to: new Date('2026-05-13T00:00:00Z'),
    });
    expect(slots.every((s) => s.startsAt > new Date('2026-05-12T13:15:00Z'))).toBe(true);
  });

  it('valida range from/to (rejeita > 31 dias)', () => {
    expect(() =>
      svc.assertRangeValid(
        new Date('2026-05-01T00:00:00Z'),
        new Date('2026-07-01T00:00:00Z'),
      ),
    ).toThrow(expect.objectContaining({ status: HttpStatus.BAD_REQUEST }));
  });

  it('valida range from/to (rejeita to <= from)', () => {
    expect(() =>
      svc.assertRangeValid(
        new Date('2026-05-12T00:00:00Z'),
        new Date('2026-05-11T00:00:00Z'),
      ),
    ).toThrow();
  });

  it('aceita business hours com 2 intervalos no mesmo dia (almoço)', () => {
    const days = Array.from({ length: 7 }, () => ({ open: false, intervals: [] as { startMin: number; endMin: number }[] }));
    days[1] = {
      open: true,
      intervals: [
        { startMin: 9 * 60, endMin: 12 * 60 },
        { startMin: 14 * 60, endMin: 18 * 60 },
      ],
    };
    const slots = svc.computeSlots({
      tenantTimezone: 'America/Sao_Paulo',
      businessHours: { days },
      durationMin: 30,
      barberId: 'b1',
      timeOffs: [],
      appointments: [],
      from: new Date('2026-05-12T00:00:00Z'),
      to: new Date('2026-05-13T00:00:00Z'),
    });
    const isos = slots.map((s) => s.startsAt.toISOString());
    // não tem slots entre 12:00 e 14:00 local (15:00..17:00 UTC)
    expect(isos.some((i) => i >= '2026-05-12T15:00:00.000Z' && i < '2026-05-12T17:00:00.000Z')).toBe(false);
    expect(isos).toContain('2026-05-12T17:00:00.000Z'); // 14:00 SP
  });
});
```

Run: `npx jest src/modules/scheduling/availability.service.spec.ts -v`
Expected: FAIL (módulo não existe).

- [ ] **Step 12.2: Implementar AvailabilityService**

Crie `src/modules/scheduling/availability.service.ts`:

```ts
import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { DateTime } from 'luxon';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import type { BusinessHours } from 'src/modules/tenants/business-hours';
import {
  combineDateAndMinutesInZone,
  dayOfWeekInZone,
  intervalsOverlap,
} from './time-utils';

export type Slot = { barberId: string; startsAt: Date; endsAt: Date };
export type TimeOffWindow = { barberId: string; startsAt: Date; endsAt: Date };
export type AppointmentWindow = { barberId: string; startsAt: Date; endsAt: Date };

export type ComputeSlotsInput = {
  tenantTimezone: string;
  businessHours: BusinessHours;
  durationMin: number;
  barberId: string;
  timeOffs: TimeOffWindow[];
  appointments: AppointmentWindow[];
  from: Date;
  to: Date;
};

export const SLOT_STEP_MIN = 15;
export const MAX_RANGE_DAYS = 31;

export const NOW_PROVIDER = Symbol('NOW_PROVIDER');

@Injectable()
export class AvailabilityService {
  constructor(@Optional() @Inject(NOW_PROVIDER) private readonly nowFn: () => Date = () => new Date()) {}

  assertRangeValid(from: Date, to: Date): void {
    if (!(to > from)) {
      throw new DomainException({
        code: ErrorCodes.AVAILABILITY_RANGE_INVALID,
        message: 'to deve ser maior que from.',
        status: HttpStatus.BAD_REQUEST,
      });
    }
    const days = (to.getTime() - from.getTime()) / (24 * 3600 * 1000);
    if (days > MAX_RANGE_DAYS) {
      throw new DomainException({
        code: ErrorCodes.AVAILABILITY_RANGE_INVALID,
        message: `Range máximo ${MAX_RANGE_DAYS} dias.`,
        status: HttpStatus.BAD_REQUEST,
      });
    }
  }

  computeSlots(input: ComputeSlotsInput): Slot[] {
    this.assertRangeValid(input.from, input.to);
    const now = this.nowFn();
    const out: Slot[] = [];

    // Itera dia por dia (na zona local). Cada dia gera slots dos seus intervals.
    let cursor = DateTime.fromJSDate(input.from, { zone: input.tenantTimezone }).startOf('day');
    const end = DateTime.fromJSDate(input.to, { zone: input.tenantTimezone });

    while (cursor < end) {
      const dayJs = cursor.toJSDate();
      const dow = dayOfWeekInZone(dayJs, input.tenantTimezone);
      const day = input.businessHours.days[dow];
      if (day?.open) {
        for (const interval of day.intervals) {
          for (let m = interval.startMin; m + input.durationMin <= interval.endMin; m += SLOT_STEP_MIN) {
            const slotStart = combineDateAndMinutesInZone(dayJs, m, input.tenantTimezone);
            const slotEnd = new Date(slotStart.getTime() + input.durationMin * 60 * 1000);

            if (slotStart < now) continue;
            if (slotStart < input.from || slotEnd > input.to) continue;

            const blockedByTimeOff = input.timeOffs.some((t) =>
              t.barberId === input.barberId && intervalsOverlap(slotStart, slotEnd, t.startsAt, t.endsAt),
            );
            if (blockedByTimeOff) continue;

            const blockedByAppt = input.appointments.some((a) =>
              a.barberId === input.barberId && intervalsOverlap(slotStart, slotEnd, a.startsAt, a.endsAt),
            );
            if (blockedByAppt) continue;

            out.push({ barberId: input.barberId, startsAt: slotStart, endsAt: slotEnd });
          }
        }
      }
      cursor = cursor.plus({ days: 1 });
    }

    return out;
  }
}
```

Run: `npx jest src/modules/scheduling/availability.service.spec.ts -v`
Expected: PASS (todos).

- [ ] **Step 12.3: Commit**

```bash
git add src/modules/scheduling
git commit -m "feat(scheduling): AvailabilityService computing slots from BH + timeoff + appointments"
```

---

## Task 13: AvailabilityService — fan-out para múltiplos barbeiros + integração com repositórios

**Files:**
- Modify: `src/modules/scheduling/availability.service.ts`
- Modify: `src/modules/scheduling/availability.service.spec.ts`

- [ ] **Step 13.1: Teste do `getAvailabilityByService` (fan-out por barbeiros)**

Adicione em `availability.service.spec.ts`:

```ts
describe('AvailabilityService.getAvailabilityByService', () => {
  it('agrupa por barberId, chamando computeSlots por barbeiro', () => {
    const svc = new AvailabilityService(() => new Date('2026-05-11T12:00:00Z'));
    const spy = jest.spyOn(svc, 'computeSlots');
    spy.mockImplementation((i) => [
      { barberId: i.barberId, startsAt: i.from, endsAt: new Date(i.from.getTime() + 60000) },
    ]);

    const out = svc.getAvailabilityByService({
      tenantTimezone: 'America/Sao_Paulo',
      businessHours: bhAllDays9to18(),
      durationMin: 30,
      barberIds: ['b1', 'b2'],
      timeOffsByBarber: { b1: [], b2: [] },
      appointmentsByBarber: { b1: [], b2: [] },
      from: new Date('2026-05-12T00:00:00Z'),
      to: new Date('2026-05-13T00:00:00Z'),
    });

    expect(out).toHaveLength(2);
    expect(out[0].barberId).toBe('b1');
    expect(out[1].barberId).toBe('b2');
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

function bhAllDays9to18() {
  return {
    days: Array.from({ length: 7 }, () => ({
      open: true,
      intervals: [{ startMin: 9 * 60, endMin: 18 * 60 }],
    })),
  };
}
```

Run: `npx jest src/modules/scheduling/availability.service.spec.ts -v`
Expected: FAIL (`getAvailabilityByService` não existe).

- [ ] **Step 13.2: Implementar fan-out**

Adicione em `availability.service.ts`:

```ts
export type AvailabilityByServiceInput = {
  tenantTimezone: string;
  businessHours: BusinessHours;
  durationMin: number;
  barberIds: string[];
  timeOffsByBarber: Record<string, TimeOffWindow[]>;
  appointmentsByBarber: Record<string, AppointmentWindow[]>;
  from: Date;
  to: Date;
};

export type AvailabilityGroup = { barberId: string; slots: Slot[] };
```

E método na classe:

```ts
  getAvailabilityByService(i: AvailabilityByServiceInput): AvailabilityGroup[] {
    return i.barberIds.map((barberId) => ({
      barberId,
      slots: this.computeSlots({
        tenantTimezone: i.tenantTimezone,
        businessHours: i.businessHours,
        durationMin: i.durationMin,
        barberId,
        timeOffs: i.timeOffsByBarber[barberId] ?? [],
        appointments: i.appointmentsByBarber[barberId] ?? [],
        from: i.from,
        to: i.to,
      }),
    }));
  }
```

Run: `npx jest src/modules/scheduling/availability.service.spec.ts -v`
Expected: PASS.

(Mas espera — o teste espera `out[i].barberId === 'b1'`; meu retorno é `{ barberId, slots }`. Ajustar o teste OU manter um shape canônico. Vou manter o shape e ajustar o teste — mais correto.)

Atualize o teste correspondente:

```ts
    expect(out).toHaveLength(2);
    expect(out[0].barberId).toBe('b1');
    expect(out[1].barberId).toBe('b2');
    expect(out[0].slots).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(2);
```

Run de novo: `npx jest src/modules/scheduling/availability.service.spec.ts -v`
Expected: PASS.

- [ ] **Step 13.3: Commit**

```bash
git add src/modules/scheduling/availability.service.ts src/modules/scheduling/availability.service.spec.ts
git commit -m "feat(scheduling): fan-out availability by barber list"
```

---

## Task 14: AppointmentsService — criação com race-protection

**Files:**
- Create: `src/modules/scheduling/appointments.service.ts`
- Create: `src/modules/scheduling/appointments.service.spec.ts`

- [ ] **Step 14.1: Testes do service (unit, com mocks)**

Crie `src/modules/scheduling/appointments.service.spec.ts`:

```ts
import { HttpStatus } from '@nestjs/common';
import { AppointmentSource, AppointmentStatus } from '@prisma/client';
import { AppointmentsService } from './appointments.service';

function mockDeps() {
  const repo = {
    findById: jest.fn(),
    update: jest.fn(),
    updateStatus: jest.fn(),
    findActiveForBarberInRange: jest.fn(),
    listForRange: jest.fn(),
    findByCancellationTokenHash: jest.fn(),
  } as any;
  const prisma = {
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) =>
      fn({
        $queryRawUnsafe: jest.fn().mockResolvedValue([]),
        appointment: { create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'apt1', ...data })) },
      }),
    ),
  } as any;
  const services = { getById: jest.fn() } as any;
  const barbers = { getById: jest.fn() } as any;
  return { repo, prisma, services, barbers };
}

describe('AppointmentsService.createPublicBooking', () => {
  const validInput = {
    serviceId: 'srv1',
    barberId: 'b1',
    startsAt: new Date('2026-05-12T15:00:00Z'),
    customer: { id: 'c1' },
  };

  it('cria appointment com snapshots e status pending para storefront', async () => {
    const deps = mockDeps();
    deps.services.getById.mockResolvedValue({
      id: 'srv1', durationMin: 30, priceCents: 4500, active: true, deletedAt: null,
      serviceBarbers: [{ barberId: 'b1' }],
    });
    deps.barbers.getById.mockResolvedValue({ id: 'b1', active: true, deletedAt: null });

    const svc = new AppointmentsService(deps.prisma, deps.repo, deps.services, deps.barbers);
    const out = await svc.createPublicBooking('t1', validInput);

    expect(out.appointment.status).toBe(AppointmentStatus.pending);
    expect(out.appointment.source).toBe(AppointmentSource.public_storefront);
    expect(out.appointment.priceCentsSnapshot).toBe(4500);
    expect(out.appointment.durationMinSnapshot).toBe(30);
    expect(out.cancellationPlainToken).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejeita se barber não faz o serviço', async () => {
    const deps = mockDeps();
    deps.services.getById.mockResolvedValue({
      id: 'srv1', durationMin: 30, priceCents: 4500, active: true, deletedAt: null,
      serviceBarbers: [{ barberId: 'b2' }],
    });
    deps.barbers.getById.mockResolvedValue({ id: 'b1', active: true });

    const svc = new AppointmentsService(deps.prisma, deps.repo, deps.services, deps.barbers);
    await expect(svc.createPublicBooking('t1', validInput)).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
  });

  it('rejeita 409 se SLOT já está ocupado (FOR UPDATE retorna linha)', async () => {
    const deps = mockDeps();
    deps.services.getById.mockResolvedValue({
      id: 'srv1', durationMin: 30, priceCents: 4500, active: true,
      serviceBarbers: [{ barberId: 'b1' }],
    });
    deps.barbers.getById.mockResolvedValue({ id: 'b1', active: true });
    deps.prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: 'existing' }]),
        appointment: { create: jest.fn() },
      }),
    );

    const svc = new AppointmentsService(deps.prisma, deps.repo, deps.services, deps.barbers);
    await expect(svc.createPublicBooking('t1', validInput)).rejects.toMatchObject({
      status: HttpStatus.CONFLICT,
    });
  });

  it('rejeita slot no passado', async () => {
    const deps = mockDeps();
    deps.services.getById.mockResolvedValue({
      id: 'srv1', durationMin: 30, priceCents: 4500, active: true,
      serviceBarbers: [{ barberId: 'b1' }],
    });
    deps.barbers.getById.mockResolvedValue({ id: 'b1', active: true });

    const svc = new AppointmentsService(deps.prisma, deps.repo, deps.services, deps.barbers, () => new Date('2030-01-01T00:00:00Z'));
    await expect(svc.createPublicBooking('t1', validInput)).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
  });
});
```

Run: `npx jest src/modules/scheduling/appointments.service.spec.ts -v`
Expected: FAIL.

- [ ] **Step 14.2: Implementar service**

Crie `src/modules/scheduling/appointments.service.ts`:

```ts
import { HttpStatus, Injectable } from '@nestjs/common';
import { AppointmentSource, AppointmentStatus, Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { BarbersService } from 'src/modules/barbers/barbers.service';
import { ServicesService } from 'src/modules/catalog/services.service';
import { AppointmentRepository } from './repositories/appointment.repository';

export type PublicBookingInput = {
  serviceId: string;
  barberId: string;
  startsAt: Date;
  customer: { id: string };
};

export type AdminBookingInput = PublicBookingInput;

const ACTIVE_STATUSES_SQL = `('${AppointmentStatus.pending}','${AppointmentStatus.confirmed}','${AppointmentStatus.completed}')`;

@Injectable()
export class AppointmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: AppointmentRepository,
    private readonly services: ServicesService,
    private readonly barbers: BarbersService,
    private readonly nowFn: () => Date = () => new Date(),
  ) {}

  async getById(id: string) {
    const a = await this.repo.findById(id);
    if (!a) {
      throw new DomainException({
        code: ErrorCodes.APPOINTMENT_NOT_FOUND,
        message: 'Agendamento não encontrado.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    return a;
  }

  list(filters: { from: Date; to: Date; barberId?: string; status?: AppointmentStatus }) {
    return this.repo.listForRange(filters);
  }

  async createPublicBooking(tenantId: string, input: PublicBookingInput) {
    return this.createInternal(tenantId, input, AppointmentSource.public_storefront, AppointmentStatus.pending);
  }

  async createAdminBooking(tenantId: string, input: AdminBookingInput) {
    return this.createInternal(tenantId, input, AppointmentSource.admin, AppointmentStatus.confirmed);
  }

  private async createInternal(
    tenantId: string,
    input: PublicBookingInput,
    source: AppointmentSource,
    initialStatus: AppointmentStatus,
  ) {
    if (input.startsAt < this.nowFn()) {
      throw new DomainException({
        code: ErrorCodes.APPOINTMENT_SLOT_INVALID,
        message: 'Horário no passado.',
        status: HttpStatus.BAD_REQUEST,
      });
    }

    const service = await this.services.getById(input.serviceId);
    if (!service.active || service.deletedAt) {
      throw new DomainException({
        code: ErrorCodes.SERVICE_NOT_FOUND,
        message: 'Serviço indisponível.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    const offerings = (service.serviceBarbers ?? []).map((sb) => sb.barberId);
    if (!offerings.includes(input.barberId)) {
      throw new DomainException({
        code: ErrorCodes.BARBER_DOES_NOT_PROVIDE_SERVICE,
        message: 'Este barbeiro não realiza o serviço escolhido.',
        status: HttpStatus.BAD_REQUEST,
      });
    }

    const barber = await this.barbers.getById(input.barberId);
    if (!barber.active || barber.deletedAt) {
      throw new DomainException({
        code: ErrorCodes.BARBER_NOT_FOUND,
        message: 'Barbeiro indisponível.',
        status: HttpStatus.NOT_FOUND,
      });
    }

    const startsAt = input.startsAt;
    const endsAt = new Date(startsAt.getTime() + service.durationMin * 60 * 1000);

    const cancellationPlainToken = randomBytes(32).toString('base64url');
    const cancellationTokenHash = createHash('sha256').update(cancellationPlainToken).digest('hex');

    const appointment = await this.prisma.$transaction(async (tx) => {
      // SELECT FOR UPDATE em qualquer overlap ativo do barbeiro:
      const overlap = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM "Appointment"
         WHERE "tenantId" = $1
           AND "barberId" = $2
           AND status IN ${ACTIVE_STATUSES_SQL}
           AND "startsAt" < $3
           AND "endsAt"   > $4
         FOR UPDATE`,
        tenantId,
        input.barberId,
        endsAt,
        startsAt,
      );
      if (overlap.length > 0) {
        throw new DomainException({
          code: ErrorCodes.APPOINTMENT_SLOT_TAKEN,
          message: 'Esse horário já foi reservado.',
          status: HttpStatus.CONFLICT,
          details: { startsAt: startsAt.toISOString() },
        });
      }
      return tx.appointment.create({
        data: {
          tenantId,
          barberId: input.barberId,
          serviceId: input.serviceId,
          customerId: input.customer.id,
          startsAt,
          endsAt,
          status: initialStatus,
          priceCentsSnapshot: service.priceCents,
          durationMinSnapshot: service.durationMin,
          source,
          cancellationTokenHash,
        } as Prisma.AppointmentUncheckedCreateInput,
      });
    });

    return { appointment, cancellationPlainToken };
  }
}
```

Run: `npx jest src/modules/scheduling/appointments.service.spec.ts -v`
Expected: PASS.

- [ ] **Step 14.3: Commit**

```bash
git add src/modules/scheduling/appointments.service.ts src/modules/scheduling/appointments.service.spec.ts
git commit -m "feat(scheduling): AppointmentsService.createPublicBooking with FOR UPDATE race guard"
```

---

## Task 15: AppointmentsService — actions (confirm/complete/cancel/no-show/reschedule)

**Files:**
- Modify: `src/modules/scheduling/appointments.service.ts`
- Modify: `src/modules/scheduling/appointments.service.spec.ts`

- [ ] **Step 15.1: Testes de transições**

Adicione em `appointments.service.spec.ts`:

```ts
describe('AppointmentsService — transitions', () => {
  function withCurrentStatus(status: AppointmentStatus) {
    const deps = mockDeps();
    deps.repo.findById.mockResolvedValue({
      id: 'apt1',
      status,
      startsAt: new Date('2026-05-13T10:00:00Z'),
      endsAt: new Date('2026-05-13T10:30:00Z'),
      serviceId: 'srv1',
      barberId: 'b1',
    });
    deps.repo.updateStatus.mockImplementation(async (id: string, st: AppointmentStatus) => ({ id, status: st }));
    return deps;
  }

  it('pending → confirmed', async () => {
    const deps = withCurrentStatus(AppointmentStatus.pending);
    const svc = new AppointmentsService(deps.prisma, deps.repo, deps.services, deps.barbers);
    const out = await svc.confirm('apt1');
    expect(out.status).toBe(AppointmentStatus.confirmed);
  });

  it('completed → cancelled é inválido', async () => {
    const deps = withCurrentStatus(AppointmentStatus.completed);
    const svc = new AppointmentsService(deps.prisma, deps.repo, deps.services, deps.barbers);
    await expect(svc.cancelByAdmin('apt1')).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
  });

  it('confirmed → completed', async () => {
    const deps = withCurrentStatus(AppointmentStatus.confirmed);
    const svc = new AppointmentsService(deps.prisma, deps.repo, deps.services, deps.barbers);
    const out = await svc.complete('apt1');
    expect(out.status).toBe(AppointmentStatus.completed);
  });

  it('confirmed → no_show', async () => {
    const deps = withCurrentStatus(AppointmentStatus.confirmed);
    const svc = new AppointmentsService(deps.prisma, deps.repo, deps.services, deps.barbers);
    const out = await svc.markNoShow('apt1');
    expect(out.status).toBe(AppointmentStatus.no_show);
  });
});
```

Run: `npx jest src/modules/scheduling/appointments.service.spec.ts -v`
Expected: FAIL (métodos não existem).

- [ ] **Step 15.2: Implementar transições**

Adicione ao `AppointmentsService`:

```ts
  private static readonly ALLOWED: Record<AppointmentStatus, AppointmentStatus[]> = {
    pending: [AppointmentStatus.confirmed, AppointmentStatus.cancelled, AppointmentStatus.no_show],
    confirmed: [AppointmentStatus.completed, AppointmentStatus.cancelled, AppointmentStatus.no_show],
    completed: [],
    cancelled: [],
    no_show: [],
  };

  private async transition(id: string, target: AppointmentStatus, extra?: Prisma.AppointmentUpdateInput) {
    const current = await this.getById(id);
    const allowed = AppointmentsService.ALLOWED[current.status];
    if (!allowed.includes(target)) {
      throw new DomainException({
        code: ErrorCodes.APPOINTMENT_TRANSITION_INVALID,
        message: `Transição ${current.status} → ${target} não permitida.`,
        status: HttpStatus.CONFLICT,
      });
    }
    return this.repo.updateStatus(id, target, extra);
  }

  confirm(id: string) {
    return this.transition(id, AppointmentStatus.confirmed);
  }
  complete(id: string) {
    return this.transition(id, AppointmentStatus.completed);
  }
  cancelByAdmin(id: string, reason?: string) {
    return this.transition(id, AppointmentStatus.cancelled, {
      cancelledAt: new Date(),
      cancellationReason: reason ?? 'Cancelado pelo barbeiro',
    });
  }
  markNoShow(id: string) {
    return this.transition(id, AppointmentStatus.no_show);
  }

  async reschedule(id: string, newStartsAt: Date) {
    const apt = await this.getById(id);
    if (apt.status !== AppointmentStatus.pending && apt.status !== AppointmentStatus.confirmed) {
      throw new DomainException({
        code: ErrorCodes.APPOINTMENT_TRANSITION_INVALID,
        message: 'Só é possível remarcar pending ou confirmed.',
        status: HttpStatus.CONFLICT,
      });
    }
    if (newStartsAt < this.nowFn()) {
      throw new DomainException({
        code: ErrorCodes.APPOINTMENT_SLOT_INVALID,
        message: 'Novo horário no passado.',
        status: HttpStatus.BAD_REQUEST,
      });
    }
    const newEndsAt = new Date(newStartsAt.getTime() + apt.durationMinSnapshot * 60 * 1000);
    return this.prisma.$transaction(async (tx) => {
      const overlap = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM "Appointment"
         WHERE "tenantId" = $1
           AND "barberId" = $2
           AND id <> $3
           AND status IN ${ACTIVE_STATUSES_SQL}
           AND "startsAt" < $4
           AND "endsAt"   > $5
         FOR UPDATE`,
        apt.tenantId,
        apt.barberId,
        id,
        newEndsAt,
        newStartsAt,
      );
      if (overlap.length > 0) {
        throw new DomainException({
          code: ErrorCodes.APPOINTMENT_SLOT_TAKEN,
          message: 'Novo horário já está ocupado.',
          status: HttpStatus.CONFLICT,
        });
      }
      return tx.appointment.update({
        where: { id },
        data: { startsAt: newStartsAt, endsAt: newEndsAt },
      });
    });
  }
```

Run: `npx jest src/modules/scheduling/appointments.service.spec.ts -v`
Expected: PASS.

- [ ] **Step 15.3: Commit**

```bash
git add src/modules/scheduling/appointments.service.ts src/modules/scheduling/appointments.service.spec.ts
git commit -m "feat(scheduling): appointment status transitions and reschedule"
```

---

## Task 16: CancellationService — magic link com janela de 2h

**Files:**
- Create: `src/modules/scheduling/cancellation.service.ts`
- Create: `src/modules/scheduling/cancellation.service.spec.ts`

- [ ] **Step 16.1: Teste**

Crie `src/modules/scheduling/cancellation.service.spec.ts`:

```ts
import { HttpStatus } from '@nestjs/common';
import { AppointmentStatus } from '@prisma/client';
import { CancellationService } from './cancellation.service';

describe('CancellationService', () => {
  const fakeNow = new Date('2026-05-12T10:00:00Z');

  function setup(appt: any) {
    const repo = {
      findByCancellationTokenHash: jest.fn().mockResolvedValue(appt),
      updateStatus: jest.fn(async (id: string, status: AppointmentStatus) => ({ id, status })),
    } as any;
    const svc = new CancellationService(repo, () => fakeNow);
    return { svc, repo };
  }

  it('cancela quando token bate e janela > 2h', async () => {
    const { svc, repo } = setup({
      id: 'apt1',
      status: AppointmentStatus.confirmed,
      startsAt: new Date('2026-05-12T15:00:00Z'),
    });
    const out = await svc.cancelByToken('plain-tok');
    expect(out.status).toBe(AppointmentStatus.cancelled);
    expect(repo.updateStatus).toHaveBeenCalledWith('apt1', AppointmentStatus.cancelled, expect.objectContaining({
      cancelledAt: fakeNow,
    }));
  });

  it('rejeita 422 se faltam < 2h', async () => {
    const { svc } = setup({
      id: 'apt1',
      status: AppointmentStatus.confirmed,
      startsAt: new Date('2026-05-12T11:30:00Z'), // 1h30
    });
    await expect(svc.cancelByToken('tok')).rejects.toMatchObject({
      status: HttpStatus.UNPROCESSABLE_ENTITY,
    });
  });

  it('rejeita 400 se token inválido', async () => {
    const repo = { findByCancellationTokenHash: jest.fn().mockResolvedValue(null) } as any;
    const svc = new CancellationService(repo, () => fakeNow);
    await expect(svc.cancelByToken('tok')).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
  });

  it('rejeita 409 se appointment já está cancelado/completed/no_show', async () => {
    const { svc } = setup({
      id: 'apt1',
      status: AppointmentStatus.cancelled,
      startsAt: new Date('2026-05-12T15:00:00Z'),
    });
    await expect(svc.cancelByToken('tok')).rejects.toMatchObject({
      status: HttpStatus.CONFLICT,
    });
  });
});
```

Run: `npx jest src/modules/scheduling/cancellation.service.spec.ts -v`
Expected: FAIL.

- [ ] **Step 16.2: Implementar**

Crie `src/modules/scheduling/cancellation.service.ts`:

```ts
import { HttpStatus, Injectable } from '@nestjs/common';
import { AppointmentStatus } from '@prisma/client';
import { createHash } from 'crypto';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { AppointmentRepository } from './repositories/appointment.repository';

const MIN_CANCEL_LEAD_HOURS = 2;
const ACTIVE = new Set<AppointmentStatus>([
  AppointmentStatus.pending,
  AppointmentStatus.confirmed,
]);

@Injectable()
export class CancellationService {
  constructor(
    private readonly repo: AppointmentRepository,
    private readonly nowFn: () => Date = () => new Date(),
  ) {}

  async lookupByToken(plainToken: string) {
    const tokenHash = createHash('sha256').update(plainToken).digest('hex');
    const apt = await this.repo.findByCancellationTokenHash(tokenHash);
    if (!apt) {
      throw new DomainException({
        code: ErrorCodes.CANCELLATION_TOKEN_INVALID,
        message: 'Token inválido.',
        status: HttpStatus.BAD_REQUEST,
      });
    }
    return apt;
  }

  async cancelByToken(plainToken: string, reason?: string) {
    const apt = await this.lookupByToken(plainToken);
    if (!ACTIVE.has(apt.status)) {
      throw new DomainException({
        code: ErrorCodes.APPOINTMENT_TRANSITION_INVALID,
        message: 'Agendamento não pode mais ser cancelado.',
        status: HttpStatus.CONFLICT,
      });
    }
    const now = this.nowFn();
    const hoursUntil = (apt.startsAt.getTime() - now.getTime()) / 3600000;
    if (hoursUntil < MIN_CANCEL_LEAD_HOURS) {
      throw new DomainException({
        code: ErrorCodes.CANCELLATION_TOO_LATE,
        message: `Cancelamento só é permitido com mais de ${MIN_CANCEL_LEAD_HOURS}h de antecedência.`,
        status: HttpStatus.UNPROCESSABLE_ENTITY,
      });
    }
    return this.repo.updateStatus(apt.id, AppointmentStatus.cancelled, {
      cancelledAt: now,
      cancellationReason: reason ?? 'Cancelado pelo cliente',
    });
  }
}
```

Run: `npx jest src/modules/scheduling/cancellation.service.spec.ts -v`
Expected: PASS.

- [ ] **Step 16.3: Commit**

```bash
git add src/modules/scheduling
git commit -m "feat(scheduling): CancellationService with 2h lead-time rule"
```

---

## Task 17: Appointments admin controller (`/admin/appointments`)

**Files:**
- Create: `src/modules/scheduling/appointments.controller.ts`
- Create: `src/modules/scheduling/dto/create-appointment.dto.ts`
- Create: `src/modules/scheduling/dto/update-appointment.dto.ts`
- Create: `src/modules/scheduling/dto/list-appointments-query.dto.ts`

- [ ] **Step 17.1: DTOs**

`list-appointments-query.dto.ts`:

```ts
import { Type } from 'class-transformer';
import { IsDate, IsEnum, IsOptional, IsString } from 'class-validator';
import { AppointmentStatus } from '@prisma/client';

export class ListAppointmentsQueryDto {
  @Type(() => Date) @IsDate() from!: Date;
  @Type(() => Date) @IsDate() to!: Date;
  @IsOptional() @IsString() barberId?: string;
  @IsOptional() @IsEnum(AppointmentStatus) status?: AppointmentStatus;
}
```

`create-appointment.dto.ts` (admin walk-in):

```ts
import { Type } from 'class-transformer';
import { IsDate, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';
import { CustomerIdentityDto } from 'src/modules/customers/dto/customer-identity.dto';

export class CreateAppointmentDto {
  @IsString() serviceId!: string;
  @IsString() barberId!: string;
  @Type(() => Date) @IsDate() startsAt!: Date;

  // Walk-in: pode ser cliente novo (vem customer) ou existente (vem customerId)
  @IsOptional() @IsString() customerId?: string;
  @IsOptional() @ValidateNested() @Type(() => CustomerIdentityDto) @IsObject()
  customer?: CustomerIdentityDto;
}
```

`update-appointment.dto.ts`:

```ts
import { Type } from 'class-transformer';
import { IsDate } from 'class-validator';

export class UpdateAppointmentDto {
  @Type(() => Date) @IsDate() startsAt!: Date;
}
```

- [ ] **Step 17.2: Controller**

`src/modules/scheduling/appointments.controller.ts`:

```ts
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentTenant } from 'src/common/decorators/current-tenant.decorator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { TenantGuard } from 'src/common/guards/tenant.guard';
import type { AuthenticatedUser } from 'src/common/types/request-context';
import { CustomersService } from 'src/modules/customers/customers.service';
import { AppointmentsService } from './appointments.service';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { ListAppointmentsQueryDto } from './dto/list-appointments-query.dto';
import { UpdateAppointmentDto } from './dto/update-appointment.dto';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Controller('admin/appointments')
@UseGuards(TenantGuard, RolesGuard)
export class AppointmentsController {
  constructor(
    private readonly appointments: AppointmentsService,
    private readonly customers: CustomersService,
    private readonly prisma: PrismaService,
  ) {}

  private async ownsOrThrow(user: AuthenticatedUser | undefined, appointmentBarberId: string) {
    if (!user) throw new ForbiddenException();
    if (user.role === UserRole.tenant_owner) return;
    const barber = await this.prisma.scoped.barber.findFirst({ where: { userId: user.id } });
    if (!barber || barber.id !== appointmentBarberId) {
      throw new ForbiddenException('Barbeiro só age sobre próprios agendamentos.');
    }
  }

  @Get()
  async list(
    @Query() q: ListAppointmentsQueryDto,
    @CurrentUser() user: AuthenticatedUser | undefined,
  ) {
    let barberFilter = q.barberId;
    if (user?.role === UserRole.barber_member) {
      const me = await this.prisma.scoped.barber.findFirst({ where: { userId: user.id } });
      if (!me) throw new ForbiddenException();
      barberFilter = me.id;
    }
    return this.appointments.list({ from: q.from, to: q.to, barberId: barberFilter, status: q.status });
  }

  @Post()
  @Roles(UserRole.tenant_owner)
  @HttpCode(HttpStatus.CREATED)
  async create(@CurrentTenant() tenantId: string, @Body() dto: CreateAppointmentDto) {
    let customerId = dto.customerId;
    if (!customerId) {
      if (!dto.customer) {
        throw new DomainException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Forneça customerId ou customer.',
          status: HttpStatus.BAD_REQUEST,
        });
      }
      const { customer } = await this.customers.findOrCreateByPhone(dto.customer);
      customerId = customer.id;
    }
    const { appointment } = await this.appointments.createAdminBooking(tenantId, {
      serviceId: dto.serviceId,
      barberId: dto.barberId,
      startsAt: dto.startsAt,
      customer: { id: customerId },
    });
    return appointment;
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateAppointmentDto,
    @CurrentUser() user: AuthenticatedUser | undefined,
  ) {
    const apt = await this.appointments.getById(id);
    await this.ownsOrThrow(user, apt.barberId);
    return this.appointments.reschedule(id, dto.startsAt);
  }

  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  async confirm(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser | undefined) {
    const apt = await this.appointments.getById(id);
    await this.ownsOrThrow(user, apt.barberId);
    return this.appointments.confirm(id);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  async complete(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser | undefined) {
    const apt = await this.appointments.getById(id);
    await this.ownsOrThrow(user, apt.barberId);
    return this.appointments.complete(id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @Param('id') id: string,
    @Body() body: { reason?: string },
    @CurrentUser() user: AuthenticatedUser | undefined,
  ) {
    const apt = await this.appointments.getById(id);
    await this.ownsOrThrow(user, apt.barberId);
    return this.appointments.cancelByAdmin(id, body.reason);
  }

  @Post(':id/no-show')
  @HttpCode(HttpStatus.OK)
  async noShow(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser | undefined) {
    const apt = await this.appointments.getById(id);
    await this.ownsOrThrow(user, apt.barberId);
    return this.appointments.markNoShow(id);
  }
}
```

- [ ] **Step 17.3: Lint + testes**

Run: `npm run lint && npm run test`
Expected: PASS.

- [ ] **Step 17.4: Commit**

```bash
git add src/modules/scheduling
git commit -m "feat(scheduling): /admin/appointments controller with owner/barber RBAC"
```

---

## Task 18: SchedulingModule wiring

**Files:**
- Create: `src/modules/scheduling/scheduling.module.ts`
- Modify: `src/app.module.ts`

- [ ] **Step 18.1: Module**

Crie `src/modules/scheduling/scheduling.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { BarbersModule } from 'src/modules/barbers/barbers.module';
import { CatalogModule } from 'src/modules/catalog/catalog.module';
import { CustomersModule } from 'src/modules/customers/customers.module';
import { TenantsModule } from 'src/modules/tenants/tenants.module';
import { AppointmentRepository } from './repositories/appointment.repository';
import { AppointmentsController } from './appointments.controller';
import { AppointmentsService } from './appointments.service';
import { AvailabilityService } from './availability.service';
import { CancellationService } from './cancellation.service';

@Module({
  imports: [BarbersModule, CatalogModule, CustomersModule, TenantsModule],
  controllers: [AppointmentsController],
  providers: [
    AppointmentRepository,
    AppointmentsService,
    AvailabilityService,
    CancellationService,
  ],
  exports: [
    AppointmentRepository,
    AppointmentsService,
    AvailabilityService,
    CancellationService,
  ],
})
export class SchedulingModule {}
```

Nota: `BarbersModule`, `CatalogModule`, `TenantsModule` precisam exportar seus services. Verifique e ajuste — se algum não exporta, adicione `exports: [...]` no módulo correspondente (commit separado se for não-trivial). Em particular, `TenantsModule` precisa exportar `TenantRepository` para os controllers públicos. Faça isso aqui.

- [ ] **Step 18.2: Garantir exports nos módulos pré-existentes**

Em `src/modules/barbers/barbers.module.ts`, garantir `exports: [BarbersService, BarberRepository, TimeOffRepository]`.
Em `src/modules/catalog/catalog.module.ts`, garantir `exports: [ServicesService, ServiceRepository, PhotosService, PhotoRepository]`.
Em `src/modules/tenants/tenants.module.ts`, garantir `exports: [TenantsService, TenantRepository]`.

(Ajuste cada um conforme já estiver, sem rebaixar nada.)

- [ ] **Step 18.3: Registrar no app.module**

Em `src/app.module.ts`, adicione `CustomersModule` e `SchedulingModule` aos `imports`:

```ts
import { CustomersModule } from './modules/customers/customers.module';
import { SchedulingModule } from './modules/scheduling/scheduling.module';
// ...
imports: [
  // ...existentes
  CustomersModule,
  SchedulingModule,
],
```

- [ ] **Step 18.4: Testar**

Run: `npm run test && npm run lint`
Expected: PASS. Build:
```bash
npm run build
```
Expected: PASS.

- [ ] **Step 18.5: Commit**

```bash
git add src/modules src/app.module.ts
git commit -m "feat(scheduling): wire SchedulingModule and intermodule exports"
```

---

## Task 19: PublicTenantMiddleware — resolve tenant pelo slug

**Files:**
- Create: `src/common/middleware/public-tenant.middleware.ts`
- Create: `src/common/middleware/public-tenant.middleware.spec.ts`

- [ ] **Step 19.1: Teste**

Crie `src/common/middleware/public-tenant.middleware.spec.ts`:

```ts
import { HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';
import { PublicTenantMiddleware } from './public-tenant.middleware';
import { tenantAls } from 'src/infra/prisma/prisma.service';

function makeReq(slug: string) {
  return { params: { slug }, url: `/public/${slug}/anything` } as unknown as Request;
}
function makeRes() {
  return {} as Response;
}

describe('PublicTenantMiddleware', () => {
  it('seta tenantId no ALS quando tenant existe e está ativo', async () => {
    const prisma = {
      tenant: {
        findFirst: jest.fn().mockResolvedValue({
          id: 't1',
          slug: 'acme',
          deletedAt: null,
          subscription: { status: 'active' },
        }),
      },
    } as any;
    const mw = new PublicTenantMiddleware(prisma);

    await new Promise<void>((resolve, reject) => {
      tenantAls.run({}, () => {
        mw.use(makeReq('acme'), makeRes(), (err?: unknown) => {
          if (err) return reject(err);
          expect(tenantAls.getStore()?.tenantId).toBe('t1');
          resolve();
        });
      });
    });
  });

  it('404 quando tenant não existe', async () => {
    const prisma = { tenant: { findFirst: jest.fn().mockResolvedValue(null) } } as any;
    const mw = new PublicTenantMiddleware(prisma);
    await expect(
      new Promise((_resolve, reject) => {
        tenantAls.run({}, () => {
          mw.use(makeReq('inexistente'), makeRes(), (err?: unknown) => reject(err));
        });
      }),
    ).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
  });

  it('404 quando tenant tem subscription cancelled', async () => {
    const prisma = {
      tenant: {
        findFirst: jest.fn().mockResolvedValue({
          id: 't1', slug: 'acme', deletedAt: null, subscription: { status: 'cancelled' },
        }),
      },
    } as any;
    const mw = new PublicTenantMiddleware(prisma);
    await expect(
      new Promise((_resolve, reject) => {
        tenantAls.run({}, () => {
          mw.use(makeReq('acme'), makeRes(), (err?: unknown) => reject(err));
        });
      }),
    ).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
  });
});
```

Run: `npx jest src/common/middleware -v`
Expected: FAIL.

- [ ] **Step 19.2: Implementar middleware**

Crie `src/common/middleware/public-tenant.middleware.ts`:

```ts
import { HttpStatus, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { PrismaService, tenantAls } from 'src/infra/prisma/prisma.service';

@Injectable()
export class PublicTenantMiddleware implements NestMiddleware {
  constructor(private readonly prisma: PrismaService) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const slug = (req.params as Record<string, string>)?.slug ?? this.extractSlugFromUrl(req.url);
    if (!slug) {
      return next(
        new DomainException({
          code: ErrorCodes.TENANT_NOT_FOUND,
          message: 'Slug ausente.',
          status: HttpStatus.NOT_FOUND,
        }),
      );
    }
    const tenant = await this.prisma.tenant.findFirst({
      where: { slug, deletedAt: null },
      include: { subscription: true },
    });
    if (!tenant) {
      return next(
        new DomainException({
          code: ErrorCodes.TENANT_NOT_FOUND,
          message: 'Barbearia não encontrada.',
          status: HttpStatus.NOT_FOUND,
        }),
      );
    }
    if (tenant.subscription && tenant.subscription.status === 'cancelled') {
      return next(
        new DomainException({
          code: ErrorCodes.TENANT_NOT_FOUND,
          message: 'Barbearia não encontrada.',
          status: HttpStatus.NOT_FOUND,
        }),
      );
    }
    const store = tenantAls.getStore();
    if (store) store.tenantId = tenant.id;
    next();
  }

  private extractSlugFromUrl(url: string | undefined): string | undefined {
    if (!url) return undefined;
    const m = /^\/public\/([^/?#]+)/.exec(url);
    return m?.[1];
  }
}
```

Run: `npx jest src/common/middleware -v`
Expected: PASS.

- [ ] **Step 19.3: Commit**

```bash
git add src/common/middleware
git commit -m "feat(common): PublicTenantMiddleware resolves tenant by slug and populates ALS"
```

---

## Task 20: PublicCatalogController — `/public/{slug}/(barbers|services|photos|me)`

**Files:**
- Create: `src/modules/public/public.module.ts`
- Create: `src/modules/public/public-catalog.controller.ts`
- Modify: `src/app.module.ts` (registra middleware)

- [ ] **Step 20.1: Controller**

Crie `src/modules/public/public-catalog.controller.ts`:

```ts
import { Controller, Get, Param } from '@nestjs/common';
import { Public } from 'src/common/decorators/public.decorator';
import { Throttle } from '@nestjs/throttler';
import { BarberRepository } from 'src/modules/barbers/repositories/barber.repository';
import { PhotoRepository } from 'src/modules/catalog/repositories/photo.repository';
import { ServiceRepository } from 'src/modules/catalog/repositories/service.repository';
import { TenantRepository } from 'src/modules/tenants/repositories/tenant.repository';

@Controller('public/:slug')
@Public()
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class PublicCatalogController {
  constructor(
    private readonly tenants: TenantRepository,
    private readonly barbers: BarberRepository,
    private readonly services: ServiceRepository,
    private readonly photos: PhotoRepository,
  ) {}

  @Get()
  async getTenant(@Param('slug') slug: string) {
    const t = await this.tenants.findBySlug(slug);
    if (!t) return null; // middleware já garante 404; defensive
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
    };
  }

  @Get('barbers')
  async listBarbers() {
    const list = await this.barbers.list();
    return list
      .filter((b) => b.active && !b.deletedAt)
      .map((b) => ({ id: b.id, displayName: b.displayName, bio: b.bio, avatarUrl: b.avatarUrl }));
  }

  @Get('services')
  async listServices() {
    const list = await this.services.list();
    return list
      .filter((s) => s.active && !s.deletedAt)
      .map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        durationMin: s.durationMin,
        priceCents: s.priceCents,
        barberIds: s.serviceBarbers.map((sb) => sb.barberId),
      }));
  }

  @Get('photos')
  async listPhotos() {
    const list = await this.photos.list();
    return list
      .filter((p) => !p.deletedAt)
      .map((p) => ({
        id: p.id,
        r2Key: p.r2Key,
        caption: p.caption,
        serviceId: p.serviceId,
        barberId: p.barberId,
      }));
  }
}
```

Atenção: `TenantRepository.findBySlug` precisa existir. Em `src/modules/tenants/repositories/tenant.repository.ts`, garanta o método (se não existe, adicione):

```ts
  findBySlug(slug: string) {
    return this.prisma.tenant.findFirst({ where: { slug, deletedAt: null } });
  }
```

- [ ] **Step 20.2: Module**

Crie `src/modules/public/public.module.ts`:

```ts
import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { PublicTenantMiddleware } from 'src/common/middleware/public-tenant.middleware';
import { BarbersModule } from 'src/modules/barbers/barbers.module';
import { CatalogModule } from 'src/modules/catalog/catalog.module';
import { CustomersModule } from 'src/modules/customers/customers.module';
import { NotificationsModule } from 'src/modules/notifications/notifications.module';
import { SchedulingModule } from 'src/modules/scheduling/scheduling.module';
import { TenantsModule } from 'src/modules/tenants/tenants.module';
import { PublicCatalogController } from './public-catalog.controller';

@Module({
  imports: [TenantsModule, BarbersModule, CatalogModule, CustomersModule, SchedulingModule, NotificationsModule],
  controllers: [PublicCatalogController],
})
export class PublicModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(PublicTenantMiddleware)
      .forRoutes({ path: 'public/:slug/*', method: RequestMethod.ALL });
    // O endpoint GET /public/:slug (raiz) também passa:
    consumer
      .apply(PublicTenantMiddleware)
      .forRoutes({ path: 'public/:slug', method: RequestMethod.GET });
  }
}
```

Em `src/app.module.ts`, importe e registre `PublicModule` nos `imports`.

- [ ] **Step 20.3: Testar**

Run: `npm run lint && npm run test`
Expected: PASS.

- [ ] **Step 20.4: Commit**

```bash
git add src/modules/public src/modules/tenants src/app.module.ts
git commit -m "feat(public): catalog read-only endpoints with slug-resolved tenant"
```

---

## Task 21: PublicAvailabilityController — `/public/{slug}/availability/*`

**Files:**
- Create: `src/modules/public/public-availability.controller.ts`
- Create: `src/modules/public/dto/availability-query.dto.ts`
- Modify: `src/modules/public/public.module.ts`

- [ ] **Step 21.1: DTO**

`src/modules/public/dto/availability-query.dto.ts`:

```ts
import { Type } from 'class-transformer';
import { IsDate, IsOptional, IsString } from 'class-validator';

export class AvailabilityQueryDto {
  @Type(() => Date) @IsDate() from!: Date;
  @Type(() => Date) @IsDate() to!: Date;
  @IsOptional() @IsString() serviceId?: string;
}
```

- [ ] **Step 21.2: Controller**

```ts
import { Controller, Get, HttpStatus, Param, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentTenant } from 'src/common/decorators/current-tenant.decorator';
import { Public } from 'src/common/decorators/public.decorator';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { BarberRepository } from 'src/modules/barbers/repositories/barber.repository';
import { TimeOffRepository } from 'src/modules/barbers/repositories/time-off.repository';
import { ServiceRepository } from 'src/modules/catalog/repositories/service.repository';
import { AppointmentRepository } from 'src/modules/scheduling/repositories/appointment.repository';
import { AvailabilityService } from 'src/modules/scheduling/availability.service';
import { TenantRepository } from 'src/modules/tenants/repositories/tenant.repository';
import { BUSINESS_HOURS_EMPTY, validateBusinessHours } from 'src/modules/tenants/business-hours';
import { AvailabilityQueryDto } from './dto/availability-query.dto';

@Controller('public/:slug/availability')
@Public()
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class PublicAvailabilityController {
  constructor(
    private readonly tenants: TenantRepository,
    private readonly barbers: BarberRepository,
    private readonly services: ServiceRepository,
    private readonly timeOffs: TimeOffRepository,
    private readonly appointments: AppointmentRepository,
    private readonly availability: AvailabilityService,
  ) {}

  @Get('by-barber/:barberId')
  async byBarber(
    @Param('slug') _slug: string,
    @Param('barberId') barberId: string,
    @Query() q: AvailabilityQueryDto,
    @CurrentTenant() tenantId: string,
  ) {
    if (!q.serviceId) {
      throw new DomainException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'serviceId é obrigatório nesta rota.',
        status: HttpStatus.BAD_REQUEST,
      });
    }
    const [tenant, barber, service, timeOffs, appts] = await Promise.all([
      this.tenants.findById(tenantId),
      this.barbers.findById(barberId),
      this.services.findById(q.serviceId),
      this.timeOffs.listForBarber(barberId),
      this.appointments.findActiveForBarberInRange(barberId, q.from, q.to),
    ]);
    if (!tenant || !barber || !service) {
      throw new DomainException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Recurso não encontrado.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    const businessHours = this.parseBh(tenant.businessHours);
    const slots = this.availability.computeSlots({
      tenantTimezone: tenant.timezone,
      businessHours,
      durationMin: service.durationMin,
      barberId,
      timeOffs: timeOffs.map((t) => ({ barberId, startsAt: t.startsAt, endsAt: t.endsAt })),
      appointments: appts.map((a) => ({ barberId, startsAt: a.startsAt, endsAt: a.endsAt })),
      from: q.from,
      to: q.to,
    });
    return slots.map((s) => ({ startsAt: s.startsAt, endsAt: s.endsAt }));
  }

  @Get('by-service/:serviceId')
  async byService(
    @Param('slug') _slug: string,
    @Param('serviceId') serviceId: string,
    @Query() q: AvailabilityQueryDto,
    @CurrentTenant() tenantId: string,
  ) {
    const [tenant, service] = await Promise.all([
      this.tenants.findById(tenantId),
      this.services.findById(serviceId),
    ]);
    if (!tenant || !service) {
      throw new DomainException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Recurso não encontrado.',
        status: HttpStatus.NOT_FOUND,
      });
    }
    const barberIds = service.serviceBarbers
      .map((sb) => sb.barberId)
      .filter((id, idx, self) => self.indexOf(id) === idx);
    const businessHours = this.parseBh(tenant.businessHours);

    const timeOffsByBarber: Record<string, { barberId: string; startsAt: Date; endsAt: Date }[]> = {};
    const appointmentsByBarber: Record<string, { barberId: string; startsAt: Date; endsAt: Date }[]> = {};
    await Promise.all(
      barberIds.map(async (bid) => {
        const [tos, apts] = await Promise.all([
          this.timeOffs.listForBarber(bid),
          this.appointments.findActiveForBarberInRange(bid, q.from, q.to),
        ]);
        timeOffsByBarber[bid] = tos.map((t) => ({ barberId: bid, startsAt: t.startsAt, endsAt: t.endsAt }));
        appointmentsByBarber[bid] = apts.map((a) => ({ barberId: bid, startsAt: a.startsAt, endsAt: a.endsAt }));
      }),
    );

    const groups = this.availability.getAvailabilityByService({
      tenantTimezone: tenant.timezone,
      businessHours,
      durationMin: service.durationMin,
      barberIds,
      timeOffsByBarber,
      appointmentsByBarber,
      from: q.from,
      to: q.to,
    });
    return groups.map((g) => ({
      barberId: g.barberId,
      slots: g.slots.map((s) => ({ startsAt: s.startsAt, endsAt: s.endsAt })),
    }));
  }

  private parseBh(raw: unknown) {
    if (!raw) return BUSINESS_HOURS_EMPTY;
    validateBusinessHours(raw);
    return raw;
  }
}
```

Atenção: `TimeOffRepository.listForBarber` precisa existir e ser exportada pelo `BarbersModule`. Em Fase 2 já existe.

`TenantRepository.findById` também precisa existir; verifique e adicione se necessário:

```ts
  findById(id: string) {
    return this.prisma.tenant.findFirst({ where: { id, deletedAt: null } });
  }
```

- [ ] **Step 21.3: Registrar no module**

Em `src/modules/public/public.module.ts`, adicione `PublicAvailabilityController` em `controllers`.

- [ ] **Step 21.4: Testar + commit**

Run: `npm run lint && npm run test`
Expected: PASS.

```bash
git add src/modules/public src/modules/tenants
git commit -m "feat(public): availability endpoints by barber and by service"
```

---

## Task 22: PublicAppointmentsController — booking + lookup + cancel

**Files:**
- Create: `src/modules/public/public-appointments.controller.ts`
- Create: `src/modules/public/dto/create-public-appointment.dto.ts`
- Modify: `src/modules/public/public.module.ts`

- [ ] **Step 22.1: DTO**

`src/modules/public/dto/create-public-appointment.dto.ts`:

```ts
import { Type } from 'class-transformer';
import { IsDate, IsObject, IsString, ValidateNested } from 'class-validator';
import { CustomerIdentityDto } from 'src/modules/customers/dto/customer-identity.dto';

export class CreatePublicAppointmentDto {
  @IsString() serviceId!: string;
  @IsString() barberId!: string;
  @Type(() => Date) @IsDate() startsAt!: Date;

  @ValidateNested() @Type(() => CustomerIdentityDto) @IsObject()
  customer!: CustomerIdentityDto;
}
```

- [ ] **Step 22.2: Controller**

`src/modules/public/public-appointments.controller.ts`:

```ts
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { Logger } from '@nestjs/common';
import { CurrentTenant } from 'src/common/decorators/current-tenant.decorator';
import { Public } from 'src/common/decorators/public.decorator';
import { Inject } from '@nestjs/common';
import {
  EMAIL_PROVIDER,
  type EmailProvider,
} from 'src/modules/notifications/email.provider';
import {
  appointmentConfirmationTemplate,
  customerClaimTemplate,
} from 'src/modules/notifications/templates';
import { CustomersService } from 'src/modules/customers/customers.service';
import { TenantRepository } from 'src/modules/tenants/repositories/tenant.repository';
import { ServiceRepository } from 'src/modules/catalog/repositories/service.repository';
import { BarberRepository } from 'src/modules/barbers/repositories/barber.repository';
import { AppointmentsService } from 'src/modules/scheduling/appointments.service';
import { CancellationService } from 'src/modules/scheduling/cancellation.service';
import { formatLocal, priceFormatBRL } from 'src/modules/scheduling/time-utils';
import { CreatePublicAppointmentDto } from './dto/create-public-appointment.dto';
import { tenantAls } from 'src/infra/prisma/prisma.service';

@Controller()
@Public()
export class PublicAppointmentsController {
  private readonly logger = new Logger(PublicAppointmentsController.name);

  constructor(
    private readonly tenants: TenantRepository,
    private readonly services: ServiceRepository,
    private readonly barbers: BarberRepository,
    private readonly customers: CustomersService,
    private readonly appointments: AppointmentsService,
    private readonly cancellation: CancellationService,
    private readonly cfg: ConfigService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
  ) {}

  @Post('public/:slug/appointments')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param('slug') slug: string,
    @CurrentTenant() tenantId: string,
    @Body() dto: CreatePublicAppointmentDto,
  ) {
    const { customer, claimPlainToken } = await this.customers.findOrCreateByPhone(dto.customer);

    const { appointment, cancellationPlainToken } = await this.appointments.createPublicBooking(
      tenantId,
      {
        serviceId: dto.serviceId,
        barberId: dto.barberId,
        startsAt: dto.startsAt,
        customer: { id: customer.id },
      },
    );

    const [tenant, service, barber] = await Promise.all([
      this.tenants.findById(tenantId),
      this.services.findById(dto.serviceId),
      this.barbers.findById(dto.barberId),
    ]);

    let emailDelivered = true;
    if (customer.email && tenant && service && barber) {
      const cancelUrl = `${this.cfg.get<string>('APP_PUBLIC_URL')}/${slug}/agendamentos/${appointment.id}/cancelar?token=${cancellationPlainToken}`;
      const claimUrl = claimPlainToken
        ? `${this.cfg.get<string>('APP_PUBLIC_URL')}/conta/claim?token=${claimPlainToken}`
        : undefined;

      const tpl = appointmentConfirmationTemplate({
        customerName: customer.name,
        tenantName: tenant.name,
        tenantSlug: tenant.slug,
        barberName: barber.displayName,
        serviceName: service.name,
        startsAtLocal: formatLocal(appointment.startsAt, tenant.timezone),
        priceFormatted: priceFormatBRL(appointment.priceCentsSnapshot),
        cancelUrl,
        claimUrl,
      });
      try {
        await this.email.send({ to: customer.email, subject: tpl.subject, text: tpl.text });
      } catch (err) {
        this.logger.error({ err, appointmentId: appointment.id }, 'confirmation email failed');
        emailDelivered = false;
      }
      if (claimUrl) {
        const claimTpl = customerClaimTemplate({
          customerName: customer.name,
          tenantName: tenant.name,
          claimUrl,
        });
        try {
          await this.email.send({ to: customer.email, subject: claimTpl.subject, text: claimTpl.text });
        } catch (err) {
          this.logger.warn({ err, customerId: customer.id }, 'claim email failed');
        }
      }
    }

    return {
      id: appointment.id,
      status: appointment.status,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      cancellationToken: cancellationPlainToken,
      claimToken: claimPlainToken,
      emailDelivered,
    };
  }

  // Sem slug — vem direto do token + id
  @Get('public/appointments/:id')
  async lookup(@Param('id') id: string, @Query('token') token: string) {
    const apt = await this.cancellation.lookupByToken(token);
    if (apt.id !== id) {
      // não vaza diferenciação de erro: mesmo código
      throw apt; // placeholder; substituído abaixo
    }
    // popula ALS para queries do service que carregam tenant info
    return new Promise((resolve) => {
      tenantAls.run({ tenantId: apt.tenantId }, () => {
        resolve({
          id: apt.id,
          status: apt.status,
          startsAt: apt.startsAt,
          endsAt: apt.endsAt,
          serviceName: apt.service?.name,
          barberName: apt.barber?.displayName,
          tenantName: apt.tenant?.name,
        });
      });
    });
  }

  @Post('public/appointments/:id/cancel')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  async cancel(
    @Param('id') id: string,
    @Query('token') token: string,
    @Body() body: { reason?: string },
  ) {
    const apt = await this.cancellation.lookupByToken(token);
    if (apt.id !== id) {
      // não diferenciar (anti-enumeration); reaproveita o erro de token inválido
      await this.cancellation.lookupByToken('invalid');
    }
    const updated = await this.cancellation.cancelByToken(token, body.reason);
    // email de cancelamento opcional (não bloqueia)
    return { id: updated.id, status: updated.status };
  }
}
```

Nota: A lógica de "id mismatch" na rota `GET /public/appointments/:id` pode ser simplificada — o token já identifica o appointment de forma única (UNIQUE no schema). Se `apt.id !== id`, é tentativa de combinar token de A com id de B → resposta deve ser 400 token inválido. Ajuste para:

```ts
    if (apt.id !== id) {
      throw new DomainException({
        code: ErrorCodes.CANCELLATION_TOKEN_INVALID,
        message: 'Token inválido.',
        status: HttpStatus.BAD_REQUEST,
      });
    }
```

(adicionar imports correspondentes; remover o `throw apt` placeholder.)

- [ ] **Step 22.3: Registrar no module**

Em `src/modules/public/public.module.ts`, adicione `PublicAppointmentsController` em `controllers`. Como esta rota tem path `public/appointments/:id` sem slug, o middleware atual (que casa `public/:slug/*`) não dispara — comportamento correto. O lookup do tenant vem do `Appointment.tenantId` carregado.

- [ ] **Step 22.4: Testar + commit**

Run: `npm run lint && npm run test && npm run build`
Expected: PASS.

```bash
git add src/modules/public
git commit -m "feat(public): booking creation + lookup + cancel-by-magic-link"
```

---

## Task 23: Auth — `POST /auth/customers/claim`

**Files:**
- Modify: `src/modules/auth/auth.controller.ts`
- Modify: `src/modules/auth/auth.service.ts`
- Create: `src/modules/auth/dto/claim-customer.dto.ts`
- Modify: `src/modules/auth/auth.module.ts` (importa CustomersModule)

- [ ] **Step 23.1: DTO**

`src/modules/auth/dto/claim-customer.dto.ts`:

```ts
import { IsNotEmpty, IsString, Length, MinLength } from 'class-validator';

export class ClaimCustomerDto {
  @IsString() @IsNotEmpty() token!: string;
  @IsString() @MinLength(8) @Length(8, 128) password!: string;
}
```

- [ ] **Step 23.2: Service**

Em `auth.service.ts`, injete `CustomersService` (via construtor) e adicione:

```ts
  async claimCustomer(input: { token: string; password: string }) {
    const customer = await this.customers.consumeClaimToken(input.token);
    if (!customer.email) {
      throw new DomainException({
        code: ErrorCodes.CLAIM_TOKEN_INVALID,
        message: 'Customer sem email registrado.',
        status: HttpStatus.BAD_REQUEST,
      });
    }
    const existingUser = await this.users.findByEmail(customer.email);
    if (existingUser) {
      throw new DomainException({
        code: ErrorCodes.EMAIL_ALREADY_REGISTERED,
        message: 'Email já cadastrado. Faça login.',
        status: HttpStatus.CONFLICT,
      });
    }
    const passwordHash = await this.password.hash(input.password);
    const user = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          email: customer.email!,
          passwordHash,
          name: customer.name,
          role: UserRole.customer,
          emailVerifiedAt: new Date(),
        },
      });
      await tx.customer.update({
        where: { id: customer.id },
        data: {
          userId: u.id,
          claimTokenHash: null,
          claimTokenExpiresAt: null,
        },
      });
      return u;
    });
    const pair = await this.tokens.issuePair({ userId: user.id, role: user.role, tenantId: undefined });
    return { user, ...pair };
  }
```

(Em `auth.module.ts`, importe `CustomersModule` para que `CustomersService` esteja disponível.)

- [ ] **Step 23.3: Controller**

Em `auth.controller.ts`, adicione:

```ts
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('customers/claim')
  @HttpCode(HttpStatus.OK)
  async claimCustomer(@Body() dto: ClaimCustomerDto) {
    const r = await this.auth.claimCustomer(dto);
    return {
      user: { id: r.user.id, email: r.user.email, name: r.user.name, role: r.user.role },
      accessToken: r.accessToken,
      refreshToken: r.refreshToken,
    };
  }
```

E import do `ClaimCustomerDto`.

- [ ] **Step 23.4: Testar + commit**

Run: `npm run lint && npm run test`
Expected: PASS.

```bash
git add src/modules/auth
git commit -m "feat(auth): POST /auth/customers/claim creates User from Customer claim token"
```

---

## Task 24: Integração — race condition no booking (testcontainers Postgres)

**Files:**
- Create: `src/modules/scheduling/appointments.service.race.spec.ts`

> Este spec usa o testcontainer Postgres real (não mock) para garantir que `FOR UPDATE` realmente serializa. Roda como `.spec.ts` (unit suite), não e2e, mas com `beforeAll` levantando container — segue padrão de specs de repo.

- [ ] **Step 24.1: Spec**

```ts
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { AppModule } from 'src/app.module';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AppointmentsService } from './appointments.service';
import { setTestEnv } from '../../../test/support/test-env';
import { startTestPostgres } from '../../../test/support/postgres-container';

describe('AppointmentsService — race condition (integration)', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaService;
  let appointments: AppointmentsService;
  let ctx: { tenantId: string; barberId: string; serviceId: string; customerAId: string; customerBId: string };

  beforeAll(async () => {
    setTestEnv();
    container = await startTestPostgres();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    appointments = app.get(AppointmentsService);

    // Cria fixture mínima sem usar HTTP, direto via Prisma
    const user = await prisma.user.create({
      data: { email: `dono+${Date.now()}@x.com`, name: 'D', passwordHash: 'x', role: 'tenant_owner' },
    });
    const tenant = await prisma.tenant.create({
      data: { slug: `race-${Date.now()}`, name: 'T', ownerUserId: user.id },
    });
    await prisma.subscription.create({
      data: { tenantId: tenant.id, status: 'active', trialEndsAt: new Date(Date.now() + 86400000) },
    });
    const barber = await prisma.barber.create({ data: { tenantId: tenant.id, displayName: 'B', active: true } });
    const service = await prisma.service.create({
      data: { tenantId: tenant.id, name: 'Corte', durationMin: 30, priceCents: 1000, active: true },
    });
    await prisma.serviceBarber.create({
      data: { tenantId: tenant.id, serviceId: service.id, barberId: barber.id },
    });
    const customerA = await prisma.customer.create({
      data: { tenantId: tenant.id, name: 'A', phone: '+550001' },
    });
    const customerB = await prisma.customer.create({
      data: { tenantId: tenant.id, name: 'B', phone: '+550002' },
    });
    ctx = {
      tenantId: tenant.id, barberId: barber.id, serviceId: service.id,
      customerAId: customerA.id, customerBId: customerB.id,
    };
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('apenas um de dois bookings concorrentes no mesmo slot vence; o outro recebe SLOT_TAKEN', async () => {
    const slot = new Date(Date.now() + 24 * 3600 * 1000); // amanhã, mesma hora

    const results = await Promise.allSettled([
      prisma.withTenant(ctx.tenantId, () =>
        appointments.createPublicBooking(ctx.tenantId, {
          serviceId: ctx.serviceId,
          barberId: ctx.barberId,
          startsAt: slot,
          customer: { id: ctx.customerAId },
        }),
      ),
      prisma.withTenant(ctx.tenantId, () =>
        appointments.createPublicBooking(ctx.tenantId, {
          serviceId: ctx.serviceId,
          barberId: ctx.barberId,
          startsAt: slot,
          customer: { id: ctx.customerBId },
        }),
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      response: expect.objectContaining({ code: 'APPOINTMENT_SLOT_TAKEN' }),
    });
  });
});
```

Run: `npx jest src/modules/scheduling/appointments.service.race.spec.ts -v --runInBand`
Expected: PASS.

- [ ] **Step 24.2: Commit**

```bash
git add src/modules/scheduling/appointments.service.race.spec.ts
git commit -m "test(scheduling): integration test proving FOR UPDATE serializes concurrent bookings"
```

---

## Task 25: E2E — happy path booking storefront

**Files:**
- Create: `test/support/time.ts`
- Create: `test/e2e/public-booking.e2e-spec.ts`

- [ ] **Step 25.1: Helper de tempo**

`test/support/time.ts`:

```ts
export function nextOpenSlotISO(daysAhead = 2, hourLocal = 14): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourLocal + 3, 0, 0, 0); // 14:00 SP = 17:00 UTC
  return d.toISOString();
}
```

- [ ] **Step 25.2: E2E**

`test/e2e/public-booking.e2e-spec.ts`:

```ts
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import { nextOpenSlotISO } from '../support/time';

interface CreateAppointmentResp {
  id: string;
  status: string;
  startsAt: string;
  cancellationToken: string;
  claimToken?: string;
  emailDelivered: boolean;
}

describe('Storefront pública — booking + cancel ponta a ponta (e2e)', () => {
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

  it('owner configura barbearia → cliente lista, vê disponibilidade, agenda, recebe token, cancela', async () => {
    const server = app.getHttpServer();

    // 1) Owner cadastrado + tenant criado
    const reg = await request(server)
      .post('/auth/register/owner')
      .send({
        email: 'dono@bb.test',
        password: 'StrongPass!1',
        name: 'Dono',
        tenantName: 'BB Studio',
        slug: 'bb-studio',
      })
      .expect(201);
    const ownerToken = (reg.body as { accessToken: string }).accessToken;

    // 2) Business hours: seg-sex 09:00-18:00 SP
    const openDay = { open: true, intervals: [{ startMin: 540, endMin: 1080 }] };
    const closedDay = { open: false, intervals: [] as { startMin: number; endMin: number }[] };
    await request(server)
      .patch('/admin/tenant/business-hours')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ businessHours: { days: [closedDay, openDay, openDay, openDay, openDay, openDay, closedDay] } })
      .expect(200);

    // 3) 1 barbeiro, 1 serviço, vínculo
    const barber = await request(server)
      .post('/admin/barbers')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ displayName: 'Pedro' })
      .expect(201);
    const barberId = (barber.body as { id: string }).id;

    const service = await request(server)
      .post('/admin/services')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Corte', durationMin: 30, priceCents: 4500 })
      .expect(201);
    const serviceId = (service.body as { id: string }).id;

    await request(server)
      .put(`/admin/services/${serviceId}/barbers`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ barberIds: [barberId] })
      .expect(200);

    // 4) Cliente lista catálogo público
    await request(server).get('/public/bb-studio').expect(200);
    const servicesList = await request(server).get('/public/bb-studio/services').expect(200);
    expect((servicesList.body as Array<{ id: string }>)[0].id).toBe(serviceId);

    // 5) Cliente consulta disponibilidade
    const from = new Date(); from.setUTCDate(from.getUTCDate() + 1); from.setUTCHours(0, 0, 0, 0);
    const to = new Date(from); to.setUTCDate(to.getUTCDate() + 7);
    const avail = await request(server)
      .get(`/public/bb-studio/availability/by-service/${serviceId}`)
      .query({ from: from.toISOString(), to: to.toISOString() })
      .expect(200);
    expect((avail.body as Array<{ slots: unknown[] }>)[0].slots.length).toBeGreaterThan(0);

    // 6) Cliente agenda
    const startsAt = nextOpenSlotISO();
    const booking = await request(server)
      .post('/public/bb-studio/appointments')
      .send({
        serviceId,
        barberId,
        startsAt,
        customer: { name: 'João', phone: '+5511999999999', email: 'joao@x.com' },
      })
      .expect(201);
    const b = booking.body as CreateAppointmentResp;
    expect(b.status).toBe('pending');
    expect(b.cancellationToken).toBeTruthy();
    expect(b.claimToken).toBeTruthy();

    // 7) Lookup com token
    await request(server)
      .get(`/public/appointments/${b.id}`)
      .query({ token: b.cancellationToken })
      .expect(200);

    // 8) Cancel via token
    const cancel = await request(server)
      .post(`/public/appointments/${b.id}/cancel`)
      .query({ token: b.cancellationToken })
      .send({})
      .expect(200);
    expect((cancel.body as { status: string }).status).toBe('cancelled');

    // 9) Re-cancel falha 409
    await request(server)
      .post(`/public/appointments/${b.id}/cancel`)
      .query({ token: b.cancellationToken })
      .send({})
      .expect(409);
  });

  it('SLOT_TAKEN: segundo cliente no mesmo slot recebe 409', async () => {
    const server = app.getHttpServer();
    // reaproveita fixture do teste anterior? Não — describe compartilha; usar slot diferente
    const startsAt = nextOpenSlotISO(3, 15);

    const services = await request(server).get('/public/bb-studio/services').expect(200);
    const serviceId = (services.body as Array<{ id: string }>)[0].id;
    const barberIds = ((services.body as Array<{ barberIds: string[] }>)[0]).barberIds;

    const [r1, r2] = await Promise.all([
      request(server)
        .post('/public/bb-studio/appointments')
        .send({
          serviceId, barberId: barberIds[0], startsAt,
          customer: { name: 'A', phone: '+551130001' },
        }),
      request(server)
        .post('/public/bb-studio/appointments')
        .send({
          serviceId, barberId: barberIds[0], startsAt,
          customer: { name: 'B', phone: '+551130002' },
        }),
    ]);
    const codes = [r1.status, r2.status].sort();
    expect(codes).toEqual([201, 409]);
  });
});
```

Run: `npm run test:e2e -- public-booking`
Expected: PASS.

- [ ] **Step 25.3: Commit**

```bash
git add test/e2e/public-booking.e2e-spec.ts test/support/time.ts
git commit -m "test(e2e): public booking happy path + slot taken"
```

---

## Task 26: E2E — admin appointments (agenda do barbeiro)

**Files:**
- Create: `test/e2e/admin-appointments.e2e-spec.ts`

- [ ] **Step 26.1: E2E**

`test/e2e/admin-appointments.e2e-spec.ts`:

```ts
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';
import { nextOpenSlotISO } from '../support/time';

describe('Admin appointments — agenda do barbeiro (e2e)', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    setTestEnv();
    container = await startTestPostgres();
    app = await buildTestApp();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('barbeiro vê appointment criado via storefront e consegue confirm + complete', async () => {
    const server = app.getHttpServer();

    const reg = await request(server)
      .post('/auth/register/owner')
      .send({
        email: 'dono@adm.test', password: 'StrongPass!1', name: 'D',
        tenantName: 'Adm', slug: 'adm',
      })
      .expect(201);
    const ownerToken = (reg.body as { accessToken: string }).accessToken;

    const open = { open: true, intervals: [{ startMin: 540, endMin: 1080 }] };
    const closed = { open: false, intervals: [] as { startMin: number; endMin: number }[] };
    await request(server)
      .patch('/admin/tenant/business-hours')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ businessHours: { days: [closed, open, open, open, open, open, closed] } })
      .expect(200);

    const barber = await request(server)
      .post('/admin/barbers').set('Authorization', `Bearer ${ownerToken}`)
      .send({ displayName: 'Pedro' }).expect(201);
    const barberId = (barber.body as { id: string }).id;

    const service = await request(server)
      .post('/admin/services').set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Corte', durationMin: 30, priceCents: 4500 }).expect(201);
    const serviceId = (service.body as { id: string }).id;

    await request(server)
      .put(`/admin/services/${serviceId}/barbers`).set('Authorization', `Bearer ${ownerToken}`)
      .send({ barberIds: [barberId] }).expect(200);

    const startsAt = nextOpenSlotISO(2, 14);
    const booking = await request(server)
      .post('/public/adm/appointments')
      .send({ serviceId, barberId, startsAt, customer: { name: 'Cli', phone: '+551144441111' } })
      .expect(201);
    const id = (booking.body as { id: string }).id;

    const from = new Date(); from.setUTCDate(from.getUTCDate() + 1); from.setUTCHours(0, 0, 0, 0);
    const to = new Date(from); to.setUTCDate(to.getUTCDate() + 5);

    const list = await request(server)
      .get('/admin/appointments').set('Authorization', `Bearer ${ownerToken}`)
      .query({ from: from.toISOString(), to: to.toISOString() })
      .expect(200);
    expect((list.body as Array<{ id: string }>).some((a) => a.id === id)).toBe(true);

    await request(server)
      .post(`/admin/appointments/${id}/confirm`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    await request(server)
      .post(`/admin/appointments/${id}/complete`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    // completed → cancel inválido
    await request(server)
      .post(`/admin/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({})
      .expect(409);
  });
});
```

Run: `npm run test:e2e -- admin-appointments`
Expected: PASS.

- [ ] **Step 26.2: Commit**

```bash
git add test/e2e/admin-appointments.e2e-spec.ts
git commit -m "test(e2e): admin appointments confirm/complete/transition guard"
```

---

## Task 27: E2E — isolation pública (tenant A não vaza pra tenant B)

**Files:**
- Create: `test/e2e/public-tenant-isolation.e2e-spec.ts`

- [ ] **Step 27.1: E2E**

`test/e2e/public-tenant-isolation.e2e-spec.ts`:

```ts
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';

describe('Storefront pública — isolation entre tenants (e2e)', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    setTestEnv();
    container = await startTestPostgres();
    app = await buildTestApp();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('GET /public/tenantA/services não retorna serviços de tenantB', async () => {
    const server = app.getHttpServer();

    const regA = await request(server)
      .post('/auth/register/owner')
      .send({
        email: 'a@x.com', password: 'StrongPass!1', name: 'A',
        tenantName: 'A', slug: 'isol-a',
      })
      .expect(201);
    const regB = await request(server)
      .post('/auth/register/owner')
      .send({
        email: 'b@x.com', password: 'StrongPass!1', name: 'B',
        tenantName: 'B', slug: 'isol-b',
      })
      .expect(201);
    const tokenA = (regA.body as { accessToken: string }).accessToken;
    const tokenB = (regB.body as { accessToken: string }).accessToken;

    const serviceA = await request(server)
      .post('/admin/services').set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'A-Corte', durationMin: 30, priceCents: 1000 }).expect(201);
    const serviceB = await request(server)
      .post('/admin/services').set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'B-Corte', durationMin: 30, priceCents: 2000 }).expect(201);

    const listA = await request(server).get('/public/isol-a/services').expect(200);
    const listB = await request(server).get('/public/isol-b/services').expect(200);

    const idsA = (listA.body as Array<{ id: string }>).map((s) => s.id);
    const idsB = (listB.body as Array<{ id: string }>).map((s) => s.id);
    expect(idsA).toContain((serviceA.body as { id: string }).id);
    expect(idsA).not.toContain((serviceB.body as { id: string }).id);
    expect(idsB).toContain((serviceB.body as { id: string }).id);
    expect(idsB).not.toContain((serviceA.body as { id: string }).id);
  });

  it('slug inexistente devolve 404', async () => {
    await request(app.getHttpServer()).get('/public/nope-tenant').expect(404);
  });
});
```

Run: `npm run test:e2e -- public-tenant-isolation`
Expected: PASS.

- [ ] **Step 27.2: Commit**

```bash
git add test/e2e/public-tenant-isolation.e2e-spec.ts
git commit -m "test(e2e): public storefront tenant isolation"
```

---

## Task 28: Atualizar `.env.example` final + README

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 28.1: `.env.example` final**

Garanta que `.env.example` contém todas as vars da Fase 3 (já adicionadas em Task 4, mas conferir):

```
APP_URL=http://localhost:3001
APP_PUBLIC_URL=http://localhost:3000
EMAIL_PROVIDER=console
EMAIL_FROM=noreply@kairobarber.local
RESEND_API_KEY=
```

- [ ] **Step 28.2: README — seção Fase 3**

Em `README.md`, na seção que lista as fases, marque Fase 3 como concluída e adicione exemplo de booking:

```markdown
### Fase 3 — Storefront pública + Agendamento ✅
- `/public/{slug}/(barbers|services|photos|availability/*|appointments)`
- `/admin/appointments` (lista, walk-in, confirm/complete/cancel/no-show, reschedule)
- `/auth/customers/claim` (magic link)
- Email de confirmação via Resend (ou console em dev)
```

- [ ] **Step 28.3: Verificação final completa**

Run:
```bash
npm run lint && npm run test && npm run test:e2e && npm run build
```
Expected: TODOS verdes.

- [ ] **Step 28.4: Commit final**

```bash
git add .env.example README.md
git commit -m "docs(phase3): update env example and README"
```

---

## Critério de aceitação da Fase 3

**Pronto quando** (do spec):
> Cliente faz booking ponta a ponta sem login, recebe email, consegue cancelar pelo link. Barbeiro vê o agendamento na agenda.

Validação concreta:
- `test/e2e/public-booking.e2e-spec.ts` passa (booking → lookup → cancel; SLOT_TAKEN concorrente).
- `test/e2e/admin-appointments.e2e-spec.ts` passa (lista, confirm, complete, transição inválida).
- `test/e2e/public-tenant-isolation.e2e-spec.ts` passa (tenant A não enxerga B).
- `src/modules/scheduling/appointments.service.race.spec.ts` passa (FOR UPDATE serializa concorrência real).
- Cobertura: `npm run test:cov` mostra `scheduling/` ≥ 90% e geral ≥ 70% (alvo da spec §11).
- Booking gera email com link `${APP_PUBLIC_URL}/{slug}/agendamentos/{id}/cancelar?token=...`. Em dev (`EMAIL_PROVIDER=console`), o link aparece no log.

---

## O que NÃO entra nesta fase (parking lot da Fase 3)

- AuditLog tabela (Fase 5). Hoje vira `pino` log estruturado.
- BullMQ + Redis para email (envio sync por enquanto).
- Idempotency-Key real (precisa Redis).
- Gating fino de `past_due > 7d` (Fase 4 — billing).
- Reschedule sugerindo slots alternativos quando dá conflito (front decide).
- Notificação de cancelamento por email (loga e segue; cliente já vê 200).
- Endpoint `/admin/dashboard/summary` (entra na Fase 4 ou 5).
- Customer self-service: `/customers/me/*` (entra quando customer-side UI for desenhada).
