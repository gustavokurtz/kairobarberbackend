import { ServicesService } from './services.service';
import { ServiceRepository } from './repositories/service.repository';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { BarberRepository } from 'src/modules/barbers/repositories/barber.repository';

describe('ServicesService', () => {
  let repo: jest.Mocked<ServiceRepository>;
  let svc: ServicesService;

  beforeEach(() => {
    repo = {
      list: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      softDelete: jest.fn(),
    } as unknown as jest.Mocked<ServiceRepository>;
    const barbersRepo = { findById: jest.fn() } as unknown as BarberRepository;
    svc = new ServicesService(repo, barbersRepo);
  });

  it('list() returns from repo', async () => {
    repo.list.mockResolvedValue([{ id: 's1' }] as never);
    await expect(svc.list()).resolves.toEqual([{ id: 's1' }]);
  });

  it('getById() throws SERVICE_NOT_FOUND', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(svc.getById('x')).rejects.toMatchObject({
      opts: { code: ErrorCodes.SERVICE_NOT_FOUND },
    });
  });

  it('create() forwards DTO', async () => {
    repo.create.mockResolvedValue({ id: 's1' } as never);
    await svc.create({ name: 'Corte', durationMin: 30, priceCents: 5000 });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(repo.create).toHaveBeenCalledWith({
      name: 'Corte',
      durationMin: 30,
      priceCents: 5000,
    });
  });

  it('update() rejects unknown service', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(svc.update('s1', { name: 'X' })).rejects.toMatchObject({
      opts: { code: ErrorCodes.SERVICE_NOT_FOUND },
    });
  });

  it('softDelete() rejects unknown service', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(svc.softDelete('s1')).rejects.toMatchObject({
      opts: { code: ErrorCodes.SERVICE_NOT_FOUND },
    });
  });

  describe('setBarbers()', () => {
    let barbers: { findById: jest.Mock };
    let svc2: ServicesService;
    let repo2: ServiceRepository & { replaceBarbers: jest.Mock };

    beforeEach(() => {
      barbers = { findById: jest.fn() };
      repo2 = {
        list: jest.fn(),
        findById: jest.fn().mockResolvedValue({ id: 's1' }),
        create: jest.fn(),
        update: jest.fn(),
        softDelete: jest.fn(),
        replaceBarbers: jest.fn().mockResolvedValue([{ tenantId: 't1' }]),
      } as unknown as ServiceRepository & { replaceBarbers: jest.Mock };
      svc2 = new ServicesService(repo2, barbers as unknown as BarberRepository);
    });

    it('replaces barber list when all ids valid', async () => {
      barbers.findById.mockResolvedValueOnce({ id: 'b1' }).mockResolvedValueOnce({ id: 'b2' });
      await svc2.setBarbers('s1', 't1', ['b1', 'b2']);

      expect(repo2.replaceBarbers).toHaveBeenCalledWith('s1', ['b1', 'b2'], 't1');
    });

    it('rejects unknown barberId', async () => {
      barbers.findById.mockResolvedValueOnce({ id: 'b1' }).mockResolvedValueOnce(null);
      await expect(svc2.setBarbers('s1', 't1', ['b1', 'b-missing'])).rejects.toMatchObject({
        opts: { code: ErrorCodes.SERVICE_BARBER_MISMATCH },
      });
    });

    it('accepts empty list (clears all)', async () => {
      await svc2.setBarbers('s1', 't1', []);

      expect(repo2.replaceBarbers).toHaveBeenCalledWith('s1', [], 't1');
    });
  });
});
