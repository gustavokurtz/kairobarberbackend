import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'async_hooks';

export type TenantContext = { tenantId?: string };

export const tenantAls = new AsyncLocalStorage<TenantContext>();

const TENANT_SCOPED_MODELS = new Set<string>([
  // In Fase 1, only Subscription belongs to a tenant.
  // Tenant itself is the tenant (no self-filtering).
  // Future phases will add: Barber, Service, Photo, Customer, Appointment, AiConsultation, etc.
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

  /**
   * Run a function within a tenant scope. All queries via `this.scoped` inside the callback
   * will be auto-filtered by tenantId.
   */
  withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return tenantAls.run({ tenantId }, fn);
  }

  /**
   * Returns a Prisma client extended with automatic tenantId filtering for TENANT_SCOPED_MODELS.
   * Reads tenantId from the AsyncLocalStorage context populated by withTenant() or by the
   * middleware in main.ts.
   */
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
                const a = args;
                a.where = { ...(a.where ?? {}), tenantId: ctx.tenantId };
              }
              if (operation === 'create') {
                const a = args as { data?: Record<string, unknown> };
                a.data = { ...(a.data ?? {}), tenantId: ctx.tenantId };
              }
              if (operation === 'createMany') {
                const a = args as {
                  data?: Array<Record<string, unknown>> | Record<string, unknown>;
                };
                const data = Array.isArray(a.data) ? a.data : [a.data ?? {}];
                a.data = data.map((d) => ({ ...d, tenantId: ctx.tenantId }));
              }
              if (operation === 'update' || operation === 'delete') {
                const a = args as { where?: Record<string, unknown> };
                a.where = { ...(a.where ?? {}), tenantId: ctx.tenantId };
              }
              if (operation === 'upsert') {
                const a = args as {
                  where?: Record<string, unknown>;
                  create?: Record<string, unknown>;
                };
                a.where = { ...(a.where ?? {}), tenantId: ctx.tenantId };
                a.create = { ...(a.create ?? {}), tenantId: ctx.tenantId };
              }
            }
            return query(args);
          },
        },
      },
    });
  }
}

// Ensure Prisma type re-export for callers that need transactions or batch operations.
export { Prisma };
