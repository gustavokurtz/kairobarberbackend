import { ServicesService } from './services.service';
import { ServiceRepository } from './repositories/service.repository';
import { ErrorCodes } from 'src/common/exceptions/error-codes';

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
    svc = new ServicesService(repo);
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
});
