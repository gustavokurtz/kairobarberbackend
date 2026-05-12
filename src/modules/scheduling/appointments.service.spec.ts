import { HttpStatus } from '@nestjs/common';
import { AppointmentSource, AppointmentStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { BarbersService } from 'src/modules/barbers/barbers.service';
import { ServicesService } from 'src/modules/catalog/services.service';
import { AppointmentsService } from './appointments.service';
import { AppointmentRepository } from './repositories/appointment.repository';

function makeTx(overlapRows: Array<{ id: string }> = []) {
  return {
    $queryRawUnsafe: jest.fn().mockResolvedValue(overlapRows),
    appointment: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'apt1', ...data }),
      ),
    },
  };
}

function mockDeps() {
  const repo = {
    findById: jest.fn(),
    update: jest.fn(),
    updateStatus: jest.fn(),
    findActiveForBarberInRange: jest.fn(),
    listForRange: jest.fn(),
    findByCancellationTokenHash: jest.fn(),
  } as unknown as jest.Mocked<AppointmentRepository>;

  const prisma = {
    $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(makeTx())),
  } as unknown as jest.Mocked<PrismaService>;

  const services = {
    getById: jest.fn(),
  } as unknown as jest.Mocked<ServicesService>;

  const barbers = {
    getById: jest.fn(),
  } as unknown as jest.Mocked<BarbersService>;

  return { repo, prisma, services, barbers };
}

describe('AppointmentsService.createPublicBooking', () => {
  const validInput = {
    serviceId: 'srv1',
    barberId: 'b1',
    startsAt: new Date('2030-05-12T15:00:00Z'),
    customer: { id: 'c1' },
  };

  it('cria appointment com snapshots e status pending para storefront', async () => {
    const deps = mockDeps();
    deps.services.getById.mockResolvedValue({
      id: 'srv1',
      durationMin: 30,
      priceCents: 4500,
      active: true,
      deletedAt: null,
      serviceBarbers: [{ barberId: 'b1' }],
    } as never);
    deps.barbers.getById.mockResolvedValue({ id: 'b1', active: true, deletedAt: null } as never);

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
      id: 'srv1',
      durationMin: 30,
      priceCents: 4500,
      active: true,
      deletedAt: null,
      serviceBarbers: [{ barberId: 'b2' }],
    } as never);
    deps.barbers.getById.mockResolvedValue({ id: 'b1', active: true } as never);

    const svc = new AppointmentsService(deps.prisma, deps.repo, deps.services, deps.barbers);
    await expect(svc.createPublicBooking('t1', validInput)).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
  });

  it('rejeita 409 se SLOT já está ocupado (FOR UPDATE retorna linha)', async () => {
    const deps = mockDeps();
    deps.services.getById.mockResolvedValue({
      id: 'srv1',
      durationMin: 30,
      priceCents: 4500,
      active: true,
      serviceBarbers: [{ barberId: 'b1' }],
    } as never);
    deps.barbers.getById.mockResolvedValue({ id: 'b1', active: true } as never);

    // Override $transaction so the inner tx reports an overlapping row
    (deps.prisma.$transaction as jest.Mock).mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(makeTx([{ id: 'existing' }])),
    );

    const svc = new AppointmentsService(deps.prisma, deps.repo, deps.services, deps.barbers);
    await expect(svc.createPublicBooking('t1', validInput)).rejects.toMatchObject({
      status: HttpStatus.CONFLICT,
    });
  });

  it('rejeita slot no passado', async () => {
    const deps = mockDeps();
    deps.services.getById.mockResolvedValue({
      id: 'srv1',
      durationMin: 30,
      priceCents: 4500,
      active: true,
      serviceBarbers: [{ barberId: 'b1' }],
    } as never);
    deps.barbers.getById.mockResolvedValue({ id: 'b1', active: true } as never);

    const svc = new AppointmentsService(
      deps.prisma,
      deps.repo,
      deps.services,
      deps.barbers,
      () => new Date('2031-01-01T00:00:00Z'),
    );
    await expect(svc.createPublicBooking('t1', validInput)).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
  });
});

describe('AppointmentsService — transitions', () => {
  function withCurrentStatus(status: AppointmentStatus) {
    const deps = mockDeps();
    deps.repo.findById.mockResolvedValue({
      id: 'apt1',
      status,
      startsAt: new Date('2030-05-13T10:00:00Z'),
      endsAt: new Date('2030-05-13T10:30:00Z'),
      serviceId: 'srv1',
      barberId: 'b1',
      tenantId: 't1',
      durationMinSnapshot: 30,
    });
    deps.repo.updateStatus.mockImplementation((id: string, st: AppointmentStatus) =>
      Promise.resolve({ id, status: st }),
    );
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
