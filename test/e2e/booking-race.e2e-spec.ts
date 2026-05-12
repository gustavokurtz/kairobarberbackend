import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AppointmentsService } from 'src/modules/scheduling/appointments.service';
import { setTestEnv } from '../support/test-env';
import { startTestPostgres } from '../support/postgres-container';
import { buildTestApp } from '../support/test-app';

interface Ctx {
  tenantId: string;
  barberId: string;
  serviceId: string;
  customerAId: string;
  customerBId: string;
}

describe('AppointmentsService — race condition (e2e integration)', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaService;
  let appointments: AppointmentsService;
  let ctx: Ctx;

  beforeAll(async () => {
    setTestEnv();
    container = await startTestPostgres();
    app = await buildTestApp();
    prisma = app.get(PrismaService);
    appointments = app.get(AppointmentsService);

    // Direct Prisma writes for fixture (bypass HTTP layer — faster setup).
    const user = await prisma.user.create({
      data: {
        email: `dono+${Date.now()}@x.com`,
        name: 'D',
        passwordHash: 'x',
        role: 'tenant_owner',
      },
    });
    const tenant = await prisma.tenant.create({
      data: { slug: `race-${Date.now()}`, name: 'T', ownerUserId: user.id },
    });
    await prisma.subscription.create({
      data: {
        tenantId: tenant.id,
        status: 'active',
        trialEndsAt: new Date(Date.now() + 86_400_000),
      },
    });
    const barber = await prisma.barber.create({
      data: { tenantId: tenant.id, displayName: 'B', active: true },
    });
    const service = await prisma.service.create({
      data: {
        tenantId: tenant.id,
        name: 'Corte',
        durationMin: 30,
        priceCents: 1000,
        active: true,
      },
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
      tenantId: tenant.id,
      barberId: barber.id,
      serviceId: service.id,
      customerAId: customerA.id,
      customerBId: customerB.id,
    };
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await container?.stop();
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
    const reason = rejected[0].reason as {
      response?: { code?: string };
    };
    expect(reason.response?.code).toBe('APPOINTMENT_SLOT_TAKEN');
  });
});
