# syntax=docker/dockerfile:1.6

FROM node:20-alpine AS base
# openssl: o Prisma engine precisa pra rodar contra Postgres TLS.
# ca-certificates: handshake com R2/Asaas/MP/Resend.
RUN apk add --no-cache openssl ca-certificates
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm exec prisma generate
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production
# Copia node_modules pronto (com prisma CLI + client gerado) do stage build.
# Alternativa "pnpm install --prod" quebra porque o prisma CLI é devDependency.
# --chown=node:node pra Prisma conseguir escrever engines em runtime.
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/node_modules ./node_modules
# src/ só é necessário pro ts-node do prisma/seed.ts em runtime (importa audit-actions).
COPY --from=build --chown=node:node /app/src ./src
COPY --chown=node:node package.json pnpm-lock.yaml .npmrc tsconfig.json tsconfig.build.json ./
USER node
EXPOSE 3000
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && node dist/main.js"]
