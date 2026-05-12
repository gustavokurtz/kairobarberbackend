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
