import { BarberInvitationsService } from './barber-invitations.service';
import { BarberInvitationRepository } from './repositories/barber-invitation.repository';
import { ConfigService } from '@nestjs/config';
import { EmailProvider } from 'src/modules/notifications/email.provider';

describe('BarberInvitationsService', () => {
  let repo: jest.Mocked<BarberInvitationRepository>;
  let email: jest.Mocked<EmailProvider>;
  let cfg: ConfigService;
  let svc: BarberInvitationsService;

  beforeEach(() => {
    repo = {
      create: jest.fn(),
      findByTokenHash: jest.fn(),
      markAccepted: jest.fn(),
    } as unknown as jest.Mocked<BarberInvitationRepository>;
    email = { send: jest.fn().mockResolvedValue(undefined) };
    cfg = new ConfigService({ APP_URL: 'https://app.kairobarber.test' });
    svc = new BarberInvitationsService(repo, email, cfg);
  });

  it('issue() stores a hash, sends an email and returns plain token (length > 20)', async () => {
    repo.create.mockResolvedValue({ id: 'inv1' } as never);
    const { tokenPlain } = await svc.issue({
      barberId: 'b1',
      email: 'barbeiro@test.com',
      displayName: 'Barbeiro',
    });
    expect(tokenPlain.length).toBeGreaterThan(20);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(repo.create).toHaveBeenCalledTimes(1);
    const arg = repo.create.mock.calls[0][0];
    expect(arg.tokenHash).not.toEqual(tokenPlain);
    expect(arg.email).toBe('barbeiro@test.com');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(email.send.mock.calls[0][0].to).toBe('barbeiro@test.com');
    expect(email.send.mock.calls[0][0].text).toContain(tokenPlain);
  });

  it('validate() returns invitation when token is valid', async () => {
    repo.findByTokenHash.mockResolvedValue({
      id: 'inv1',
      acceptedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000),
      barberId: 'b1',
      tenantId: 't1',
      email: 'e@e.com',
      barber: {},
      tenant: {},
    } as never);
    await expect(svc.validate('plain')).resolves.toMatchObject({ id: 'inv1' });
  });

  it('validate() rejects expired token', async () => {
    repo.findByTokenHash.mockResolvedValue({
      id: 'inv1',
      acceptedAt: null,
      expiresAt: new Date(Date.now() - 1),
    } as never);
    await expect(svc.validate('plain')).rejects.toMatchObject({
      opts: { code: 'INVITATION_EXPIRED' },
    });
  });

  it('validate() rejects already-accepted', async () => {
    repo.findByTokenHash.mockResolvedValue({
      id: 'inv1',
      acceptedAt: new Date(),
      expiresAt: new Date(Date.now() + 1000),
    } as never);
    await expect(svc.validate('plain')).rejects.toMatchObject({
      opts: { code: 'INVITATION_ALREADY_ACCEPTED' },
    });
  });

  it('validate() rejects unknown token', async () => {
    repo.findByTokenHash.mockResolvedValue(null);
    await expect(svc.validate('plain')).rejects.toMatchObject({
      opts: { code: 'INVITATION_INVALID' },
    });
  });
});
