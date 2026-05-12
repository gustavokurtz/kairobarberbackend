import { CustomersService } from './customers.service';
import { CustomerRepository } from './repositories/customer.repository';

function buildRepo(): jest.Mocked<CustomerRepository> {
  return {
    findByPhone: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    findById: jest.fn(),
    findByClaimTokenHash: jest.fn(),
    list: jest.fn(),
    listAppointmentsForCustomer: jest.fn(),
  } as unknown as jest.Mocked<CustomerRepository>;
}

describe('CustomersService.findOrCreateByPhone', () => {
  it('cria Customer novo com claimToken quando email é fornecido', async () => {
    const repo = buildRepo();
    repo.findByPhone.mockResolvedValue(null);
    repo.create.mockImplementation((d) =>
      Promise.resolve({
        id: 'c1',
        name: d.name,
        phone: d.phone,
        email: (d.email as string) ?? null,
        userId: null,
        claimTokenHash: (d.claimTokenHash as string) ?? null,
        claimTokenExpiresAt: (d.claimTokenExpiresAt as Date) ?? null,
        tenantId: 't1',
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );

    const svc = new CustomersService(repo);
    const out = await svc.findOrCreateByPhone({
      name: 'João',
      phone: '+5511999999999',
      email: 'joao@x.com',
    });

    expect(out.customer.id).toBe('c1');
    expect(out.claimPlainToken).toMatch(/^[A-Za-z0-9_-]+$/);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(repo.create).toHaveBeenCalled();
    const created = repo.create.mock.calls[0][0];
    expect(created.claimTokenHash).toBeDefined();
    expect(created.claimTokenExpiresAt).toBeInstanceOf(Date);
  });

  it('NÃO gera claimToken se email vazio', async () => {
    const repo = buildRepo();
    repo.findByPhone.mockResolvedValue(null);
    repo.create.mockResolvedValue({ id: 'c2' } as any);

    const svc = new CustomersService(repo);
    const out = await svc.findOrCreateByPhone({ name: 'João', phone: '+5511999999999' });

    expect(out.claimPlainToken).toBeUndefined();
    const created = repo.create.mock.calls[0][0];
    expect(created.claimTokenHash).toBeUndefined();
  });

  it('reusa Customer existente quando phone bate (sem atualizar se nada mudou)', async () => {
    const repo = buildRepo();
    repo.findByPhone.mockResolvedValue({
      id: 'cx',
      name: 'João',
      phone: '+5511999999999',
      email: 'joao@x.com',
      userId: null,
    } as any);
    const svc = new CustomersService(repo);

    const out = await svc.findOrCreateByPhone({
      name: 'João',
      phone: '+5511999999999',
      email: 'joao@x.com',
    });

    expect(out.customer.id).toBe('cx');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(repo.update).not.toHaveBeenCalled();
    expect(out.claimPlainToken).toBeUndefined();
  });

  it('atualiza nome/email no Customer existente quando vem diferente', async () => {
    const repo = buildRepo();
    repo.findByPhone.mockResolvedValue({
      id: 'cx',
      name: 'João',
      phone: '+5511999999999',
      email: 'antigo@x.com',
      userId: null,
    } as any);
    repo.update.mockResolvedValue({
      id: 'cx',
      name: 'João Silva',
      email: 'novo@x.com',
    } as any);

    const svc = new CustomersService(repo);
    await svc.findOrCreateByPhone({
      name: 'João Silva',
      phone: '+5511999999999',
      email: 'novo@x.com',
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(repo.update).toHaveBeenCalledWith('cx', { name: 'João Silva', email: 'novo@x.com' });
  });
});

describe('CustomersService.consumeClaimToken', () => {
  const futureExpiry = new Date(Date.now() + 60_000);
  const pastExpiry = new Date(Date.now() - 60_000);

  it('throws CLAIM_TOKEN_INVALID (400) when token hash not found', async () => {
    const repo = buildRepo();
    repo.findByClaimTokenHash.mockResolvedValue(null);

    const svc = new CustomersService(repo);
    await expect(svc.consumeClaimToken('any-plain-token')).rejects.toMatchObject({
      response: { code: 'CLAIM_TOKEN_INVALID' },
      status: 400,
    });
  });

  it('throws CLAIM_TOKEN_INVALID (400) when token expired', async () => {
    const repo = buildRepo();
    repo.findByClaimTokenHash.mockResolvedValue({
      id: 'cx',
      userId: null,
      claimTokenExpiresAt: pastExpiry,
    } as any);

    const svc = new CustomersService(repo);
    await expect(svc.consumeClaimToken('plain')).rejects.toMatchObject({
      response: { code: 'CLAIM_TOKEN_INVALID' },
      status: 400,
    });
  });

  it('throws CLAIM_TOKEN_INVALID (409) when customer already claimed (userId set)', async () => {
    const repo = buildRepo();
    repo.findByClaimTokenHash.mockResolvedValue({
      id: 'cx',
      userId: 'u1',
      claimTokenExpiresAt: futureExpiry,
    } as any);

    const svc = new CustomersService(repo);
    await expect(svc.consumeClaimToken('plain')).rejects.toMatchObject({
      response: { code: 'CLAIM_TOKEN_INVALID' },
      status: 409,
    });
  });

  it('returns the customer when token valid and not yet claimed', async () => {
    const repo = buildRepo();
    const customer = {
      id: 'cx',
      userId: null,
      claimTokenExpiresAt: futureExpiry,
      name: 'João',
      email: 'joao@x.com',
    };
    repo.findByClaimTokenHash.mockResolvedValue(customer as any);

    const svc = new CustomersService(repo);
    const out = await svc.consumeClaimToken('plain');
    expect(out).toBe(customer);
  });
});
