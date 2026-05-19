import { MercadopagoBillingProvider } from './mercadopago.billing-provider';

type FetchSignature = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type FetchFn = jest.MockedFunction<FetchSignature>;

function mkFetch(): FetchFn {
  return jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>() as FetchFn;
}

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface CreatePreapprovalBody {
  reason: string;
  external_reference: string;
  payer_email: string;
  back_url: string;
  auto_recurring: {
    frequency: number;
    frequency_type: string;
    transaction_amount: number;
    currency_id: string;
  };
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function bodyOf(init: RequestInit | undefined): string {
  const b = init?.body;
  if (typeof b === 'string') return b;
  throw new Error('expected string body');
}

describe('MercadopagoBillingProvider', () => {
  const baseUrl = 'https://api.mercadopago.test';
  const token = 'TEST-TOKEN';
  let fetchMock: FetchFn;
  let provider: MercadopagoBillingProvider;

  beforeEach(() => {
    fetchMock = mkFetch();
    provider = new MercadopagoBillingProvider({
      accessToken: token,
      apiBaseUrl: baseUrl,
      returnUrl: 'https://kairobarber.test/admin/billing/return',
      fetchImpl: fetchMock,
    });
  });

  describe('createPreapproval', () => {
    it('POST /preapproval e mapeia resposta para { preapprovalId, initPoint }', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonRes(201, { id: 'PRE-123', init_point: 'https://mp.test/pay/PRE-123' }),
      );

      const result = await provider.createPreapproval({
        tenantId: 't1',
        tenantSlug: 'demo',
        payerEmail: 'owner@x.com',
        payerName: 'Owner X',
        reason: 'Assinatura KairoBarber - demo',
        amountCents: 4990,
        frequency: 'months',
      });

      expect(result).toEqual({
        preapprovalId: 'PRE-123',
        initPoint: 'https://mp.test/pay/PRE-123',
      });

      const [url, init] = fetchMock.mock.calls[0];
      expect(urlOf(url)).toBe(`${baseUrl}/preapproval`);
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      expect(headers['Authorization']).toBe(`Bearer ${token}`);
      expect(headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(bodyOf(init)) as CreatePreapprovalBody;
      expect(body.reason).toBe('Assinatura KairoBarber - demo');
      expect(body.auto_recurring.transaction_amount).toBe(49.9);
      expect(body.auto_recurring.frequency).toBe(1);
      expect(body.auto_recurring.frequency_type).toBe('months');
      expect(body.payer_email).toBe('owner@x.com');
      expect(body.external_reference).toBe('t1');
      expect(body.back_url).toBe('https://kairobarber.test/admin/billing/return');
    });

    it('401 do MP vira BILLING_PROVIDER_UNAUTHORIZED', async () => {
      fetchMock.mockResolvedValueOnce(jsonRes(401, { message: 'invalid token' }));
      await expect(
        provider.createPreapproval({
          tenantId: 't1',
          tenantSlug: 'd',
          payerEmail: 'x@x.com',
          payerName: 'X',
          reason: 'r',
          amountCents: 4990,
          frequency: 'months',
        }),
      ).rejects.toMatchObject({ opts: { code: 'BILLING_PROVIDER_UNAUTHORIZED' } });
    });

    it('logs de erro não vazam PII (payer_email)', async () => {
      fetchMock.mockResolvedValueOnce(jsonRes(400, { message: 'bad' }));
      const warnSpy = jest
        .spyOn((provider as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
        .mockImplementation(() => undefined);

      await expect(
        provider.createPreapproval({
          tenantId: 't1',
          tenantSlug: 'd',
          payerEmail: 'leak@x.com',
          payerName: 'Owner',
          reason: 'r',
          amountCents: 4990,
          frequency: 'months',
        }),
      ).rejects.toBeDefined();

      const logged = warnSpy.mock.calls[0]?.[0] as { requestBody: Record<string, unknown> };
      expect(logged.requestBody.payer_email).toBe('[redacted]');
      expect(logged.requestBody.external_reference).toBe('t1');

      warnSpy.mockRestore();
    });

    it('5xx do MP vira BILLING_PROVIDER_ERROR', async () => {
      fetchMock.mockResolvedValueOnce(jsonRes(503, { message: 'busy' }));
      await expect(
        provider.createPreapproval({
          tenantId: 't1',
          tenantSlug: 'd',
          payerEmail: 'x@x.com',
          payerName: 'X',
          reason: 'r',
          amountCents: 4990,
          frequency: 'months',
        }),
      ).rejects.toMatchObject({ opts: { code: 'BILLING_PROVIDER_ERROR' } });
    });
  });

  describe('fetchPreapproval', () => {
    it('GET /preapproval/{id} e mapeia status authorized → authorized', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonRes(200, {
          id: 'PRE-1',
          status: 'authorized',
          next_payment_date: '2026-06-12T03:00:00.000Z',
        }),
      );
      const res = await provider.fetchPreapproval('PRE-1');
      expect(res).toEqual({
        preapprovalId: 'PRE-1',
        status: 'authorized',
        nextPaymentDate: new Date('2026-06-12T03:00:00.000Z'),
      });
    });

    it('next_payment_date ausente vira null', async () => {
      fetchMock.mockResolvedValueOnce(jsonRes(200, { id: 'PRE-2', status: 'pending' }));
      const res = await provider.fetchPreapproval('PRE-2');
      expect(res.nextPaymentDate).toBeNull();
    });
  });

  describe('cancelPreapproval', () => {
    it('PUT /preapproval/{id} com status:cancelled', async () => {
      fetchMock.mockResolvedValueOnce(jsonRes(200, { id: 'PRE-1', status: 'cancelled' }));
      await provider.cancelPreapproval('PRE-1');
      const [url, init] = fetchMock.mock.calls[0];
      expect(urlOf(url)).toBe(`${baseUrl}/preapproval/PRE-1`);
      expect(init?.method).toBe('PUT');
      expect(JSON.parse(bodyOf(init))).toEqual({ status: 'cancelled' });
    });

    it('404 do MP é idempotente (não lança)', async () => {
      fetchMock.mockResolvedValueOnce(jsonRes(404, { message: 'not found' }));
      await expect(provider.cancelPreapproval('PRE-1')).resolves.toBeUndefined();
    });
  });

  describe('listPayments', () => {
    it('GET /authorized_payments/search e mapeia centavos', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonRes(200, {
          results: [
            {
              id: 'P-1',
              transaction_amount: 49.9,
              status: 'approved',
              payment_date: '2026-04-12T10:00:00.000Z',
              date_created: '2026-04-12T09:00:00.000Z',
            },
          ],
        }),
      );
      const res = await provider.listPayments('PRE-1', { page: 1, pageSize: 20 });
      expect(res).toEqual([
        {
          id: 'P-1',
          amountCents: 4990,
          status: 'approved',
          paidAt: new Date('2026-04-12T10:00:00.000Z'),
          dueAt: new Date('2026-04-12T09:00:00.000Z'),
        },
      ]);
      const [url] = fetchMock.mock.calls[0];
      const u = new URL(urlOf(url));
      expect(u.searchParams.get('preapproval_id')).toBe('PRE-1');
      expect(u.searchParams.get('offset')).toBe('0');
      expect(u.searchParams.get('limit')).toBe('20');
    });
  });
});
