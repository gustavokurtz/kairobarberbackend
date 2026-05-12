import { HttpStatus } from '@nestjs/common';
import { AppointmentStatus } from '@prisma/client';
import { CancellationService } from './cancellation.service';
import { AppointmentRepository } from './repositories/appointment.repository';

type FakeAppointment = {
  id: string;
  status: AppointmentStatus;
  startsAt: Date;
};

function buildRepo(): jest.Mocked<AppointmentRepository> {
  return {
    findByCancellationTokenHash: jest.fn(),
    updateStatus: jest.fn(),
    findById: jest.fn(),
    update: jest.fn(),
    listForRange: jest.fn(),
    findActiveForBarberInRange: jest.fn(),
  } as unknown as jest.Mocked<AppointmentRepository>;
}

describe('CancellationService', () => {
  const fakeNow = new Date('2026-05-12T10:00:00Z');

  function setup(appt: FakeAppointment | null) {
    const repo = buildRepo();
    repo.findByCancellationTokenHash.mockResolvedValue(appt as never);
    repo.updateStatus.mockImplementation(
      (id: string, status: AppointmentStatus) =>
        Promise.resolve({ id, status }) as ReturnType<AppointmentRepository['updateStatus']>,
    );
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
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(repo.updateStatus).toHaveBeenCalledWith(
      'apt1',
      AppointmentStatus.cancelled,
      expect.objectContaining({ cancelledAt: fakeNow }),
    );
  });

  it('rejeita 422 se faltam < 2h', async () => {
    const { svc } = setup({
      id: 'apt1',
      status: AppointmentStatus.confirmed,
      startsAt: new Date('2026-05-12T11:30:00Z'),
    });
    await expect(svc.cancelByToken('tok')).rejects.toMatchObject({
      status: HttpStatus.UNPROCESSABLE_ENTITY,
    });
  });

  it('rejeita 400 se token inválido', async () => {
    const { svc } = setup(null);
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
