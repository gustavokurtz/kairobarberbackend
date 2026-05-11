# KairoBarber — Fase 0 + Fase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar a fundação do projeto (NestJS + Prisma + Postgres + CI + deploy automático no Railway) e o módulo de Identity multi-tenant (auth completo, modelo de Tenant com isolation por middleware Prisma), com testes de regressão de tenant isolation passando.

**Architecture:** Monolito modular NestJS. Cada feature em um módulo isolado. Tenant isolation aplicada por middleware Prisma + Guard. JWT (access 15min + refresh 7d com rotação). Senhas argon2id. Refresh tokens hashados em tabela. Email com interface `EmailProvider` e `ConsoleEmailProvider` no MVP (Resend integra na Fase 3).

**Tech Stack:** Node 20, TypeScript 5, NestJS 10, Prisma 5, Postgres 16, Jest 29, @nestjs/jwt, @nestjs/throttler, @nestjs/config + Joi, argon2, nestjs-pino, @sentry/node, testcontainers/postgresql, supertest, GitHub Actions, Railway (deploy via Dockerfile).

**Spec de referência:** [`docs/superpowers/specs/2026-05-11-kairobarber-backend-design.md`](../specs/2026-05-11-kairobarber-backend-design.md)

---

## Estrutura de arquivos resultante (Fase 0 + Fase 1)

```
kairobarber/
├── .dockerignore
├── .editorconfig
├── .env.example
├── .eslintrc.cjs
├── .gitignore
├── .nvmrc
├── .prettierrc
├── docker-compose.yml
├── Dockerfile
├── jest.config.ts
├── jest.e2e.config.ts
├── nest-cli.json
├── package.json
├── railway.json
├── README.md
├── tsconfig.build.json
├── tsconfig.json
│
├── .github/
│   └── workflows/
│       └── ci.yml
│
├── prisma/
│   ├── schema.prisma
│   └── migrations/                  # geradas pela CLI
│
├── src/
│   ├── main.ts                      # bootstrap + middlewares globais
│   ├── app.module.ts                # raiz, junta tudo
│   │
│   ├── config/
│   │   ├── env.validation.ts        # schema Joi
│   │   └── config.module.ts         # @nestjs/config configurado
│   │
│   ├── infra/
│   │   ├── prisma/
│   │   │   ├── prisma.module.ts
│   │   │   └── prisma.service.ts    # cliente + middleware tenant
│   │   ├── logger/
│   │   │   └── logger.config.ts     # pino opts
│   │   └── sentry/
│   │       └── sentry.init.ts
│   │
│   ├── common/
│   │   ├── decorators/
│   │   │   ├── public.decorator.ts
│   │   │   ├── roles.decorator.ts
│   │   │   ├── current-user.decorator.ts
│   │   │   └── current-tenant.decorator.ts
│   │   ├── guards/
│   │   │   ├── jwt-auth.guard.ts
│   │   │   ├── roles.guard.ts
│   │   │   └── tenant.guard.ts
│   │   ├── filters/
│   │   │   └── global-exception.filter.ts
│   │   ├── exceptions/
│   │   │   ├── domain.exception.ts
│   │   │   └── error-codes.ts
│   │   └── types/
│   │       └── request-context.ts   # tipos pro request enriquecido
│   │
│   └── modules/
│       ├── health/
│       │   ├── health.module.ts
│       │   └── health.controller.ts
│       │
│       ├── auth/
│       │   ├── auth.module.ts
│       │   ├── auth.controller.ts
│       │   ├── auth.service.ts
│       │   ├── password.service.ts
│       │   ├── tokens.service.ts            # gera/valida JWT + refresh
│       │   ├── one-time-token.service.ts    # email verify / password reset
│       │   ├── strategies/
│       │   │   └── jwt.strategy.ts
│       │   ├── dto/
│       │   │   ├── register-owner.dto.ts
│       │   │   ├── login.dto.ts
│       │   │   ├── refresh.dto.ts
│       │   │   ├── logout.dto.ts
│       │   │   ├── verify-email.dto.ts
│       │   │   ├── forgot-password.dto.ts
│       │   │   └── reset-password.dto.ts
│       │   └── repositories/
│       │       ├── user.repository.ts
│       │       ├── refresh-token.repository.ts
│       │       └── one-time-token.repository.ts
│       │
│       ├── tenants/
│       │   ├── tenants.module.ts
│       │   ├── tenants.controller.ts
│       │   ├── tenants.service.ts
│       │   └── repositories/
│       │       └── tenant.repository.ts
│       │
│       └── notifications/
│           ├── notifications.module.ts
│           ├── email.provider.ts            # interface
│           └── providers/
│               └── console-email.provider.ts
│
└── test/
    ├── e2e/
    │   ├── health.e2e-spec.ts
    │   ├── auth-onboarding.e2e-spec.ts
    │   └── tenant-isolation.e2e-spec.ts
    ├── fixtures/
    │   └── test-users.ts
    └── support/
        ├── test-app.ts                  # boota Nest com Postgres efêmero
        └── postgres-container.ts        # testcontainers wrapper
```

**Princípio:** cada módulo tem fronteira clara, expõe service para outros módulos via DI, e mantém DTOs/repositórios internos. Não há "lib" gigante de utilitários — utilidade comum vai em `common/`.

---

# Fase 0 — Fundação

## Task 1: Inicializar projeto NestJS

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `nest-cli.json`, `src/main.ts`, `src/app.module.ts`
- Create: `.gitignore`, `.nvmrc`, `.editorconfig`

- [ ] **Step 1: Instalar Nest CLI globalmente (se não tiver) e gerar projeto**

Run:
```bash
cd /home/ntconsult/Projetos/meus/kairobarber
npm install -g @nestjs/cli@10
nest new . --skip-git --skip-install --package-manager npm
```
Quando perguntar `Which package manager would you like to use?`, responda `npm`. Vai criar arquivos sobrescrevendo o nest scaffold em cima do repo já iniciado.

- [ ] **Step 2: Configurar Node 20 via .nvmrc**

Create `.nvmrc`:
```
20
```

- [ ] **Step 3: Atualizar .gitignore (substituir o que o Nest gerou)**

Replace `.gitignore` with:
```
# Dependencies
node_modules/

# Build
dist/
build/

# Logs
*.log
npm-debug.log*

# Env
.env
.env.local
.env.*.local

# IDE
.vscode/
.idea/
*.swp

# OS
.DS_Store
Thumbs.db

# Coverage
coverage/
.nyc_output/

# Prisma generated client (gerado em postinstall)
node_modules/.prisma/

# Sentry
.sentryclirc
```

- [ ] **Step 4: Criar .editorconfig**

Create `.editorconfig`:
```
root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true

[*.md]
trim_trailing_whitespace = false
```

- [ ] **Step 5: Instalar dependências**

Run:
```bash
npm install
```

- [ ] **Step 6: Verificar boot básico**

Run:
```bash
npm run start
```
Expected: servidor sobe em `http://localhost:3000` respondendo "Hello World!" em `GET /`. Pare com `Ctrl+C`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: bootstrap NestJS project skeleton"
```

---

## Task 2: Configurar ESLint + Prettier

**Files:**
- Modify: `package.json` (scripts), `.eslintrc.cjs` (já gerado pelo Nest), `.prettierrc`
- Create: `.prettierignore`

- [ ] **Step 1: Atualizar .prettierrc**

Replace `.prettierrc` with:
```json
{
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
  "semi": true,
  "arrowParens": "always",
  "endOfLine": "lf"
}
```

- [ ] **Step 2: Criar .prettierignore**

Create `.prettierignore`:
```
node_modules
dist
coverage
prisma/migrations
```

- [ ] **Step 3: Atualizar .eslintrc.cjs (mais estrito que o default do Nest)**

Replace `.eslintrc.cjs`:
```js
module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: 'tsconfig.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint/eslint-plugin'],
  extends: [
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended',
  ],
  root: true,
  env: { node: true, jest: true },
  ignorePatterns: ['.eslintrc.cjs', 'dist', 'coverage', 'prisma/migrations'],
  rules: {
    '@typescript-eslint/interface-name-prefix': 'off',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'no-console': ['warn', { allow: ['warn', 'error'] }],
  },
};
```

- [ ] **Step 4: Verificar lint roda**

Run:
```bash
npm run lint
```
Expected: zero erros (talvez avisos). Se Nest tinha gerado warnings, corrija.

- [ ] **Step 5: Verificar format roda**

Run:
```bash
npm run format
```
Expected: arquivos formatados em silêncio.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: configure ESLint + Prettier with project rules"
```

---

## Task 3: Configurar Jest (unit + e2e)

**Files:**
- Modify: `package.json` (scripts, jest config)
- Create: `jest.config.ts`, `jest.e2e.config.ts`
- Delete: `test/` gerado pelo Nest (vamos refazer estrutura)

- [ ] **Step 1: Remover config jest legada do package.json**

No `package.json`, **remover** a chave `"jest": { ... }` que o Nest gerou. Manter os scripts.

- [ ] **Step 2: Criar jest.config.ts (unit tests)**

Create `jest.config.ts`:
```ts
import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  collectCoverageFrom: ['**/*.(t|j)s'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^src/(.*)$': '<rootDir>/$1',
  },
  setupFilesAfterEach: [],
};

export default config;
```

- [ ] **Step 3: Criar jest.e2e.config.ts (e2e tests)**

Create `jest.e2e.config.ts`:
```ts
import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: 'test/e2e/.*\\.e2e-spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  testEnvironment: 'node',
  moduleNameMapper: {
    '^src/(.*)$': '<rootDir>/src/$1',
  },
  testTimeout: 60_000,
};

export default config;
```

- [ ] **Step 4: Remover pasta test/ gerada pelo Nest**

Run:
```bash
rm -rf test/
mkdir -p test/e2e test/fixtures test/support
```

- [ ] **Step 5: Atualizar scripts no package.json**

No `package.json`, garantir que a seção `"scripts"` contenha:
```json
{
  "scripts": {
    "build": "nest build",
    "format": "prettier --write \"src/**/*.ts\" \"test/**/*.ts\"",
    "start": "nest start",
    "start:dev": "nest start --watch",
    "start:debug": "nest start --debug --watch",
    "start:prod": "node dist/main",
    "lint": "eslint \"{src,test}/**/*.ts\" --fix",
    "test": "jest --config jest.config.ts",
    "test:watch": "jest --config jest.config.ts --watch",
    "test:cov": "jest --config jest.config.ts --coverage",
    "test:e2e": "jest --config jest.e2e.config.ts --runInBand",
    "prisma:generate": "prisma generate",
    "prisma:migrate:dev": "prisma migrate dev",
    "prisma:migrate:deploy": "prisma migrate deploy",
    "prisma:studio": "prisma studio"
  }
}
```

- [ ] **Step 6: Garantir ts-jest instalado**

Run:
```bash
npm install -D ts-jest@29 @types/jest@29
```

- [ ] **Step 7: Rodar testes (esperado: nenhum encontrado, mas comando deve sair com sucesso)**

Run:
```bash
npm test -- --passWithNoTests
```
Expected: `No tests found` mas exit code 0.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: configure Jest with separate unit and e2e configs"
```

---

## Task 4: Docker Compose para Postgres (dev local)

**Files:**
- Create: `docker-compose.yml`
- Create: `.env.example`

- [ ] **Step 1: Criar docker-compose.yml**

Create `docker-compose.yml`:
```yaml
version: '3.9'

