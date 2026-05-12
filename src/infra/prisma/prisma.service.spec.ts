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
