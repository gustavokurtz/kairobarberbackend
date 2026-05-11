import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { TokensService } from './tokens.service';
import { RefreshTokenRepository } from './repositories/refresh-token.repository';

describe('TokensService', () => {
  let svc: TokensService;
  let jwt: JwtService;
  let repo: jest.Mocked<RefreshTokenRepository>;

  beforeEach(() => {
    const config = {
      get: jest.fn((k: string) => {
        const v: Record<string, string> = {
          JWT_ACCESS_SECRET: 'a'.repeat(40),
          JWT_REFRESH_SECRET: 'b'.repeat(40),
          JWT_ACCESS_TTL: '15m',
          JWT_REFRESH_TTL: '7d',
        };
        return v[k];
      }),
      getOrThrow: jest.fn((k: string) => {
        const v: Record<string, string> = {
          JWT_ACCESS_SECRET: 'a'.repeat(40),
          JWT_REFRESH_SECRET: 'b'.repeat(40),
        };
        return v[k];
      }),
    } as unknown as ConfigService;
    jwt = new JwtService({});
    repo = {
      create: jest.fn(),
      findByHash: jest.fn(),
      rotate: jest.fn(),
      revokeAllForUser: jest.fn(),
    } as unknown as jest.Mocked<RefreshTokenRepository>;
    svc = new TokensService(jwt, config, repo);
  });

  it('issues access + refresh tokens and persists refresh hashed', async () => {
    (repo.create as jest.Mock).mockResolvedValue({ id: 'r1' });
    const result = await svc.issuePair({ userId: 'u1', role: 'tenant_owner', tenantId: 't1' });
    expect(result.accessToken).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        tokenHash: expect.any(String),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        expiresAt: expect.any(Date),
      }),
    );
    expect(repo.create.mock.calls[0][0].tokenHash).not.toBe(result.refreshToken);
  });

  it('verifies access token payload', async () => {
    (repo.create as jest.Mock).mockResolvedValue({ id: 'r1' });
    const { accessToken } = await svc.issuePair({ userId: 'u1', role: 'customer' });
    const payload = await svc.verifyAccess(accessToken);
    expect(payload.sub).toBe('u1');
    expect(payload.role).toBe('customer');
  });
});