services:
  postgres:
    image: postgres:16-alpine
    container_name: kairobarber-postgres-dev
    restart: unless-stopped
    environment:
      POSTGRES_USER: kairobarber
      POSTGRES_PASSWORD: kairobarber_dev
      POSTGRES_DB: kairobarber
    ports:
      - '5432:5432'
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U kairobarber -d kairobarber']
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  postgres_data:
```

- [ ] **Step 2: Criar .env.example**

Create `.env.example`:
```bash
# App
NODE_ENV=development
PORT=3000
APP_URL=http://localhost:3000
LOG_LEVEL=debug

# Database
DATABASE_URL=postgresql://kairobarber:kairobarber_dev@localhost:5432/kairobarber?schema=public

# JWT
JWT_ACCESS_SECRET=change-me-access-min-32-chars-please-1234
JWT_REFRESH_SECRET=change-me-refresh-min-32-chars-please-12
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=7d

# Email
EMAIL_PROVIDER=console
EMAIL_FROM=noreply@kairobarber.local

# Auth
PASSWORD_HASH_TIME_COST=3
PASSWORD_HASH_MEMORY_COST=65536

# Throttling (in-memory, MVP single instance)
THROTTLE_TTL=60
THROTTLE_LIMIT=10

# Sentry (opcional — vazio = desligado)
SENTRY_DSN=
```

- [ ] **Step 3: Subir Postgres e verificar**

Run:
```bash
docker compose up -d postgres
docker compose ps
```
Expected: container `kairobarber-postgres-dev` rodando, healthcheck `healthy` em ~10s.

- [ ] **Step 4: Conectar pra confirmar**

Run:
```bash
docker exec -it kairobarber-postgres-dev psql -U kairobarber -d kairobarber -c '\dt'
```
Expected: `Did not find any relations.` (banco vazio, como esperado).

- [ ] **Step 5: Copiar .env.example pra .env local**

Run:
```bash
cp .env.example .env
```

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml .env.example
git commit -m "chore: add docker-compose for local Postgres + env example"
```

---

## Task 5: Instalar e configurar Prisma

**Files:**
- Create: `prisma/schema.prisma`
- Create: `src/infra/prisma/prisma.module.ts`, `src/infra/prisma/prisma.service.ts`
- Modify: `src/app.module.ts`

- [ ] **Step 1: Instalar Prisma**

Run:
```bash
npm install -D prisma@5
npm install @prisma/client@5
```

- [ ] **Step 2: Criar prisma/schema.prisma inicial**

Create `prisma/schema.prisma`:
```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// Modelos definidos na Fase 1
```

- [ ] **Step 3: Criar PrismaService**

Create `src/infra/prisma/prisma.service.ts`:
```ts
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({
      log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
```

- [ ] **Step 4: Criar PrismaModule**

Create `src/infra/prisma/prisma.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
```

- [ ] **Step 5: Importar PrismaModule no AppModule**

Replace `src/app.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from './infra/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
```

> Nota: o Nest gerou `app.controller.ts` e `app.service.ts` no scaffold inicial. Remova ambos e seus testes antes de prosseguir:
> ```bash
> rm src/app.controller.ts src/app.controller.spec.ts src/app.service.ts
> ```

- [ ] **Step 6: Gerar client Prisma (vazio, sem modelos ainda)**

Run:
```bash
npx prisma generate
```
Expected: `✔ Generated Prisma Client (...) to ./node_modules/@prisma/client`.

- [ ] **Step 7: Boot da app pra verificar que conecta**

Run:
```bash
npm run start
```
Expected: sobe sem erros de conexão. Para com `Ctrl+C`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: add Prisma with empty schema and global PrismaModule"
```

---

## Task 6: Config module com validação Joi

**Files:**
- Create: `src/config/env.validation.ts`, `src/config/config.module.ts`
- Modify: `src/app.module.ts`

- [ ] **Step 1: Instalar deps**

Run:
```bash
npm install @nestjs/config@3 joi@17
```

- [ ] **Step 2: Criar schema de validação**

Create `src/config/env.validation.ts`:
```ts
import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().default(3000),
  APP_URL: Joi.string().uri().required(),
  LOG_LEVEL: Joi.string().valid('fatal', 'error', 'warn', 'info', 'debug', 'trace').default('info'),

  DATABASE_URL: Joi.string().uri().required(),

  JWT_ACCESS_SECRET: Joi.string().min(32).required(),
  JWT_REFRESH_SECRET: Joi.string().min(32).required(),
  JWT_ACCESS_TTL: Joi.string().default('15m'),
  JWT_REFRESH_TTL: Joi.string().default('7d'),

  EMAIL_PROVIDER: Joi.string().valid('console', 'resend').default('console'),
  EMAIL_FROM: Joi.string().email().required(),

  PASSWORD_HASH_TIME_COST: Joi.number().integer().min(2).default(3),
  PASSWORD_HASH_MEMORY_COST: Joi.number().integer().min(32768).default(65536),

  THROTTLE_TTL: Joi.number().integer().min(1).default(60),
  THROTTLE_LIMIT: Joi.number().integer().min(1).default(10),

  SENTRY_DSN: Joi.string().uri().optional().allow(''),
});

export type AppEnv = {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  APP_URL: string;
  LOG_LEVEL: string;
  DATABASE_URL: string;
  JWT_ACCESS_SECRET: string;
  JWT_REFRESH_SECRET: string;
  JWT_ACCESS_TTL: string;
  JWT_REFRESH_TTL: string;
  EMAIL_PROVIDER: 'console' | 'resend';
  EMAIL_FROM: string;
  PASSWORD_HASH_TIME_COST: number;
  PASSWORD_HASH_MEMORY_COST: number;
  THROTTLE_TTL: number;
  THROTTLE_LIMIT: number;
  SENTRY_DSN?: string;
};
```

- [ ] **Step 3: Criar wrapper ConfigModule**

Create `src/config/config.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { envValidationSchema } from './env.validation';

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
      validationOptions: { abortEarly: true, allowUnknown: true },
    }),
  ],
})
export class ConfigModule {}
```

- [ ] **Step 4: Importar no AppModule**

Replace `src/app.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './infra/prisma/prisma.module';

@Module({
  imports: [ConfigModule, PrismaModule],
})
export class AppModule {}
```

- [ ] **Step 5: Testar — propositalmente remova DATABASE_URL e veja falhar**

Run:
```bash
DATABASE_URL= npm run start
```
Expected: app falha com erro Joi do tipo `DATABASE_URL is required` ou `must be a valid uri`.

- [ ] **Step 6: Restaurar e verificar boot**

Run:
```bash
npm run start
```
Expected: sobe normal. Pare com `Ctrl+C`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(config): add env validation with Joi and global ConfigModule"
```

---

## Task 7: Logging estruturado com nestjs-pino

**Files:**
- Create: `src/infra/logger/logger.config.ts`
- Modify: `src/main.ts`, `src/app.module.ts`

- [ ] **Step 1: Instalar deps**

Run:
```bash
npm install nestjs-pino@4 pino@9 pino-http@10
npm install -D pino-pretty@11
```

- [ ] **Step 2: Criar logger config**

Create `src/infra/logger/logger.config.ts`:
```ts
import type { Params } from 'nestjs-pino';

export function buildLoggerOptions(env: NodeJS.ProcessEnv): Params {
  const isDev = env.NODE_ENV === 'development';
  return {
    pinoHttp: {
      level: env.LOG_LEVEL ?? 'info',
      transport: isDev
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
        : undefined,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.newPassword',
          'req.body.currentPassword',
          'req.body.token',
          'res.headers["set-cookie"]',
        ],
        censor: '[REDACTED]',
      },
      customProps: () => ({ service: 'kairobarber-api' }),
      serializers: {
        req(req) {
          return { id: req.id, method: req.method, url: req.url };
        },
      },
    },
  };
}
```

- [ ] **Step 3: Atualizar AppModule pra usar o Logger**

Replace `src/app.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './infra/prisma/prisma.module';
import { buildLoggerOptions } from './infra/logger/logger.config';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      useFactory: () => buildLoggerOptions(process.env),
    }),
    PrismaModule,
  ],
})
export class AppModule {}
```

- [ ] **Step 4: Atualizar main.ts pra usar o Logger global**

Replace `src/main.ts`:
```ts
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
}
bootstrap();
```

- [ ] **Step 5: Verificar boot com logs estruturados**

Run:
```bash
npm run start:dev
```
Expected: logs em formato pino-pretty no terminal, com timestamp e nível colorido. Pare com `Ctrl+C`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(infra): add structured logging with nestjs-pino"
```

---

## Task 8: Health check endpoints (/health/live e /health/ready)

**Files:**
- Create: `src/modules/health/health.module.ts`, `src/modules/health/health.controller.ts`
- Create: `src/modules/health/health.controller.spec.ts`
- Create: `test/e2e/health.e2e-spec.ts`
- Modify: `src/app.module.ts`

- [ ] **Step 1: Instalar @nestjs/terminus**

Run:
```bash
npm install @nestjs/terminus@10
```

- [ ] **Step 2: Criar teste E2E (vai falhar — endpoint não existe)**

Create `test/e2e/health.e2e-spec.ts`:
```ts
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from 'src/app.module';

describe('Health endpoints (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/live -> 200', async () => {
    const res = await request(app.getHttpServer()).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /health/ready -> 200 (db reachable)', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.info.database.status).toBe('up');
  });
});
```

Install supertest types if not present:
```bash
npm install -D supertest@7 @types/supertest@6
```

- [ ] **Step 3: Rodar teste e ver falhar**

Run:
```bash
npm run test:e2e -- health.e2e-spec
```
Expected: FAIL com `404` no /health/live ou erro de import.

- [ ] **Step 4: Implementar HealthController**

Create `src/modules/health/health.controller.ts`:
```ts
import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  PrismaHealthIndicator,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaIndicator: PrismaHealthIndicator,
    private readonly prisma: PrismaService,
  ) {}

  @Get('live')
  live(): HealthIndicatorResult {
    return { app: { status: 'up' }, status: 'ok' } as unknown as HealthIndicatorResult;
  }

  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([() => this.prismaIndicator.pingCheck('database', this.prisma)]);
  }
}
```

> Nota: o endpoint `/health/live` deve responder mesmo se o DB cair (só checa processo vivo). Por isso ele não usa o `HealthCheckService`. A resposta tem que ter shape `{ status: 'ok' }`.

Refine `live()`:
```ts
@Get('live')
live() {
  return { status: 'ok' };
}
```

- [ ] **Step 5: Criar HealthModule**

Create `src/modules/health/health.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
})
export class HealthModule {}
```

- [ ] **Step 6: Registrar no AppModule**

Update `src/app.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './infra/prisma/prisma.module';
import { buildLoggerOptions } from './infra/logger/logger.config';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      useFactory: () => buildLoggerOptions(process.env),
    }),
    PrismaModule,
    HealthModule,
  ],
})
export class AppModule {}
```

- [ ] **Step 7: Rodar teste e ver passar**

Run:
```bash
npm run test:e2e -- health.e2e-spec
```
Expected: PASS nos dois testes.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(health): add /health/live and /health/ready endpoints with DB check"
```

---

## Task 9: Global exception filter + DomainException

