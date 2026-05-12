import { ResendEmailProvider } from './resend-email.provider';

describe('ResendEmailProvider', () => {
  const sendMock = jest.fn();

  function makeClient() {
    return { emails: { send: sendMock } };
  }

  beforeEach(() => sendMock.mockReset());

  it('envia email com from, to, subject e body', async () => {
    sendMock.mockResolvedValue({ data: { id: 'msg-1' }, error: null });
    const provider = new ResendEmailProvider(makeClient(), 'noreply@kairobarber.com');

    await provider.send({
      to: 'cliente@x.com',
      subject: 'Confirmação',
      text: 'Olá!',
      html: '<p>Olá!</p>',
    });

    expect(sendMock).toHaveBeenCalledWith({
      from: 'noreply@kairobarber.com',
      to: 'cliente@x.com',
      subject: 'Confirmação',
      text: 'Olá!',
      html: '<p>Olá!</p>',
    });
  });

  it('propaga erro do Resend', async () => {
    sendMock.mockResolvedValue({ data: null, error: { name: 'validation', message: 'bad' } });
    const provider = new ResendEmailProvider(makeClient(), 'noreply@kairobarber.com');

    await expect(provider.send({ to: 'x@x.com', subject: 's', text: 't' })).rejects.toThrow(
      /Resend send failed/,
    );
  });
});
