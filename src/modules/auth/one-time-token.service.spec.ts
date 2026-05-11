import { OneTimeTokenService } from './one-time-token.service';
import { OneTimeTokenRepository } from './repositories/one-time-token.repository';

describe('OneTimeTokenService', () => {
  let svc: OneTimeTokenService;
  let repo: jest.Mocked<OneTimeTokenRepository>;

  beforeEach(() => {
    repo = {
      create: jest.fn().mockResolvedValue({ id: 'ott1' }),
      findValidByHash: jest.fn(),
      markUsed: jest.fn(),
    } as unknown as jest.Mocked<OneTimeTokenRepository>;
    svc = new OneTimeTokenService(repo);
  });

  it('issues a token, returns plain to caller, stores only hash', async () => {
    const { plain } = await svc.issue('u1', 'email_verification', 24 * 3600);
    expect(plain).toBeTruthy();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const callArg = (repo.create as jest.Mock).mock.calls[0][0] as {
      tokenHash: string;
      userId: string;
      purpose: string;
    };
    expect(callArg.tokenHash).not.toBe(plain);
    expect(callArg.userId).toBe('u1');
    expect(callArg.purpose).toBe('email_verification');
  });

  it('consumes a valid token and marks it used', async () => {
    const { plain } = await svc.issue('u1', 'password_reset', 3600);
    (repo.findValidByHash as jest.Mock).mockResolvedValue({ id: 'ott2', userId: 'u1' });
    const result = await svc.consume(plain, 'password_reset');
    expect(result?.userId).toBe('u1');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(repo.markUsed).toHaveBeenCalledWith('ott2');
  });

  it('returns null when token is invalid/expired', async () => {
    (repo.findValidByHash as jest.Mock).mockResolvedValue(null);
    const result = await svc.consume('does-not-exist', 'password_reset');
    expect(result).toBeNull();
  });
});