**Files:**
- Create: `src/common/exceptions/error-codes.ts`, `src/common/exceptions/domain.exception.ts`
- Create: `src/common/filters/global-exception.filter.ts`
- Create: `src/common/filters/global-exception.filter.spec.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Criar ErrorCodes**

Create `src/common/exceptions/error-codes.ts`:
```ts
export const ErrorCodes = {
  // Genéricos
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  // Auth (Fase 1)
  EMAIL_ALREADY_REGISTERED: 'EMAIL_ALREADY_REGISTERED',
  SLUG_TAKEN: 'SLUG_TAKEN',
  SLUG_RESERVED: 'SLUG_RESERVED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  REFRESH_REUSED: 'REFRESH_REUSED',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
```

- [ ] **Step 2: Criar DomainException**

Create `src/common/exceptions/domain.exception.ts`:
```ts
import { HttpException } from '@nestjs/common';
import { ErrorCode } from './error-codes';

export type DomainExceptionOptions = {
  code: ErrorCode;
  message: string;
  status: number;
  details?: Record<string, unknown>;
};

export class DomainException extends HttpException {
  constructor(public readonly opts: DomainExceptionOptions) {
    super({ code: opts.code, message: opts.message, details: opts.details }, opts.status);
  }
}
```

- [ ] **Step 3: Criar GlobalExceptionFilter (test-first)**

Create `src/common/filters/global-exception.filter.spec.ts`:
```ts
import { ArgumentsHost, HttpStatus } from '@nestjs/common';
import { GlobalExceptionFilter } from './global-exception.filter';
import { DomainException } from '../exceptions/domain.exception';

function makeHost(jsonSpy: jest.Mock, statusSpy: jest.Mock): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getResponse: () => ({ status: statusSpy.mockReturnThis(), json: jsonSpy }),
      getRequest: () => ({ id: 'trace-1', url: '/x', method: 'GET' }),
    }),
  } as unknown as ArgumentsHost;
}

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;
  let statusSpy: jest.Mock;
  let jsonSpy: jest.Mock;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
    statusSpy = jest.fn().mockReturnThis();
    jsonSpy = jest.fn();
  });

  it('maps DomainException to its declared status + code', () => {
    const ex = new DomainException({
      code: 'EMAIL_ALREADY_REGISTERED',
      message: 'email taken',
      status: HttpStatus.CONFLICT,
    });
    filter.catch(ex, makeHost(jsonSpy, statusSpy));
    expect(statusSpy).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'EMAIL_ALREADY_REGISTERED', message: 'email taken' }),
    );
  });

  it('maps unknown error to 500 INTERNAL_ERROR without stack leak', () => {
    filter.catch(new Error('boom'), makeHost(jsonSpy, statusSpy));
    expect(statusSpy).toHaveBeenCalledWith(500);
    const payload = jsonSpy.mock.calls[0][0];
    expect(payload.code).toBe('INTERNAL_ERROR');
    expect(payload.message).not.toContain('boom');
  });
});
```

- [ ] **Step 4: Rodar teste e ver falhar**

Run:
```bash
npm test -- global-exception.filter
```
Expected: FAIL (filter ainda não existe).

- [ ] **Step 5: Implementar GlobalExceptionFilter**

Create `src/common/filters/global-exception.filter.ts`:
```ts
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { DomainException } from '../exceptions/domain.exception';
import { ErrorCodes } from '../exceptions/error-codes';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();
    const req = ctx.getRequest();
    const traceId = (req as { id?: string }).id;

    if (exception instanceof DomainException) {
      const { code, message, details, status } = exception.opts;
      return res.status(status).json({ code, message, details, traceId });
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const responseBody = exception.getResponse();
      const isObj = typeof responseBody === 'object' && responseBody !== null;
      const message = isObj
        ? ((responseBody as { message?: string | string[] }).message ?? exception.message)
        : (responseBody as string);
      const code = this.mapHttpStatusToCode(status);
      return res
        .status(status)
        .json({ code, message: Array.isArray(message) ? message.join('; ') : message, traceId });
    }

    this.logger.error(
      `Unhandled exception at ${(req as { method?: string }).method} ${(req as { url?: string }).url}`,
      exception instanceof Error ? exception.stack : String(exception),
    );
    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      code: ErrorCodes.INTERNAL_ERROR,
      message: 'Erro interno. Tente novamente em instantes.',
      traceId,
    });
  }

  private mapHttpStatusToCode(status: number): string {
    switch (status) {
      case 400:
        return ErrorCodes.VALIDATION_ERROR;
      case 401:
        return ErrorCodes.UNAUTHENTICATED;
      case 403:
        return ErrorCodes.FORBIDDEN;
      case 404:
        return ErrorCodes.NOT_FOUND;
      case 409:
        return ErrorCodes.CONFLICT;
      default:
        return ErrorCodes.INTERNAL_ERROR;
    }
  }
}
```

- [ ] **Step 6: Rodar teste e ver passar**

Run:
```bash
npm test -- global-exception.filter
```
Expected: PASS.

- [ ] **Step 7: Registrar filter globalmente + ValidationPipe**

Replace `src/main.ts`:
```ts
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  app.use(helmet());
  app.enableCors({ origin: true, credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());

  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
}
bootstrap();
```

Install helmet + class-validator + class-transformer:
```bash
npm install helmet@7 class-validator@0.14 class-transformer@0.5
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(common): add global exception filter and security middleware"
```

---

## Task 10: GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Criar workflow**

Create `.github/workflows/ci.yml`:
```yaml
name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  ci:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: kairobarber
          POSTGRES_PASSWORD: kairobarber_dev
          POSTGRES_DB: kairobarber
        ports:
          - 5432:5432
        options: >-
          --health-cmd="pg_isready -U kairobarber -d kairobarber"
          --health-interval=5s
          --health-timeout=5s
          --health-retries=5

    env:
      NODE_ENV: test
      PORT: 3000
      APP_URL: http://localhost:3000
      DATABASE_URL: postgresql://kairobarber:kairobarber_dev@localhost:5432/kairobarber?schema=public
      JWT_ACCESS_SECRET: ci-access-secret-min-32-characters-long-x
      JWT_REFRESH_SECRET: ci-refresh-secret-min-32-characters-long-x
      EMAIL_PROVIDER: console
      EMAIL_FROM: noreply@kairobarber.ci

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm

      - run: npm ci

      - run: npx prisma generate

      - name: Apply migrations (no-op until Fase 1)
        run: npx prisma migrate deploy

      - run: npm run lint

      - run: npm test -- --passWithNoTests

      - run: npm run test:e2e -- --passWithNoTests

      - run: npm run build
```

- [ ] **Step 2: Validar workflow localmente com act (opcional)**

Se quiser confirmar antes do push, instale [act](https://github.com/nektos/act) e rode:
```bash
act -j ci
```
Opcional. Em geral, basta abrir um PR pra ver rodar.

- [ ] **Step 3: Commit**

```bash
git add .github/
git commit -m "ci: add GitHub Actions pipeline with Postgres service"
```

---

## Task 11: Sentry init (opcional/condicional)

**Files:**
- Create: `src/infra/sentry/sentry.init.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Instalar @sentry/node**

Run:
```bash
npm install @sentry/node@8 @sentry/profiling-node@8
```

- [ ] **Step 2: Criar sentry.init.ts**

Create `src/infra/sentry/sentry.init.ts`:
```ts
import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

export function initSentry(dsn?: string, environment?: string) {
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: environment ?? 'production',
    integrations: [nodeProfilingIntegration()],
    tracesSampleRate: 0.1,
    profilesSampleRate: 0.1,
  });
}
```

- [ ] **Step 3: Integrar no main.ts (antes de qualquer outra coisa)**

Update top of `src/main.ts` (antes da função bootstrap):
```ts
import { initSentry } from './infra/sentry/sentry.init';

initSentry(process.env.SENTRY_DSN, process.env.NODE_ENV);
```

- [ ] **Step 4: Adicionar captura de exceptions não tratadas no filter**

In `src/common/filters/global-exception.filter.ts`, no bloco que loga erro 500, adicione:
```ts
import * as Sentry from '@sentry/node';
// ...
this.logger.error(...);
Sentry.captureException(exception);
return res.status(...).json(...);
```

- [ ] **Step 5: Verificar boot sem DSN (deve funcionar normal)**

Run:
```bash
npm run start
```
Expected: sobe normal (DSN vazio → Sentry no-op).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(infra): integrate Sentry (no-op when DSN absent)"
```

---

## Task 12: Dockerfile + Railway config

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `railway.json`

- [ ] **Step 1: Criar .dockerignore**

Create `.dockerignore`:
```
node_modules
dist
coverage
.git
.github
.env
.env.*
*.md
docs
test
```

- [ ] **Step 2: Criar Dockerfile multi-stage**

Create `Dockerfile`:
```dockerfile
# syntax=docker/dockerfile:1.6

FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package*.json ./
RUN npm prune --omit=dev && npx prisma generate
USER node
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
```

- [ ] **Step 3: Criar railway.json**

Create `railway.json`:
```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": { "builder": "DOCKERFILE", "dockerfilePath": "Dockerfile" },
  "deploy": {
    "startCommand": "npx prisma migrate deploy && node dist/main.js",
    "healthcheckPath": "/health/ready",
    "healthcheckTimeout": 30,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 3
  }
}
```

- [ ] **Step 4: Build local pra validar Dockerfile**

Run:
```bash
docker build -t kairobarber-api:dev .
```
Expected: build conclui sem erro. Pode demorar uns minutos na primeira vez.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore railway.json
git commit -m "chore(deploy): add Dockerfile and Railway config"
```

---

## Task 13: README com instruções de setup

**Files:**
- Create: `README.md`

- [ ] **Step 1: Criar README**

Create `README.md`:
````markdown
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
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README with setup instructions"
```

---

# Fase 1 — Identity + Multi-tenancy

## Task 14: Prisma schema — User, Tenant, Subscription, RefreshToken, OneTimeToken

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_init_identity/migration.sql` (gerada pela CLI)

- [ ] **Step 1: Atualizar schema.prisma**

Replace `prisma/schema.prisma`:
```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum UserRole {
  saas_owner
  tenant_owner
  barber_member
  customer
}

enum SubscriptionStatus {
  trialing
  active
  past_due
  cancelled
}

enum OneTimeTokenPurpose {
  email_verification
  password_reset
}

model User {
  id              String    @id @default(cuid())
  email           String    @unique
  passwordHash    String
  name            String
  role            UserRole
  emailVerifiedAt DateTime?
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  ownedTenant     Tenant?           @relation("TenantOwner")
  refreshTokens   RefreshToken[]
  oneTimeTokens   OneTimeToken[]
}

model Tenant {
  id          String   @id @default(cuid())
  slug        String   @unique
  name        String
  timezone    String   @default("America/Sao_Paulo")
  ownerUserId String   @unique
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  deletedAt   DateTime?

  owner        User          @relation("TenantOwner", fields: [ownerUserId], references: [id])
  subscription Subscription?

  @@index([deletedAt])
}

model Subscription {
  id                      String              @id @default(cuid())
  tenantId                String              @unique
  status                  SubscriptionStatus
  trialEndsAt             DateTime?
  currentPeriodEnd        DateTime?
  mpPreapprovalId         String?             @unique
  lastSyncedAt            DateTime?
  nextSyncAt              DateTime?
  aiQuotaUsedThisMonth    Int                 @default(0)
  createdAt               DateTime            @default(now())
  updatedAt               DateTime            @updatedAt

  tenant Tenant @relation(fields: [tenantId], references: [id])

  @@index([status, nextSyncAt])
}

model RefreshToken {
  id        String    @id @default(cuid())
  userId    String
  tokenHash String    @unique
  expiresAt DateTime
  createdAt DateTime  @default(now())
  revokedAt DateTime?
  replacedById String?

  user User @relation(fields: [userId], references: [id])

  @@index([userId])
}

model OneTimeToken {
  id        String              @id @default(cuid())
  userId    String
  purpose   OneTimeTokenPurpose
  tokenHash String              @unique
  expiresAt DateTime
  usedAt    DateTime?
  createdAt DateTime            @default(now())

  user User @relation(fields: [userId], references: [id])

  @@index([userId, purpose])
}
```

