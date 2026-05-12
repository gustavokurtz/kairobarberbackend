import { BarbersService } from './barbers.service';
import { BarberRepository } from './repositories/barber.repository';
import { BarberInvitationsService } from './barber-invitations.service';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';

describe('BarbersService', () => {
  let repo: jest.Mocked<BarberRepository>;
  let invitations: jest.Mocked<BarberInvitationsService>;
  let svc: BarbersService;

  beforeEach(() => {
    repo = {
      list: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      softDelete: jest.fn(),
    } as unknown as jest.Mocked<BarberRepository>;
    invitations = {
      issue: jest.fn().mockResolvedValue({ invitation: { id: 'inv1' }, tokenPlain: 'tok' }),
    } as unknown as jest.Mocked<BarberInvitationsService>;
    svc = new BarbersService(repo, invitations);
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

  it('create() without email does NOT issue invitation', async () => {
    repo.create.mockResolvedValue({ id: 'new', displayName: 'X' } as never);
    await svc.create({ displayName: 'X' });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(invitations.issue).not.toHaveBeenCalled();
  });

  it('create() with email issues invitation', async () => {
    repo.create.mockResolvedValue({ id: 'new', displayName: 'X' } as never);
    await svc.create({ displayName: 'X', email: 'e@e.com' });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(invitations.issue).toHaveBeenCalledWith({
      barberId: 'new',
      email: 'e@e.com',
      displayName: 'X',
    });
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
