import { TimeOffService } from './time-off.service';
import { TimeOffRepository } from './repositories/time-off.repository';
import { BarbersService } from './barbers.service';
import { ErrorCodes } from 'src/common/exceptions/error-codes';

describe('TimeOffService', () => {
  let repo: jest.Mocked<TimeOffRepository>;
  let barbers: jest.Mocked<BarbersService>;
  let svc: TimeOffService;

  beforeEach(() => {
    repo = {
      listForBarber: jest.fn(),
      create: jest.fn(),
      findById: jest.fn(),
      delete: jest.fn(),
    } as unknown as jest.Mocked<TimeOffRepository>;
    barbers = { getById: jest.fn() } as unknown as jest.Mocked<BarbersService>;
    svc = new TimeOffService(repo, barbers);
  });

  it('create() rejects invalid range', async () => {
    barbers.getById.mockResolvedValue({ id: 'b1' } as never);
    await expect(
      svc.create('b1', { startsAt: '2026-05-12T10:00Z', endsAt: '2026-05-12T09:00Z' }),
    ).rejects.toMatchObject({ opts: { code: ErrorCodes.TIME_OFF_INVALID_RANGE } });
  });

  it('create() persists when range is valid', async () => {
    barbers.getById.mockResolvedValue({ id: 'b1' } as never);
    repo.create.mockResolvedValue({ id: 't1' } as never);
    const out = await svc.create('b1', {
      startsAt: '2026-05-12T10:00Z',
      endsAt: '2026-05-12T11:00Z',
      reason: 'consulta',
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(repo.create).toHaveBeenCalledWith({
      barberId: 'b1',
      startsAt: new Date('2026-05-12T10:00Z'),
      endsAt: new Date('2026-05-12T11:00Z'),
      reason: 'consulta',
    });
    expect(out).toEqual({ id: 't1' });
  });

  it('delete() rejects when time-off not found or belongs to other barber', async () => {
    barbers.getById.mockResolvedValue({ id: 'b1' } as never);
    repo.findById.mockResolvedValue(null);
    await expect(svc.delete('b1', 't-missing')).rejects.toMatchObject({
      opts: { code: ErrorCodes.TIME_OFF_NOT_FOUND },
    });

    repo.findById.mockResolvedValue({ id: 't1', barberId: 'b2' } as never);
    await expect(svc.delete('b1', 't1')).rejects.toMatchObject({
      opts: { code: ErrorCodes.TIME_OFF_NOT_FOUND },
    });
  });
});