- [ ] **Step 2: Garantir Postgres rodando**

Run:
```bash
docker compose up -d postgres
```

- [ ] **Step 3: Gerar e aplicar migration**

Run:
```bash
npx prisma migrate dev --name init_identity
```
Expected: arquivo SQL gerado em `prisma/migrations/<ts>_init_identity/migration.sql`, banco com tabelas criadas, client regenerado.

- [ ] **Step 4: Conferir no banco**

Run:
```bash
docker exec -it kairobarber-postgres-dev psql -U kairobarber -d kairobarber -c '\dt'
```
Expected: tabelas `User`, `Tenant`, `Subscription`, `RefreshToken`, `OneTimeToken`, `_prisma_migrations`.

- [ ] **Step 5: Commit**

```bash
git add prisma/
git commit -m "feat(prisma): add User, Tenant, Subscription, RefreshToken, OneTimeToken"
```

---

## Task 15: PasswordService com argon2id

**Files:**
- Create: `src/modules/auth/password.service.ts`, `src/modules/auth/password.service.spec.ts`

- [ ] **Step 1: Instalar argon2**

Run:
```bash
npm install argon2@0.40
```

- [ ] **Step 2: Criar teste**

Create `src/modules/auth/password.service.spec.ts`:
```ts
import { ConfigService } from '@nestjs/config';
import { PasswordService } from './password.service';

describe('PasswordService', () => {
  let service: PasswordService;

  beforeEach(() => {
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'PASSWORD_HASH_TIME_COST') return 3;
        if (key === 'PASSWORD_HASH_MEMORY_COST') return 65536;
        return undefined;
      }),
    } as unknown as ConfigService;
    service = new PasswordService(config);
  });

  it('hashes and verifies a password successfully', async () => {
    const hash = await service.hash('SuperSecret123!');
    expect(hash).not.toBe('SuperSecret123!');
    expect(await service.verify(hash, 'SuperSecret123!')).toBe(true);
  });

  it('returns false for wrong password', async () => {
    const hash = await service.hash('SuperSecret123!');
    expect(await service.verify(hash, 'wrong')).toBe(false);
  });

  it('produces different hashes for the same password (salt random)', async () => {
    const h1 = await service.hash('SuperSecret123!');
    const h2 = await service.hash('SuperSecret123!');
    expect(h1).not.toBe(h2);
  });
});
```

- [ ] **Step 3: Rodar teste e ver falhar**

Run:
```bash
npm test -- password.service
```
Expected: FAIL com `Cannot find module`.

- [ ] **Step 4: Implementar PasswordService**

Create `src/modules/auth/password.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';

@Injectable()
export class PasswordService {
  constructor(private readonly config: ConfigService) {}

  async hash(plain: string): Promise<string> {
    return argon2.hash(plain, {
      type: argon2.argon2id,
      timeCost: this.config.get<number>('PASSWORD_HASH_TIME_COST') ?? 3,
      memoryCost: this.config.get<number>('PASSWORD_HASH_MEMORY_COST') ?? 65536,
      parallelism: 1,
    });
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false;
    }
  }
}
```

- [ ] **Step 5: Rodar teste e ver passar**

Run:
```bash
npm test -- password.service
```
Expected: PASS (3 testes).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(auth): add PasswordService with argon2id"
```

---

## Task 16: TokensService — JWT access + refresh com rotação

**Files:**
- Create: `src/modules/auth/tokens.service.ts`, `src/modules/auth/tokens.service.spec.ts`
- Create: `src/modules/auth/repositories/refresh-token.repository.ts`

- [ ] **Step 1: Instalar @nestjs/jwt**

Run:
```bash
npm install @nestjs/jwt@10
```

- [ ] **Step 2: Criar RefreshTokenRepository**

Create `src/modules/auth/repositories/refresh-token.repository.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class RefreshTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: { userId: string; tokenHash: string; expiresAt: Date }) {
    return this.prisma.refreshToken.create({ data });
  }

  findByHash(tokenHash: string) {
    return this.prisma.refreshToken.findUnique({ where: { tokenHash } });
  }

  async rotate(oldId: string, newId: string) {
    await this.prisma.refreshToken.update({
      where: { id: oldId },
      data: { revokedAt: new Date(), replacedById: newId },
    });
  }

  async revokeAllForUser(userId: string) {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
```

- [ ] **Step 3: Criar teste do TokensService**

Create `src/modules/auth/tokens.service.spec.ts`:
```ts
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { TokensService } from './tokens.service';
import { RefreshTokenRepository } from './repositories/refresh-token.repository';

describe('TokensService', () => {
  let svc: TokensService;
  let jwt: JwtService;
  let repo: jest.Mocked<RefreshTokenRepository>;

  beforeEach(() => {
    const config = {
      get: jest.fn((k: string) => {
        const v: Record<string, string> = {
          JWT_ACCESS_SECRET: 'a'.repeat(40),
          JWT_REFRESH_SECRET: 'b'.repeat(40),
          JWT_ACCESS_TTL: '15m',
          JWT_REFRESH_TTL: '7d',
        };
        return v[k];
      }),
    } as unknown as ConfigService;
    jwt = new JwtService({});
    repo = {
      create: jest.fn(),
      findByHash: jest.fn(),
      rotate: jest.fn(),
      revokeAllForUser: jest.fn(),
    } as unknown as jest.Mocked<RefreshTokenRepository>;
    svc = new TokensService(jwt, config, repo);
  });

  it('issues access + refresh tokens and persists refresh hashed', async () => {
    repo.create.mockResolvedValue({ id: 'r1' } as any);
    const result = await svc.issuePair({ userId: 'u1', role: 'tenant_owner', tenantId: 't1' });
    expect(result.accessToken).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        tokenHash: expect.any(String),
        expiresAt: expect.any(Date),
      }),
    );
    expect(repo.create.mock.calls[0][0].tokenHash).not.toBe(result.refreshToken);
  });

  it('verifies access token payload', async () => {
    repo.create.mockResolvedValue({ id: 'r1' } as any);
    const { accessToken } = await svc.issuePair({ userId: 'u1', role: 'customer' });
    const payload = await svc.verifyAccess(accessToken);
    expect(payload.sub).toBe('u1');
    expect(payload.role).toBe('customer');
  });
});
```

- [ ] **Step 4: Rodar e ver falhar**

Run:
```bash
npm test -- tokens.service
```
Expected: FAIL (`Cannot find module './tokens.service'`).

- [ ] **Step 5: Implementar TokensService**

Create `src/modules/auth/tokens.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import { RefreshTokenRepository } from './repositories/refresh-token.repository';

export type AccessPayload = {
  sub: string;
  role: string;
  tenantId?: string;
};

@Injectable()
export class TokensService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly repo: RefreshTokenRepository,
  ) {}

  async issuePair(input: { userId: string; role: string; tenantId?: string }) {
    const accessToken = await this.jwt.signAsync(
      { sub: input.userId, role: input.role, tenantId: input.tenantId } satisfies AccessPayload,
      {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: this.config.get<string>('JWT_ACCESS_TTL') ?? '15m',
      },
    );

    const refreshToken = randomBytes(48).toString('base64url');
    const tokenHash = this.hashRefresh(refreshToken);
    const ttlSeconds = this.parseTtl(this.config.get<string>('JWT_REFRESH_TTL') ?? '7d');
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    const stored = await this.repo.create({ userId: input.userId, tokenHash, expiresAt });

    return { accessToken, refreshToken, refreshTokenId: stored.id };
  }

  async verifyAccess(token: string): Promise<AccessPayload> {
    return this.jwt.verifyAsync<AccessPayload>(token, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
  }

  hashRefresh(plain: string): string {
    return createHash('sha256').update(plain).digest('hex');
  }

  private parseTtl(ttl: string): number {
    const m = ttl.match(/^(\d+)([smhd])$/);
    if (!m) throw new Error(`Invalid TTL: ${ttl}`);
    const n = Number(m[1]);
    return n * ({ s: 1, m: 60, h: 3600, d: 86400 } as Record<string, number>)[m[2]];
  }
}
```

- [ ] **Step 6: Rodar e ver passar**

Run:
```bash
npm test -- tokens.service
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(auth): add TokensService with JWT access + hashed refresh persistence"
```

---

## Task 17: OneTimeTokenService (email verify + password reset)

**Files:**
- Create: `src/modules/auth/one-time-token.service.ts`, `src/modules/auth/one-time-token.service.spec.ts`
- Create: `src/modules/auth/repositories/one-time-token.repository.ts`

- [ ] **Step 1: Criar OneTimeTokenRepository**

Create `src/modules/auth/repositories/one-time-token.repository.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { OneTimeTokenPurpose } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class OneTimeTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: {
    userId: string;
    purpose: OneTimeTokenPurpose;
    tokenHash: string;
    expiresAt: Date;
  }) {
    return this.prisma.oneTimeToken.create({ data });
  }

  findValidByHash(tokenHash: string, purpose: OneTimeTokenPurpose) {
    return this.prisma.oneTimeToken.findFirst({
      where: { tokenHash, purpose, usedAt: null, expiresAt: { gt: new Date() } },
    });
  }

  markUsed(id: string) {
    return this.prisma.oneTimeToken.update({ where: { id }, data: { usedAt: new Date() } });
  }
}
```

- [ ] **Step 2: Criar teste**

Create `src/modules/auth/one-time-token.service.spec.ts`:
```ts
import { OneTimeTokenService } from './one-time-token.service';
import { OneTimeTokenRepository } from './repositories/one-time-token.repository';

