import { ConfigService } from '@nestjs/config';
import { PasswordService } from './password.service';

describe('PasswordService', () => {
  let service: PasswordService;

  beforeEach(() => {
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'PASSWORD_HASH_TIME_COST') return 3;
        if (key === 'PASSWORD_HASH_MEMORY_COST') return 65536;
        return undefined;
      }),
    } as unknown as ConfigService;
    service = new PasswordService(config);
  });

  it('hashes and verifies a password successfully', async () => {
    const hash = await service.hash('SuperSecret123!');
    expect(hash).not.toBe('SuperSecret123!');
    expect(await service.verify(hash, 'SuperSecret123!')).toBe(true);
  });

  it('returns false for wrong password', async () => {
    const hash = await service.hash('SuperSecret123!');
    expect(await service.verify(hash, 'wrong')).toBe(false);
  });

  it('produces different hashes for the same password (salt random)', async () => {
    const h1 = await service.hash('SuperSecret123!');
    const h2 = await service.hash('SuperSecret123!');
    expect(h1).not.toBe(h2);
  });
});
