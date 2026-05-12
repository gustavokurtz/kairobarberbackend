import { Logger } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditRepository } from './audit.repository';
import { AuditActions } from './audit-actions';

describe('AuditService', () => {
  let repo: jest.Mocked<Pick<AuditRepository, 'insert'>>;
  let logger: jest.Mocked<Pick<Logger, 'warn'>>;
  let service: AuditService;

  beforeEach(() => {
    repo = { insert: jest.fn() };
    logger = { warn: jest.fn() };
    service = new AuditService(repo as unknown as AuditRepository, logger as unknown as Logger);
  });

  it('insere o log e retorna sem erro no caminho feliz', async () => {
    repo.insert.mockResolvedValueOnce({} as never);
    await service.record({
      action: AuditActions.SUBSCRIPTION_ACTIVATED,
      tenantId: 't1',
    });
    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'subscription.activated',
        tenantId: 't1',
      }),
      undefined,
    );
  });

  it('encaminha tx opcional para o repository (audit dentro da transação do caller)', async () => {
    repo.insert.mockResolvedValueOnce({} as never);
    const fakeTx = { $kind: 'tx' } as never;
    await service.record(
      { action: AuditActions.SUBSCRIPTION_TRIAL_STARTED, tenantId: 't1' },
      fakeTx,
    );
    expect(repo.insert).toHaveBeenCalledWith(expect.any(Object), fakeTx);
  });

  it('engole exception do repository e loga warn (audit não quebra negócio)', async () => {
    repo.insert.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.record({ action: AuditActions.TENANT_SUSPENDED, tenantId: 't1' }),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'audit.record_failed', action: 'tenant.suspended' }),
    );
  });
});