describe('OneTimeTokenService', () => {
  let svc: OneTimeTokenService;
  let repo: jest.Mocked<OneTimeTokenRepository>;

  beforeEach(() => {
    repo = {
      create: jest.fn().mockResolvedValue({ id: 'ott1' }),
      findValidByHash: jest.fn(),
      markUsed: jest.fn(),
    } as unknown as jest.Mocked<OneTimeTokenRepository>;
    svc = new OneTimeTokenService(repo);
  });

  it('issues a token, returns plain to caller, stores only hash', async () => {
    const { plain } = await svc.issue('u1', 'email_verification', 24 * 3600);
    expect(plain).toBeTruthy();
    const callArg = repo.create.mock.calls[0][0];
    expect(callArg.tokenHash).not.toBe(plain);
    expect(callArg.userId).toBe('u1');
    expect(callArg.purpose).toBe('email_verification');
  });

  it('consumes a valid token and marks it used', async () => {
    const { plain } = await svc.issue('u1', 'password_reset', 3600);
    repo.findValidByHash.mockResolvedValue({ id: 'ott2', userId: 'u1' } as any);
    const result = await svc.consume(plain, 'password_reset');
    expect(result?.userId).toBe('u1');
    expect(repo.markUsed).toHaveBeenCalledWith('ott2');
  });

  it('returns null when token is invalid/expired', async () => {
    repo.findValidByHash.mockResolvedValue(null);
    const result = await svc.consume('does-not-exist', 'password_reset');
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run:
```bash
npm test -- one-time-token
```
Expected: FAIL.

- [ ] **Step 4: Implementar OneTimeTokenService**

Create `src/modules/auth/one-time-token.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { OneTimeTokenPurpose } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { OneTimeTokenRepository } from './repositories/one-time-token.repository';

@Injectable()
export class OneTimeTokenService {
  constructor(private readonly repo: OneTimeTokenRepository) {}

  async issue(userId: string, purpose: OneTimeTokenPurpose, ttlSeconds: number) {
    const plain = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(plain).digest('hex');
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    await this.repo.create({ userId, purpose, tokenHash, expiresAt });
    return { plain };
  }

  async consume(plain: string, purpose: OneTimeTokenPurpose) {
    const tokenHash = createHash('sha256').update(plain).digest('hex');
    const found = await this.repo.findValidByHash(tokenHash, purpose);
    if (!found) return null;
    await this.repo.markUsed(found.id);
    return { userId: found.userId };
  }
}
```

- [ ] **Step 5: Rodar e ver passar**

Run:
```bash
npm test -- one-time-token
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(auth): add OneTimeTokenService for email verify and password reset"
```

---

## Task 18: NotificationsModule + ConsoleEmailProvider

**Files:**
- Create: `src/modules/notifications/email.provider.ts`
- Create: `src/modules/notifications/providers/console-email.provider.ts`
- Create: `src/modules/notifications/notifications.module.ts`

- [ ] **Step 1: Definir interface EmailProvider**

Create `src/modules/notifications/email.provider.ts`:
```ts
export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export interface EmailProvider {
  send(msg: EmailMessage): Promise<void>;
}
```

- [ ] **Step 2: Implementar ConsoleEmailProvider**

Create `src/modules/notifications/providers/console-email.provider.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
import { EmailMessage, EmailProvider } from '../email.provider';

@Injectable()
export class ConsoleEmailProvider implements EmailProvider {
  private readonly logger = new Logger(ConsoleEmailProvider.name);

  async send(msg: EmailMessage): Promise<void> {
    this.logger.log(`📧 [console-email] to=${msg.to} subject="${msg.subject}"`);
    this.logger.log(`-- body --\n${msg.text}\n--`);
  }
}
```

- [ ] **Step 3: Criar NotificationsModule**

Create `src/modules/notifications/notifications.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EMAIL_PROVIDER } from './email.provider';
import { ConsoleEmailProvider } from './providers/console-email.provider';

@Global()
@Module({
  providers: [
    {
      provide: EMAIL_PROVIDER,
      useFactory: (cfg: ConfigService) => {
        const provider = cfg.get<string>('EMAIL_PROVIDER');
        if (provider === 'console') return new ConsoleEmailProvider();
        // Fase 3 adicionará ResendEmailProvider aqui
        throw new Error(`Unsupported EMAIL_PROVIDER: ${provider}`);
      },
      inject: [ConfigService],
    },
  ],
  exports: [EMAIL_PROVIDER],
})
export class NotificationsModule {}
```

- [ ] **Step 4: Importar no AppModule**

Update `src/app.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './infra/prisma/prisma.module';
import { buildLoggerOptions } from './infra/logger/logger.config';
import { HealthModule } from './modules/health/health.module';
import { NotificationsModule } from './modules/notifications/notifications.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({ useFactory: () => buildLoggerOptions(process.env) }),
    PrismaModule,
    NotificationsModule,
    HealthModule,
  ],
})
export class AppModule {}
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(notifications): add EmailProvider interface and console provider"
```

---

## Task 19: Decoradores e Guards (JwtAuthGuard, RolesGuard, @Public, @CurrentUser, @CurrentTenant, @Roles)

**Files:**
- Create: `src/common/types/request-context.ts`
- Create: `src/common/decorators/public.decorator.ts`
- Create: `src/common/decorators/roles.decorator.ts`
- Create: `src/common/decorators/current-user.decorator.ts`
- Create: `src/common/decorators/current-tenant.decorator.ts`
- Create: `src/common/guards/jwt-auth.guard.ts`
- Create: `src/common/guards/roles.guard.ts`
- Create: `src/common/guards/jwt-auth.guard.spec.ts`
- Create: `src/common/guards/roles.guard.spec.ts`

- [ ] **Step 1: Tipos de request**

Create `src/common/types/request-context.ts`:
```ts
import { UserRole } from '@prisma/client';

export type AuthenticatedUser = {
  id: string;
  role: UserRole;
  tenantId?: string;
};

export type AuthenticatedRequest = {
  user?: AuthenticatedUser;
};
```

- [ ] **Step 2: @Public decorator**

Create `src/common/decorators/public.decorator.ts`:
```ts
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
```

- [ ] **Step 3: @Roles decorator**

Create `src/common/decorators/roles.decorator.ts`:
```ts
import { SetMetadata } from '@nestjs/common';
import { UserRole } from '@prisma/client';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
```

- [ ] **Step 4: @CurrentUser e @CurrentTenant**

Create `src/common/decorators/current-user.decorator.ts`:
```ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthenticatedRequest } from '../types/request-context';

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  return req.user;
});
```

Create `src/common/decorators/current-tenant.decorator.ts`:
```ts
import { createParamDecorator, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AuthenticatedRequest } from '../types/request-context';

export const CurrentTenant = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  const tenantId = req.user?.tenantId;
  if (!tenantId) throw new ForbiddenException('No tenant in context');
  return tenantId;
});
```

- [ ] **Step 5: Teste e implementação do JwtAuthGuard**

Create `src/common/guards/jwt-auth.guard.spec.ts`:
```ts
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import { TokensService } from 'src/modules/auth/tokens.service';

function makeCtx(authHeader?: string, isPublic = false): ExecutionContext {
  const reflectorMock = { getAllAndOverride: jest.fn().mockReturnValue(isPublic) };
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization: authHeader }, user: undefined as any }),
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
    _reflector: reflectorMock,
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let tokens: jest.Mocked<TokensService>;
  let reflector: jest.Mocked<Reflector>;

  beforeEach(() => {
    tokens = { verifyAccess: jest.fn() } as unknown as jest.Mocked<TokensService>;
    reflector = { getAllAndOverride: jest.fn() } as unknown as jest.Mocked<Reflector>;
    guard = new JwtAuthGuard(tokens, reflector);
  });

  it('allows when @Public', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    const ctx = makeCtx(undefined) as any;
    const ok = await guard.canActivate(ctx);
    expect(ok).toBe(true);
  });

  it('throws when missing header', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    const ctx = makeCtx(undefined) as any;
    await expect(guard.canActivate(ctx)).rejects.toThrow();
  });

  it('attaches user to request when valid', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    tokens.verifyAccess.mockResolvedValue({ sub: 'u1', role: 'tenant_owner' as any, tenantId: 't1' });
    const reqObj: any = { headers: { authorization: 'Bearer abc' } };
    const ctx = { switchToHttp: () => ({ getRequest: () => reqObj }), getHandler: () => ({}), getClass: () => ({}) } as any;
    const ok = await guard.canActivate(ctx);
    expect(ok).toBe(true);
    expect(reqObj.user).toEqual({ id: 'u1', role: 'tenant_owner', tenantId: 't1' });
  });
});
```

Create `src/common/guards/jwt-auth.guard.ts`:
```ts
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TokensService } from 'src/modules/auth/tokens.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AuthenticatedRequest } from '../types/request-context';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokensService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest & { headers: Record<string, string> }>();
    const header = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid Authorization header');
    }
    const token = header.slice('Bearer '.length);
    try {
      const payload = await this.tokens.verifyAccess(token);
      req.user = { id: payload.sub, role: payload.role as any, tenantId: payload.tenantId };
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }
}
```

- [ ] **Step 6: Teste e implementação do RolesGuard**

Create `src/common/guards/roles.guard.spec.ts`:
```ts
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { UserRole } from '@prisma/client';

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: jest.Mocked<Reflector>;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() } as unknown as jest.Mocked<Reflector>;
    guard = new RolesGuard(reflector);
  });

  function ctxFor(user: any): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
  }

  it('allows when no @Roles applied', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    expect(guard.canActivate(ctxFor({ role: 'customer' as UserRole }))).toBe(true);
  });

  it('blocks when user role not in list', () => {
    reflector.getAllAndOverride.mockReturnValue(['tenant_owner']);
    expect(() => guard.canActivate(ctxFor({ role: 'customer' as UserRole }))).toThrow();
  });

  it('allows when role matches', () => {
    reflector.getAllAndOverride.mockReturnValue(['tenant_owner']);
    expect(guard.canActivate(ctxFor({ role: 'tenant_owner' as UserRole }))).toBe(true);
  });
});
```

Create `src/common/guards/roles.guard.ts`:
```ts
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { AuthenticatedRequest } from '../types/request-context';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!req.user || !required.includes(req.user.role)) {
      throw new ForbiddenException('Role not permitted');
    }
    return true;
  }
}
```

- [ ] **Step 7: Rodar testes dos guards**

Run:
```bash
npm test -- guards
```
Expected: PASS em ambos os spec files.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(common): add JwtAuthGuard, RolesGuard, decorators for auth context"
```

---

## Task 20: PrismaService middleware de tenant isolation

**Files:**
- Modify: `src/infra/prisma/prisma.service.ts`
- Create: `src/infra/prisma/prisma.service.spec.ts` (integration — usa Postgres real do docker compose)

> **Nota importante:** Prisma a partir da v5.4 substitui `$use` por `$extends`. Vamos usar `$extends` para o middleware moderno.

- [ ] **Step 1: Atualizar PrismaService com extensão de tenant**

Replace `src/infra/prisma/prisma.service.ts`:
```ts
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'async_hooks';

export type TenantContext = { tenantId?: string };

export const tenantAls = new AsyncLocalStorage<TenantContext>();

const TENANT_SCOPED_MODELS = new Set<string>([
  // Conforme novas entidades forem adicionadas em fases seguintes, incluí-las aqui.
  // Em Fase 1, somente Subscription pertence a um tenant (Tenant não filtra por tenantId,
  // ele é o próprio tenant).
  'Subscription',
]);

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({ log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'] });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return tenantAls.run({ tenantId }, fn);
  }

  // O Prisma 5 expõe extensão de query. Filtragem automática por tenantId acontece aqui.
  // Como a extensão retorna um cliente novo, expomos um getter:
  get scoped() {
    return this.$extends({
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            const ctx = tenantAls.getStore();
            if (ctx?.tenantId && model && TENANT_SCOPED_MODELS.has(model)) {
              if (
                operation === 'findMany' ||
                operation === 'findFirst' ||
                operation === 'findFirstOrThrow' ||
                operation === 'findUnique' ||
                operation === 'findUniqueOrThrow' ||
                operation === 'count' ||
                operation === 'aggregate' ||
                operation === 'groupBy' ||
                operation === 'updateMany' ||
                operation === 'deleteMany'
              ) {
                args.where = { ...(args.where ?? {}), tenantId: ctx.tenantId };
              }
              if (operation === 'create') {
                args.data = { ...(args.data ?? {}), tenantId: ctx.tenantId };
              }
              if (operation === 'createMany') {
                const data = (args.data as Array<Record<string, unknown>>) ?? [];
                args.data = data.map((d) => ({ ...d, tenantId: ctx.tenantId }));
              }
              if (operation === 'update' || operation === 'delete') {
                args.where = { ...(args.where ?? {}), tenantId: ctx.tenantId };
              }
              if (operation === 'upsert') {
                args.where = { ...(args.where ?? {}), tenantId: ctx.tenantId };
                args.create = { ...(args.create ?? {}), tenantId: ctx.tenantId };
              }
            }
            return query(args);
          },
        },
      },
    });
  }
}
```

> **Decisão consciente:** o getter `scoped` retorna um cliente estendido pronto para queries com escopo de tenant. Repositórios que precisam de isolation usam `this.prisma.scoped.<model>...`, e o middleware tenant injeta `withTenant(...)` no boundary HTTP (Task 21).

- [ ] **Step 2: Verificar build**

Run:
```bash
npm run build
```
Expected: build OK.

- [ ] **Step 3: Commit (sem teste agora; cobertura virá em E2E de tenant isolation, Task 26)**

```bash
git add -A
git commit -m "feat(prisma): add tenant-scoped extension with AsyncLocalStorage"
```

---

## Task 21: TenantGuard + middleware Express que põe tenant no AsyncLocalStorage

**Files:**
- Create: `src/common/guards/tenant.guard.ts`
- Create: `src/common/guards/tenant.guard.spec.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Teste do TenantGuard**

Create `src/common/guards/tenant.guard.spec.ts`:
```ts
import { ExecutionContext } from '@nestjs/common';
import { TenantGuard } from './tenant.guard';

function makeCtx(user: any): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('TenantGuard', () => {
  const guard = new TenantGuard();

  it('blocks when user has no tenantId', () => {
    expect(() => guard.canActivate(makeCtx({ id: 'u1', role: 'tenant_owner' }))).toThrow();
  });

  it('allows when user has tenantId', () => {
    expect(guard.canActivate(makeCtx({ id: 'u1', role: 'tenant_owner', tenantId: 't1' }))).toBe(true);
  });
});
```

- [ ] **Step 2: Implementar TenantGuard**

Create `src/common/guards/tenant.guard.ts`:
```ts
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { AuthenticatedRequest } from '../types/request-context';

@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!req.user?.tenantId) {
      throw new ForbiddenException('Tenant scope required');
    }
    return true;
  }
}
```

- [ ] **Step 3: Middleware Express que entra no ALS por request**

In `src/main.ts`, ANTES de `app.useGlobalPipes(...)`, adicionar middleware:

```ts
import type { Request, Response, NextFunction } from 'express';
import { tenantAls } from './infra/prisma/prisma.service';

// ... dentro de bootstrap, antes de useGlobalPipes:
app.use((req: Request, _res: Response, next: NextFunction) => {
  // Roda toda a request dentro de um ALS scope. O tenantId é populado depois,
  // por um interceptor (ou pelo próprio Guard via decorator), ao consumir @CurrentTenant.
  tenantAls.run({}, () => next());
});
```

> Por que aqui no main.ts: o ALS precisa começar antes de qualquer await dentro do request handler. O tenantId vai ser preenchido pelo `JwtAuthGuard` quando atachar `req.user`, via setter abaixo.

In `src/common/guards/jwt-auth.guard.ts`, no método `canActivate`, **após** atribuir `req.user`, adicionar:
```ts
import { tenantAls } from 'src/infra/prisma/prisma.service';
// ...
const store = tenantAls.getStore();
if (store) store.tenantId = req.user.tenantId;
```

Isso preenche o ALS já mutado pra request inteira.

- [ ] **Step 4: Rodar teste do guard**

Run:
```bash
npm test -- tenant.guard
```
Expected: PASS (2 testes).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(common): add TenantGuard and AsyncLocalStorage middleware for tenant scoping"
```

---

## Task 22: Throttler global (rate limit em auth/login)

**Files:**
- Modify: `src/app.module.ts`
- Create: notes para uso em auth.controller.ts

- [ ] **Step 1: Instalar throttler**

Run:
```bash
npm install @nestjs/throttler@5
```

- [ ] **Step 2: Configurar no AppModule**

Update `src/app.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './infra/prisma/prisma.module';
import { buildLoggerOptions } from './infra/logger/logger.config';
import { HealthModule } from './modules/health/health.module';
import { NotificationsModule } from './modules/notifications/notifications.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({ useFactory: () => buildLoggerOptions(process.env) }),
    ThrottlerModule.forRoot([
      {
        ttl: Number(process.env.THROTTLE_TTL ?? 60) * 1000,
        limit: Number(process.env.THROTTLE_LIMIT ?? 10),
      },
    ]),
    PrismaModule,
    NotificationsModule,
    HealthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(common): enable global rate limiting with ThrottlerGuard"
```

---

## Task 23: AuthModule, DTOs, AuthController, AuthService — esqueleto

**Files:**
- Create: `src/modules/auth/dto/*.dto.ts` (6 arquivos)
- Create: `src/modules/auth/repositories/user.repository.ts`
- Create: `src/modules/auth/auth.service.ts`
- Create: `src/modules/auth/auth.controller.ts`
- Create: `src/modules/auth/auth.module.ts`
- Modify: `src/app.module.ts`

- [ ] **Step 1: Criar UserRepository**

Create `src/modules/auth/repositories/user.repository.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class UserRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByEmail(email: string) {
    return this.prisma.user.findUnique({ where: { email } });
  }

  findById(id: string) {
    return this.prisma.user.findUnique({ where: { id } });
  }

  create(data: { email: string; passwordHash: string; name: string; role: UserRole }) {
    return this.prisma.user.create({ data });
  }

  markEmailVerified(id: string) {
    return this.prisma.user.update({ where: { id }, data: { emailVerifiedAt: new Date() } });
  }

  updatePassword(id: string, passwordHash: string) {
    return this.prisma.user.update({ where: { id }, data: { passwordHash } });
  }
}
```

- [ ] **Step 2: DTOs**

Create `src/modules/auth/dto/register-owner.dto.ts`:
```ts
import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class RegisterOwnerDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(80)
  tenantName!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(30)
  @Matches(/^[a-z0-9-]+$/, { message: 'slug must match ^[a-z0-9-]+$' })
  slug!: string;
}
```

Create `src/modules/auth/dto/login.dto.ts`:
```ts
import { IsEmail, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}
```

Create `src/modules/auth/dto/refresh.dto.ts`:
```ts
import { IsString, MinLength } from 'class-validator';

export class RefreshDto {
  @IsString()
  @MinLength(20)
  refreshToken!: string;
}
```

Create `src/modules/auth/dto/logout.dto.ts`:
```ts
import { IsString, MinLength } from 'class-validator';

export class LogoutDto {
  @IsString()
  @MinLength(20)
  refreshToken!: string;
}
```

Create `src/modules/auth/dto/verify-email.dto.ts`:
```ts
import { IsString, MinLength } from 'class-validator';

export class VerifyEmailDto {
  @IsString()
  @MinLength(20)
  token!: string;
}
```

Create `src/modules/auth/dto/forgot-password.dto.ts`:
```ts
import { IsEmail } from 'class-validator';

export class ForgotPasswordDto {
  @IsEmail()
  email!: string;
}
```

Create `src/modules/auth/dto/reset-password.dto.ts`:
```ts
import { IsString, MinLength, MaxLength } from 'class-validator';

export class ResetPasswordDto {
  @IsString()
  @MinLength(20)
  token!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  newPassword!: string;
}
```

- [ ] **Step 3: Constantes de slugs reservados**

Create `src/modules/auth/reserved-slugs.ts`:
```ts
export const RESERVED_SLUGS = new Set<string>([
  'admin',
  'api',
  'app',
  'auth',
  'billing',
  'help',
  'login',
  'public',
  'register',
  'saas',
  'signup',
  'static',
  'support',
  'www',
]);
```

- [ ] **Step 4: AuthService (esqueleto vazio — implementa endpoint a endpoint nas tasks seguintes)**

Create `src/modules/auth/auth.service.ts`:
```ts
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OneTimeTokenPurpose, UserRole, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { EMAIL_PROVIDER, EmailProvider } from 'src/modules/notifications/email.provider';
import { PasswordService } from './password.service';
import { TokensService } from './tokens.service';
import { OneTimeTokenService } from './one-time-token.service';
import { UserRepository } from './repositories/user.repository';
import { RefreshTokenRepository } from './repositories/refresh-token.repository';
import { RegisterOwnerDto } from './dto/register-owner.dto';
import { RESERVED_SLUGS } from './reserved-slugs';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly password: PasswordService,
    private readonly tokens: TokensService,
    private readonly otts: OneTimeTokenService,
    private readonly users: UserRepository,
    private readonly refreshes: RefreshTokenRepository,
    private readonly config: ConfigService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
  ) {}

  async registerOwner(dto: RegisterOwnerDto) {
    if (RESERVED_SLUGS.has(dto.slug)) {
      throw new DomainException({
        code: ErrorCodes.SLUG_RESERVED,
        message: 'Slug reservado.',
        status: HttpStatus.CONFLICT,
      });
    }
    const existingEmail = await this.users.findByEmail(dto.email);
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
        data: { email: dto.email, passwordHash, name: dto.name, role: UserRole.tenant_owner },
      });
      const tenant = await tx.tenant.create({
        data: { slug: dto.slug, name: dto.tenantName, ownerUserId: user.id },
      });
      await tx.subscription.create({
        data: {
          tenantId: tenant.id,
          status: SubscriptionStatus.trialing,
          trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        },
      });
      return { user, tenant };
    });

    const pair = await this.tokens.issuePair({
      userId: user.id,
      role: user.role,
      tenantId: tenant.id,
    });

    const { plain } = await this.otts.issue(user.id, OneTimeTokenPurpose.email_verification, 24 * 3600);
    await this.email.send({
      to: user.email,
      subject: 'Confirme seu email no KairoBarber',
      text: `Olá ${user.name}! Confirme seu email com o token abaixo (válido por 24h):\n\n${plain}\n\nOu acesse: ${this.config.get('APP_URL')}/verify-email?token=${plain}`,
    });

    return { user, tenant, ...pair };
  }

  async login(email: string, plainPassword: string) {
    const user = await this.users.findByEmail(email);
    if (!user) {
      throw new DomainException({
        code: ErrorCodes.INVALID_CREDENTIALS,
        message: 'Credenciais inválidas.',
        status: HttpStatus.UNAUTHORIZED,
      });
    }
    const ok = await this.password.verify(user.passwordHash, plainPassword);
    if (!ok) {
      throw new DomainException({
        code: ErrorCodes.INVALID_CREDENTIALS,
        message: 'Credenciais inválidas.',
        status: HttpStatus.UNAUTHORIZED,
      });
    }

    const tenant = await this.prisma.tenant.findUnique({ where: { ownerUserId: user.id } });
    const pair = await this.tokens.issuePair({
      userId: user.id,
      role: user.role,
      tenantId: tenant?.id,
    });
    return { user, ...pair };
  }

  async refresh(plainRefresh: string) {
    const tokenHash = this.tokens.hashRefresh(plainRefresh);
    const stored = await this.refreshes.findByHash(tokenHash);

    if (!stored) {
      throw new DomainException({
        code: ErrorCodes.TOKEN_INVALID,
        message: 'Refresh token inválido.',
        status: HttpStatus.UNAUTHORIZED,
      });
    }
    if (stored.expiresAt < new Date()) {
      throw new DomainException({
        code: ErrorCodes.TOKEN_EXPIRED,
        message: 'Refresh token expirado.',
        status: HttpStatus.UNAUTHORIZED,
      });
    }
    if (stored.revokedAt) {
      // detected reuse — revoga toda a família e força login
      await this.refreshes.revokeAllForUser(stored.userId);
      throw new DomainException({
        code: ErrorCodes.REFRESH_REUSED,
        message: 'Refresh token reutilizado. Faça login novamente.',
        status: HttpStatus.UNAUTHORIZED,
      });
    }

    const user = await this.users.findById(stored.userId);
    if (!user) {
      throw new DomainException({
        code: ErrorCodes.TOKEN_INVALID,
        message: 'Usuário não encontrado.',
        status: HttpStatus.UNAUTHORIZED,
      });
    }

    const tenant = await this.prisma.tenant.findUnique({ where: { ownerUserId: user.id } });
    const pair = await this.tokens.issuePair({
      userId: user.id,
      role: user.role,
      tenantId: tenant?.id,
    });
    await this.refreshes.rotate(stored.id, pair.refreshTokenId);
    return pair;
  }

  async logout(plainRefresh: string) {
    const tokenHash = this.tokens.hashRefresh(plainRefresh);
    const stored = await this.refreshes.findByHash(tokenHash);
    if (stored && !stored.revokedAt) {
      await this.refreshes.rotate(stored.id, stored.id); // revoke without replacement
    }
  }

  async verifyEmail(token: string) {
    const result = await this.otts.consume(token, OneTimeTokenPurpose.email_verification);
    if (!result) {
      throw new DomainException({
        code: ErrorCodes.TOKEN_INVALID,
        message: 'Token de verificação inválido ou expirado.',
        status: HttpStatus.BAD_REQUEST,
      });
    }
    await this.users.markEmailVerified(result.userId);
  }

  async forgotPassword(email: string) {
    const user = await this.users.findByEmail(email);
    // Anti-enumeration: sempre retorna sucesso. Só envia email se existe.
    if (!user) return;
    const { plain } = await this.otts.issue(user.id, OneTimeTokenPurpose.password_reset, 3600);
    await this.email.send({
      to: user.email,
      subject: 'Redefinição de senha — KairoBarber',
      text: `Use o token abaixo para redefinir sua senha (válido por 1 hora):\n\n${plain}\n\nOu acesse: ${this.config.get('APP_URL')}/reset-password?token=${plain}`,
    });
  }

  async resetPassword(token: string, newPassword: string) {
    const result = await this.otts.consume(token, OneTimeTokenPurpose.password_reset);
    if (!result) {
      throw new DomainException({
        code: ErrorCodes.TOKEN_INVALID,
        message: 'Token de reset inválido ou expirado.',
        status: HttpStatus.BAD_REQUEST,
      });
    }
    const passwordHash = await this.password.hash(newPassword);
    await this.users.updatePassword(result.userId, passwordHash);
    await this.refreshes.revokeAllForUser(result.userId);
  }
}
```

> Decisão: `logout` revoga o próprio refresh setando `revokedAt`. A função `rotate(oldId, oldId)` revoga sem trocar — comportamento OK aqui. Em refresh de verdade, geramos um novo `refreshTokenId` e passamos como `newId`.

- [ ] **Step 5: AuthController**

Create `src/modules/auth/auth.controller.ts`:
```ts
import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from 'src/common/decorators/public.decorator';
import { AuthService } from './auth.service';
import { RegisterOwnerDto } from './dto/register-owner.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { LogoutDto } from './dto/logout.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
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

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto) {
    const r = await this.auth.login(dto.email, dto.password);
    return {
      user: { id: r.user.id, email: r.user.email, name: r.user.name, role: r.user.role },
      accessToken: r.accessToken,
      refreshToken: r.refreshToken,
    };
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() dto: RefreshDto) {
    const r = await this.auth.refresh(dto.refreshToken);
    return { accessToken: r.accessToken, refreshToken: r.refreshToken };
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Body() dto: LogoutDto) {
    await this.auth.logout(dto.refreshToken);
  }

  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.NO_CONTENT)
  async verifyEmail(@Body() dto: VerifyEmailDto) {
    await this.auth.verifyEmail(dto.token);
  }

  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('forgot-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.auth.forgotPassword(dto.email);
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.auth.resetPassword(dto.token, dto.newPassword);
  }
}
```

- [ ] **Step 6: AuthModule**

Create `src/modules/auth/auth.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { TokensService } from './tokens.service';
import { OneTimeTokenService } from './one-time-token.service';
import { UserRepository } from './repositories/user.repository';
import { RefreshTokenRepository } from './repositories/refresh-token.repository';
import { OneTimeTokenRepository } from './repositories/one-time-token.repository';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';

@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    TokensService,
    OneTimeTokenService,
    UserRepository,
    RefreshTokenRepository,
    OneTimeTokenRepository,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [TokensService],
})
export class AuthModule {}
```

> Decisão: registramos `JwtAuthGuard` como **global APP_GUARD** dentro do AuthModule. Significa que qualquer rota não marcada com `@Public()` exige token. É o oposto do default do Nest — preferimos "deny by default".

- [ ] **Step 7: Importar AuthModule no AppModule**

Update `src/app.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './infra/prisma/prisma.module';
import { buildLoggerOptions } from './infra/logger/logger.config';
import { HealthModule } from './modules/health/health.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { AuthModule } from './modules/auth/auth.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({ useFactory: () => buildLoggerOptions(process.env) }),
    ThrottlerModule.forRoot([
      {
        ttl: Number(process.env.THROTTLE_TTL ?? 60) * 1000,
        limit: Number(process.env.THROTTLE_LIMIT ?? 10),
      },
    ]),
    PrismaModule,
    NotificationsModule,
    AuthModule,
    HealthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
```

- [ ] **Step 8: Build + boot pra verificar**

Run:
```bash
npm run build
npm run start
```
Expected: sobe sem erros. Para com `Ctrl+C`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(auth): wire AuthModule with registerOwner, login, refresh, logout, verify-email, forgot/reset password"
```

---

## Task 24: Tenants module — GET /admin/tenant

**Files:**
- Create: `src/modules/tenants/tenants.module.ts`
- Create: `src/modules/tenants/tenants.controller.ts`
- Create: `src/modules/tenants/tenants.service.ts`
- Create: `src/modules/tenants/repositories/tenant.repository.ts`
- Modify: `src/app.module.ts`

- [ ] **Step 1: TenantRepository**

Create `src/modules/tenants/repositories/tenant.repository.ts`:
```ts
import { Injectable } from '@nestjs/common';
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
}
```

- [ ] **Step 2: TenantsService**

Create `src/modules/tenants/tenants.service.ts`:
```ts
import { HttpStatus, Injectable } from '@nestjs/common';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { TenantRepository } from './repositories/tenant.repository';

@Injectable()
export class TenantsService {
  constructor(private readonly repo: TenantRepository) {}

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
}
```

- [ ] **Step 3: TenantsController**

Create `src/modules/tenants/tenants.controller.ts`:
```ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import { TenantGuard } from 'src/common/guards/tenant.guard';
import { CurrentTenant } from 'src/common/decorators/current-tenant.decorator';
import { TenantsService } from './tenants.service';

@Controller('admin/tenant')
@UseGuards(TenantGuard)
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Get()
  async getCurrent(@CurrentTenant() tenantId: string) {
    const t = await this.tenants.getCurrent(tenantId);
    return {
      id: t.id,
      slug: t.slug,
      name: t.name,
      timezone: t.timezone,
      subscription: t.subscription
        ? {
            status: t.subscription.status,
            trialEndsAt: t.subscription.trialEndsAt,
            currentPeriodEnd: t.subscription.currentPeriodEnd,
          }
        : null,
    };
  }
}
```

- [ ] **Step 4: TenantsModule**

Create `src/modules/tenants/tenants.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';
import { TenantRepository } from './repositories/tenant.repository';

@Module({
  controllers: [TenantsController],
  providers: [TenantsService, TenantRepository],
})
export class TenantsModule {}
```

- [ ] **Step 5: Importar no AppModule**

Update `src/app.module.ts`: adicionar `TenantsModule` ao `imports`:
```ts
import { TenantsModule } from './modules/tenants/tenants.module';
// ...
imports: [
  // ...existentes...
  TenantsModule,
],
```

- [ ] **Step 6: Build + boot rápido**

Run:
```bash
npm run build
```
Expected: build OK.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(tenants): add GET /admin/tenant endpoint behind TenantGuard"
```

---

## Task 25: E2E onboarding completo

**Files:**
- Create: `test/support/test-app.ts`
- Create: `test/support/postgres-container.ts`
- Create: `test/e2e/auth-onboarding.e2e-spec.ts`

> **Decisão:** usar testcontainers/postgresql pra subir um Postgres efêmero por suite. Garante isolation total e CI consistente. Slower que reaproveitar o container do docker compose mas mais confiável.

- [ ] **Step 1: Instalar testcontainers**

Run:
```bash
npm install -D testcontainers@10 @testcontainers/postgresql@10
```

- [ ] **Step 2: Wrapper de container Postgres pra testes**

Create `test/support/postgres-container.ts`:
```ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'child_process';

export async function startTestPostgres(): Promise<StartedPostgreSqlContainer> {
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('kairobarber_test')
    .withUsername('test')
    .withPassword('test')
    .start();

  const url = container.getConnectionUri();
  process.env.DATABASE_URL = url;

  // Aplicar schema via prisma migrate deploy
  execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' });

  return container;
}
```

- [ ] **Step 3: Helper de Nest app pra testes**

Create `test/support/test-app.ts`:
```ts
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from 'src/app.module';
import { GlobalExceptionFilter } from 'src/common/filters/global-exception.filter';

export async function buildTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
  return app;
}
```

- [ ] **Step 4: Garantir env mínimo pra testes**

Create `test/support/test-env.ts`:
```ts
export function setTestEnv() {
  process.env.NODE_ENV = 'test';
  process.env.PORT = '0';
  process.env.APP_URL = 'http://localhost';
  process.env.JWT_ACCESS_SECRET = 'a'.repeat(40);
  process.env.JWT_REFRESH_SECRET = 'b'.repeat(40);
  process.env.JWT_ACCESS_TTL = '15m';
  process.env.JWT_REFRESH_TTL = '7d';
  process.env.EMAIL_PROVIDER = 'console';
  process.env.EMAIL_FROM = 'noreply@kairobarber.test';
  process.env.LOG_LEVEL = 'fatal';
}
```

- [ ] **Step 5: Teste E2E de onboarding**

Create `test/e2e/auth-onboarding.e2e-spec.ts`:
```ts
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';

describe('Onboarding completo (e2e)', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    setTestEnv();
    container = await startTestPostgres();
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('registers owner, returns tokens, GET /admin/tenant works', async () => {
    const register = await request(app.getHttpServer())
      .post('/auth/register/owner')
      .send({
        email: 'gugu@example.com',
        password: 'StrongPass!1',
        name: 'Gugu',
        tenantName: 'Gugu Barbeiro',
        slug: 'gugubarbeiro',
      })
      .expect(201);

    expect(register.body.user.email).toBe('gugu@example.com');
    expect(register.body.tenant.slug).toBe('gugubarbeiro');
    expect(register.body.accessToken).toBeTruthy();
    expect(register.body.refreshToken).toBeTruthy();

    const token = register.body.accessToken;

    const tenant = await request(app.getHttpServer())
      .get('/admin/tenant')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(tenant.body.slug).toBe('gugubarbeiro');
    expect(tenant.body.subscription.status).toBe('trialing');
    expect(new Date(tenant.body.subscription.trialEndsAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects duplicate slug', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/register/owner')
      .send({
        email: 'other@example.com',
        password: 'StrongPass!1',
        name: 'Outro',
        tenantName: 'Outra Barbearia',
        slug: 'gugubarbeiro',
      })
      .expect(409);
    expect(res.body.code).toBe('SLUG_TAKEN');
  });

  it('rejects reserved slug', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/register/owner')
      .send({
        email: 'admin@example.com',
        password: 'StrongPass!1',
        name: 'Admin',
        tenantName: 'Admin Barbearia',
        slug: 'admin',
      })
      .expect(409);
    expect(res.body.code).toBe('SLUG_RESERVED');
  });

  it('login + refresh works end-to-end', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'gugu@example.com', password: 'StrongPass!1' })
      .expect(200);
    expect(login.body.accessToken).toBeTruthy();
    const refresh = login.body.refreshToken;

    const refreshed = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: refresh })
      .expect(200);
    expect(refreshed.body.accessToken).toBeTruthy();
    expect(refreshed.body.refreshToken).not.toBe(refresh);
  });

  it('reuse of rotated refresh token is detected and revoked', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'gugu@example.com', password: 'StrongPass!1' })
      .expect(200);
    const refresh = login.body.refreshToken;

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: refresh })
      .expect(200);

    // Tentar usar o mesmo refresh de novo
    const reuse = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: refresh })
      .expect(401);
    expect(reuse.body.code).toBe('REFRESH_REUSED');
  });
});
```

- [ ] **Step 6: Rodar E2E**

Run:
```bash
npm run test:e2e -- auth-onboarding
```
Expected: PASS em todos os casos. Demora ~30s na primeira execução (pull do Postgres no Docker).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "test(e2e): cover full onboarding flow including refresh rotation and reuse detection"
```

---

## Task 26: E2E de regressão de tenant isolation (CRÍTICO)

**Files:**
- Create: `test/e2e/tenant-isolation.e2e-spec.ts`

> Este teste prova que o middleware de tenant isolation funciona. **Não pode ser flaky e nunca pode ser pulado em CI.**

- [ ] **Step 1: Adicionar uso real do `prisma.scoped` em algum repositório**

Como na Fase 1 a única entidade tenant-scoped é `Subscription`, criamos uma rota helper de teste pra validar leitura escopada. Adicionar no `TenantsService`:

Update `src/modules/tenants/tenants.service.ts`:
```ts
import { HttpStatus, Injectable } from '@nestjs/common';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { TenantRepository } from './repositories/tenant.repository';

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

  /**
   * Demonstra leitura de subscriptions filtrada por tenant pelo middleware.
   * Em produção/Fase futura, NUNCA deve retornar subscriptions de outros tenants.
   */
  listMySubscription() {
    return this.prisma.scoped.subscription.findMany({});
  }
}
```

Update `src/modules/tenants/tenants.controller.ts` — adicionar rota:
```ts
@Get('subscription-debug')
async listMy(@CurrentTenant() _tenantId: string) {
  // _tenantId é ignorado: o middleware já filtra. O parâmetro existe só pra forçar TenantGuard.
  return this.tenants.listMySubscription();
}
```

- [ ] **Step 2: Teste E2E**

Create `test/e2e/tenant-isolation.e2e-spec.ts`:
```ts
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';

