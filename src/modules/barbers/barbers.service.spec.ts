import { BarbersService } from './barbers.service';
import { BarberRepository } from './repositories/barber.repository';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';

describe('BarbersService', () => {
  let repo: jest.Mocked<BarberRepository>;
  let svc: BarbersService;

  beforeEach(() => {
    repo = {
      list: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      softDelete: jest.fn(),
    } as unknown as jest.Mocked<BarberRepository>;
    svc = new BarbersService(repo);
  });

  it('list() returns repository.list()', async () => {
    repo.list.mockResolvedValue([{ id: 'b1' }] as never);
    await expect(svc.list()).resolves.toEqual([{ id: 'b1' }]);
  });

  it('getById() throws BARBER_NOT_FOUND when missing', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(svc.getById('missing')).rejects.toMatchObject({
      opts: { code: ErrorCodes.BARBER_NOT_FOUND },
    });
  });

  it('create() forwards displayName + bio', async () => {
    repo.create.mockResolvedValue({ id: 'new', displayName: 'X' } as never);
    await svc.create({ displayName: 'X', bio: 'b' });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(repo.create).toHaveBeenCalledWith({ displayName: 'X', bio: 'b' });
  });

  it('update() rejects unknown barber with 404', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(svc.update('nope', { displayName: 'Y' })).rejects.toBeInstanceOf(DomainException);
  });

  it('softDelete() rejects unknown barber with 404', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(svc.softDelete('nope')).rejects.toBeInstanceOf(DomainException);
  });
});
