import { Request, Response } from 'express';
import { PrismaService, tenantAls } from 'src/infra/prisma/prisma.service';
import { PublicTenantMiddleware } from './public-tenant.middleware';

type FindFirstReturn = {
  id: string;
  slug: string;
  deletedAt: Date | null;
  suspendedAt?: Date | null;
  subscription: { status: string } | null;
} | null;

function buildPrisma(findFirstReturn: FindFirstReturn) {
  return {
    tenant: { findFirst: jest.fn().mockResolvedValue(findFirstReturn) },
  } as unknown as PrismaService;
}

function makeReq(slug: string): Request {
  return { params: { slug }, url: `/public/${slug}/anything` } as unknown as Request;
}
function makeRes(): Response {
  return {} as Response;
}

describe('PublicTenantMiddleware', () => {
  it('seta tenantId no ALS quando tenant existe e está ativo', async () => {
    const mw = new PublicTenantMiddleware(
      buildPrisma({
        id: 't1',
        slug: 'acme',
        deletedAt: null,
        subscription: { status: 'active' },
      }),
    );

    let capturedTenantId: string | undefined;
    await new Promise<void>((resolve, reject) => {
      tenantAls.run({}, () => {
        void mw.use(makeReq('acme'), makeRes(), (err?: unknown) => {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          if (err) return reject(err);
          capturedTenantId = tenantAls.getStore()?.tenantId;
          resolve();
        });
      });
    });
    expect(capturedTenantId).toBe('t1');
  });

  it('404 quando tenant não existe', async () => {
    const mw = new PublicTenantMiddleware(buildPrisma(null));
    const err = await new Promise<unknown>((resolve) => {
      tenantAls.run({}, () => {
        void mw.use(makeReq('inexistente'), makeRes(), (e?: unknown) => resolve(e));
      });
    });
    expect(err).toMatchObject({ status: 404 });
  });

  it('404 quando tenant tem subscription cancelled', async () => {
    const mw = new PublicTenantMiddleware(
      buildPrisma({
        id: 't1',
        slug: 'acme',
        deletedAt: null,
        subscription: { status: 'cancelled' },
      }),
    );
    const err = await new Promise<unknown>((resolve) => {
      tenantAls.run({}, () => {
        void mw.use(makeReq('acme'), makeRes(), (e?: unknown) => resolve(e));
      });
    });
    expect(err).toMatchObject({ status: 404 });
  });

  it('retorna 404 quando tenant está suspended (suspendedAt != null)', async () => {
    const mw = new PublicTenantMiddleware(
      buildPrisma({
        id: 't1',
        slug: 'mybarber',
        deletedAt: null,
        suspendedAt: new Date(),
        subscription: { status: 'active' },
      }),
    );
    const err = await new Promise<unknown>((resolve) => {
      tenantAls.run({}, () => {
        void mw.use(makeReq('mybarber'), makeRes(), (e?: unknown) => resolve(e));
      });
    });
    expect(err).toMatchObject({ opts: { code: 'TENANT_NOT_FOUND', status: 404 } });
  });
});