describe('Tenant Isolation (e2e) — CRÍTICO', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;

  let tokenA: string;
  let tenantAId: string;
  let tokenB: string;
  let tenantBId: string;

  beforeAll(async () => {
    setTestEnv();
    container = await startTestPostgres();
    app = await buildTestApp();

    const ra = await request(app.getHttpServer()).post('/auth/register/owner').send({
      email: 'a@example.com',
      password: 'StrongPass!1',
      name: 'A',
      tenantName: 'Barbearia A',
      slug: 'barbearia-a',
    });
    tokenA = ra.body.accessToken;
    tenantAId = ra.body.tenant.id;

    const rb = await request(app.getHttpServer()).post('/auth/register/owner').send({
      email: 'b@example.com',
      password: 'StrongPass!1',
      name: 'B',
      tenantName: 'Barbearia B',
      slug: 'barbearia-b',
    });
    tokenB = rb.body.accessToken;
    tenantBId = rb.body.tenant.id;
  });

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('tenant A only sees its own subscription via scoped middleware', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/tenant/subscription-debug')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].tenantId).toBe(tenantAId);
  });

  it('tenant B only sees its own subscription', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/tenant/subscription-debug')
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].tenantId).toBe(tenantBId);
  });

  it('GET /admin/tenant of A does not leak data of B (and vice-versa)', async () => {
    const a = await request(app.getHttpServer())
      .get('/admin/tenant')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    const b = await request(app.getHttpServer())
      .get('/admin/tenant')
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(200);
    expect(a.body.id).toBe(tenantAId);
    expect(b.body.id).toBe(tenantBId);
    expect(a.body.slug).not.toBe(b.body.slug);
  });

  it('no auth header → 401 on /admin/tenant', async () => {
    const res = await request(app.getHttpServer()).get('/admin/tenant').expect(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });
});
```

- [ ] **Step 3: Rodar**

Run:
```bash
npm run test:e2e -- tenant-isolation
```
Expected: PASS em todos os 4 testes.

- [ ] **Step 4: Rodar todo o suite final pra confirmar**

Run:
```bash
npm run lint
npm test
npm run test:e2e
```
Expected: tudo verde.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test(e2e): add critical tenant isolation regression suite"
```

---

## Task 27: Atualizar CI workflow (Prisma generate antes de testes)

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Garantir que CI gera client + roda migrations antes dos testes**

O workflow criado na Task 10 já tem `prisma generate` e `migrate deploy`. Confira que os passos estão na ordem:
1. `npm ci`
2. `npx prisma generate`
3. `npx prisma migrate deploy`
4. `npm run lint`
5. `npm test`
6. `npm run test:e2e`
7. `npm run build`

> Se `npm run test:e2e` falhar no CI por falta de Docker dentro do GitHub Actions runner: os runners hosted (ubuntu-latest) **têm Docker**, então `testcontainers` funciona. Se for runner self-hosted, validar separadamente.

- [ ] **Step 2: Commit (caso tenha alterado)**

```bash
git add .github/
git commit -m "ci: ensure prisma generate + migrate run before test phases"
```

---

## Task 28: Push e validar deploy no Railway

> Esta task é manual — não tem automação local. Documentada pra completude do critério da Fase 0.

- [ ] **Step 1: Criar repositório no GitHub e push**

Substitua `<your-username>` pelo seu user:
```bash
git remote add origin git@github.com:<your-username>/kairobarber.git
git push -u origin main
```

- [ ] **Step 2: Configurar Railway**

1. Acesse [railway.app](https://railway.app) → New Project → Deploy from GitHub repo.
2. Selecione o repo `kairobarber`.
3. Adicione um plugin Postgres no projeto.
4. Em "Variables" do serviço da API, configure:
   - `NODE_ENV=production`
   - `APP_URL=https://<seu-dominio-railway>.up.railway.app`
   - `JWT_ACCESS_SECRET=<gerar 40+ chars aleatórios>`
   - `JWT_REFRESH_SECRET=<gerar 40+ chars aleatórios>`
   - `EMAIL_PROVIDER=console`
   - `EMAIL_FROM=noreply@kairobarber.com.br`
   - `DATABASE_URL=${{Postgres.DATABASE_URL}}` (referência ao plugin Postgres)
   - `LOG_LEVEL=info`
5. Deploy automático dispara no primeiro push.

- [ ] **Step 3: Verificar healthcheck**

Após o deploy verde, acesse:
```
https://<seu-dominio>.up.railway.app/health/ready
```
Expected: `200 OK` com `{ "status": "ok", "info": { "database": { "status": "up" } } }`.

- [ ] **Step 4: (Sem commit, é só verificação)**

---

## Critério de aceite final das Fases 0 + 1

Todos esses checks têm que passar antes de considerar a Fase 1 concluída:

- [ ] `npm install && docker compose up -d postgres && npm run start:dev` sobe a API local com 1 comando após `cp .env.example .env`.
- [ ] `npm run lint` zero erros.
- [ ] `npm test` todos os unit tests verdes.
- [ ] `npm run test:e2e` `auth-onboarding` e `tenant-isolation` verdes.
- [ ] `npm run build` sem erro.
- [ ] CI no GitHub Actions verde em PR contra `main`.
- [ ] Deploy no Railway responde 200 em `/health/ready`.
- [ ] Dois tenants podem ser criados via `POST /auth/register/owner` e cada um só enxerga os próprios dados via `GET /admin/tenant` e `/admin/tenant/subscription-debug`.

---

## Self-Review (executado pelo autor do plano antes de entregar)

**Cobertura da spec — Fase 0:**
- Setup NestJS, Prisma, ESLint, Prettier, Jest → Tasks 1-3, 5. ✓
- Docker Compose dev (Postgres) → Task 4. ✓ (Redis não entra na Fase 0 — Redis só na Fase 3, conforme spec.)
- CI básico GitHub Actions → Task 10. ✓
- Deploy automatizado Railway → Tasks 12, 28. ✓
- Logging estruturado → Task 7. ✓
- Healthchecks → Task 8. ✓
- Sentry → Task 11. ✓
- .env schema validado → Task 6. ✓

**Cobertura da spec — Fase 1:**
- Módulos auth, tenants, common → Tasks 19, 21, 23, 24. ✓
- TenantGuard, RolesGuard, PrismaMiddleware → Tasks 19, 20, 21. ✓
- Entidades User, Tenant, Subscription (trialing no signup) → Task 14, 23. ✓
- Endpoints `/auth/*` completos → Task 23 (registerOwner, login, refresh, logout, verify-email, forgot-password, reset-password). ✓
- `GET /admin/tenant` autenticado → Task 24. ✓
- Tenant isolation testada → Task 26. ✓

**Placeholders:** nenhum. Todos os trechos têm código real.

**Consistência de tipos:** `AuthenticatedUser`, `AccessPayload`, `EmailMessage`, `TenantContext` são usados consistentemente. Repositórios chamam os mesmos nomes de método entre service e implementação (`findByEmail`, `findById`, `findByHash`, `rotate`, etc).

**Pontos a destacar para o executor:**
- Tasks 19-21 são interdependentes: Guards consumem `TokensService` e ALS exportado de `PrismaService`. Implementar na ordem.
- Task 25 (E2E onboarding) cobre o "vai e vem completo"; se algo na implementação dos endpoints falhar, esse teste vai pegar.
- Task 26 (Tenant Isolation) é o **gate de segurança** — não merge sem ele verde.

---

## Próximos passos após este plano

Quando todos os critérios de aceite estiverem verdes, gere o plano da **Fase 2** (Painel do barbeiro: barbers, services, photos, business hours) invocando `superpowers:writing-plans` novamente, passando como argumento a Fase 2 da spec.
