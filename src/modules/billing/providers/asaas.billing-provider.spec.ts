import { HttpStatus } from '@nestjs/common';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import { AsaasBillingProvider } from './asaas.billing-provider';

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

describe('AsaasBillingProvider', () => {
  const baseUrl = 'https://api-sandbox.asaas.test';
  const apiKey = '$aact_TEST_KEY';
  const returnUrl = 'https://kairobarber.test/admin/billing/return';
  let fetchMock: FetchFn;
  let provider: AsaasBillingProvider;

  beforeEach(() => {
    fetchMock = mkFetch();
    provider = new AsaasBillingProvider({
      apiKey,
      apiBaseUrl: baseUrl,
      billingCycle: 'MONTHLY',
      returnUrl,
      fetchImpl: fetchMock,
      now: () => new Date('2026-05-19T12:00:00Z'),
    });
  });

  function expectAuthHeader(init: RequestInit | undefined): void {
    const headers = init?.headers as Record<string, string>;
    expect(headers['access_token']).toBe(apiKey);
    expect(headers['Content-Type']).toBe('application/json');
  }

  describe('createPreapproval', () => {
    it('cria customer novo (não existente), cria subscription e retorna invoiceUrl da primeira cobrança', async () => {
      // 1) GET /v3/customers?externalReference=... → vazio
      fetchMock.mockResolvedValueOnce(jsonRes(200, { data: [], totalCount: 0, hasMore: false }));
      // 2) POST /v3/customers → criado
      fetchMock.mockResolvedValueOnce(
        jsonRes(200, { id: 'cus_NEW', externalReference: 't1', name: 'Gustavo' }),
      );
      // 3) POST /v3/subscriptions → criada
      fetchMock.mockResolvedValueOnce(
        jsonRes(200, { id: 'sub_ABC', status: 'ACTIVE', nextDueDate: '2026-05-19' }),
      );
      // 4) GET /v3/subscriptions/sub_ABC/payments → primeira cobrança PENDING
      fetchMock.mockResolvedValueOnce(
        jsonRes(200, {
          data: [
            {
              id: 'pay_1',
              status: 'PENDING',
              value: 49.9,
              dueDate: '2026-05-19',
              invoiceUrl: 'https://sandbox.asaas.com/i/pay_1',
            },
          ],
          hasMore: false,
          totalCount: 1,
        }),
      );

      const result = await provider.createPreapproval({
        tenantId: 't1',
        tenantSlug: 'demo',
        payerEmail: 'gustavo@x.com',
        payerName: 'Gustavo Demo',
        reason: 'Assinatura KairoBarber - demo',
        amountCents: 4990,
        frequency: 'months',
      });

      expect(result).toEqual({
        preapprovalId: 'sub_ABC',
        initPoint: 'https://sandbox.asaas.com/i/pay_1',
      });
      expect(fetchMock).toHaveBeenCalledTimes(4);

      const [searchUrl, searchInit] = fetchMock.mock.calls[0];
      const searchU = new URL(urlOf(searchUrl));
      expect(searchU.pathname).toBe('/v3/customers');
      expect(searchU.searchParams.get('externalReference')).toBe('t1');
      expect(searchU.searchParams.get('limit')).toBe('1');
      expect(searchInit?.method).toBe('GET');
      expectAuthHeader(searchInit);

      const [createCustomerUrl, createCustomerInit] = fetchMock.mock.calls[1];
      expect(urlOf(createCustomerUrl)).toBe(`${baseUrl}/v3/customers`);
      expect(createCustomerInit?.method).toBe('POST');
      const customerBody = JSON.parse(bodyOf(createCustomerInit)) as {
        name: string;
        email: string;
        externalReference: string;
        cpfCnpj?: string;
      };
      expect(customerBody.name).toBe('Gustavo Demo');
      expect(customerBody.email).toBe('gustavo@x.com');
      expect(customerBody.externalReference).toBe('t1');
      expect(customerBody.cpfCnpj).toBeUndefined();

      const [createSubUrl, createSubInit] = fetchMock.mock.calls[2];
      expect(urlOf(createSubUrl)).toBe(`${baseUrl}/v3/subscriptions`);
      expect(createSubInit?.method).toBe('POST');
      const subBody = JSON.parse(bodyOf(createSubInit)) as {
        customer: string;
        billingType: string;
        value: number;
        cycle: string;
        nextDueDate: string;
        description: string;
        externalReference: string;
        callback?: { successUrl?: string; autoRedirect?: boolean };
      };
      expect(subBody.customer).toBe('cus_NEW');
      expect(subBody.billingType).toBe('UNDEFINED');
      expect(subBody.value).toBe(49.9);
      expect(subBody.cycle).toBe('MONTHLY');
      expect(subBody.nextDueDate).toBe('2026-05-19');
      expect(subBody.description).toBe('Assinatura KairoBarber - demo');
      expect(subBody.externalReference).toBe('t1');
      expect(subBody.callback?.successUrl).toBe(returnUrl);

      const [paymentsUrl, paymentsInit] = fetchMock.mock.calls[3];
      expect(urlOf(paymentsUrl).startsWith(`${baseUrl}/v3/subscriptions/sub_ABC/payments`)).toBe(
        true,
      );
      expect(paymentsInit?.method).toBe('GET');
    });

    it('reusa customer existente E sincroniza name/email/cpfCnpj via PUT antes de criar subscription', async () => {
      // 1) GET customers → encontra existente
      fetchMock.mockResolvedValueOnce(
        jsonRes(200, {
          data: [{ id: 'cus_EXISTING', externalReference: 't1', name: 'old' }],
          totalCount: 1,
          hasMore: false,
        }),
      );
      // 2) PUT /v3/customers/{id} → sincroniza dados (cpfCnpj é o ponto chave)
      fetchMock.mockResolvedValueOnce(
        jsonRes(200, { id: 'cus_EXISTING', name: 'G', email: 'g@x.com' }),
      );
      // 3) POST /v3/subscriptions
      fetchMock.mockResolvedValueOnce(
        jsonRes(200, { id: 'sub_XYZ', status: 'ACTIVE', nextDueDate: '2026-05-19' }),
      );
      // 4) GET payments
      fetchMock.mockResolvedValueOnce(
        jsonRes(200, {
          data: [
            {
              id: 'pay_9',
              status: 'PENDING',
              value: 49.9,
              dueDate: '2026-05-19',
              invoiceUrl: 'https://sandbox.asaas.com/i/pay_9',
            },
          ],
          hasMore: false,
          totalCount: 1,
        }),
      );

      const result = await provider.createPreapproval({
        tenantId: 't1',
        tenantSlug: 'demo',
        payerEmail: 'g@x.com',
        payerName: 'G',
        payerCpfCnpj: '12865937607',
        reason: 'r',
        amountCents: 4990,
        frequency: 'months',
      });

      expect(result).toEqual({
        preapprovalId: 'sub_XYZ',
        initPoint: 'https://sandbox.asaas.com/i/pay_9',
      });
      // 4 chamadas: GET search, PUT customer, POST subscription, GET payments
      expect(fetchMock).toHaveBeenCalledTimes(4);

      const [putUrl, putInit] = fetchMock.mock.calls[1];
      expect(urlOf(putUrl)).toBe(`${baseUrl}/v3/customers/cus_EXISTING`);
      expect(putInit?.method).toBe('PUT');
      const putBody = JSON.parse(bodyOf(putInit)) as {
        cpfCnpj?: string;
        name: string;
        email: string;
      };
      expect(putBody.cpfCnpj).toBe('12865937607');
      expect(putBody.name).toBe('G');
      expect(putBody.email).toBe('g@x.com');

      const subBody = JSON.parse(bodyOf(fetchMock.mock.calls[2][1])) as { customer: string };
      expect(subBody.customer).toBe('cus_EXISTING');
    });

    it('reusa customer existente SEM cpfCnpj no PUT quando input não tem (não sobrescreve com null)', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonRes(200, {
          data: [{ id: 'cus_EXISTING', externalReference: 't1', name: 'old' }],
          totalCount: 1,
          hasMore: false,
        }),
      );
      fetchMock.mockResolvedValueOnce(jsonRes(200, { id: 'cus_EXISTING' }));
      fetchMock.mockResolvedValueOnce(
        jsonRes(200, { id: 'sub_ABC', status: 'ACTIVE', nextDueDate: '2026-05-19' }),
      );
      fetchMock.mockResolvedValueOnce(
        jsonRes(200, {
          data: [{ id: 'p1', status: 'PENDING', value: 49.9, invoiceUrl: 'https://x' }],
          hasMore: false,
        }),
      );

      await provider.createPreapproval({
        tenantId: 't1',
        tenantSlug: 'demo',
        payerEmail: 'g@x.com',
        payerName: 'G',
        // sem payerCpfCnpj
        reason: 'r',
        amountCents: 4990,
        frequency: 'months',
      });

      const putBody = JSON.parse(bodyOf(fetchMock.mock.calls[1][1])) as Record<string, unknown>;
      expect(putBody).not.toHaveProperty('cpfCnpj');
      expect(putBody.name).toBe('G');
      expect(putBody.email).toBe('g@x.com');
    });

    it('inclui cpfCnpj quando fornecido no input', async () => {
      fetchMock.mockResolvedValueOnce(jsonRes(200, { data: [], totalCount: 0, hasMore: false }));
      fetchMock.mockResolvedValueOnce(jsonRes(200, { id: 'cus_X' }));
      fetchMock.mockResolvedValueOnce(
        jsonRes(200, { id: 'sub_X', status: 'ACTIVE', nextDueDate: '2026-05-19' }),
      );
      fetchMock.mockResolvedValueOnce(
        jsonRes(200, {
          data: [{ id: 'p1', status: 'PENDING', invoiceUrl: 'https://x', value: 49.9 }],
          hasMore: false,
        }),
      );

      await provider.createPreapproval({
        tenantId: 't1',
        tenantSlug: 'demo',
        payerEmail: 'g@x.com',
        payerName: 'G',
        payerCpfCnpj: '11122233344',
        reason: 'r',
        amountCents: 4990,
        frequency: 'months',
      });

      const customerBody = JSON.parse(bodyOf(fetchMock.mock.calls[1][1])) as {
        cpfCnpj?: string;
      };
      expect(customerBody.cpfCnpj).toBe('11122233344');
    });

    it('401 vira BILLING_PROVIDER_UNAUTHORIZED', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonRes(401, { errors: [{ code: 'invalid_access_token', description: 'A chave...' }] }),
      );
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

    it('logs de erro não vazam PII (name/email/cpfCnpj/creditCard)', async () => {
      // 1) GET customers vazio
      fetchMock.mockResolvedValueOnce(jsonRes(200, { data: [], totalCount: 0 }));
      // 2) POST /v3/customers falha com 400 → vai logar warn com body
      fetchMock.mockResolvedValueOnce(
        jsonRes(400, { errors: [{ code: 'invalid_cpfCnpj', description: 'inválido' }] }),
      );
      const warnSpy = jest
        .spyOn((provider as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
        .mockImplementation(() => undefined);

      await expect(
        provider.createPreapproval({
          tenantId: 't1',
          tenantSlug: 'd',
          payerEmail: 'leak@x.com',
          payerName: 'Should Not Leak',
          payerCpfCnpj: '11122233344',
          reason: 'r',
          amountCents: 4990,
          frequency: 'months',
        }),
      ).rejects.toMatchObject({ opts: { code: 'BILLING_PROVIDER_ERROR' } });

      const logged = warnSpy.mock.calls[0]?.[0] as { requestBody: Record<string, unknown> };
      expect(logged.requestBody.name).toBe('[redacted]');
      expect(logged.requestBody.email).toBe('[redacted]');
      expect(logged.requestBody.cpfCnpj).toBe('[redacted]');
      // campos não-PII permanecem visíveis pra debug
      expect(logged.requestBody.externalReference).toBe('t1');

      warnSpy.mockRestore();
    });

    it('5xx vira BILLING_PROVIDER_ERROR', async () => {
      fetchMock.mockResolvedValueOnce(jsonRes(503, { errors: [{ description: 'busy' }] }));
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
    it('subscription ACTIVE + payment RECEIVED → authorized', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonRes(200, { id: 'sub_1', status: 'ACTIVE', nextDueDate: '2026-06-19' }),
      );
      fetchMock.mockResolvedValueOnce(
        jsonRes(200, {
          data: [
            {
              id: 'p1',
              status: 'RECEIVED',
              value: 49.9,
              dueDate: '2026-05-19',
              paymentDate: '2026-05-19',
            },
          ],
          hasMore: false,
        }),
      );

      const res = await provider.fetchPreapproval('sub_1');
      expect(res).toEqual({
        preapprovalId: 'sub_1',
        status: 'authorized',
        nextPaymentDate: new Date('2026-06-19'),
      });
    });

    it('subscription ACTIVE + payment CONFIRMED → authorized', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonRes(200, { id: 'sub_1', status: 'ACTIVE', nextDueDate: '2026-06-19' }),
      );
      fetchMock.mockResolvedValueOnce(
        jsonRes(200, {
          data: [{ id: 'p1', status: 'CONFIRMED', value: 49.9, dueDate: '2026-05-19' }],
          hasMore: false,
        }),
      );
      const res = await provider.fetchPreapproval('sub_1');
      expect(res.status).toBe('authorized');
    });

    it('subscription ACTIVE + payment OVERDUE → paused', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonRes(200, { id: 'sub_1', status: 'ACTIVE', nextDueDate: '2026-06-19' }),
      );
      fetchMock.mockResolvedValueOnce(
        jsonRes(200, {
          data: [{ id: 'p1', status: 'OVERDUE', value: 49.9, dueDate: '2026-05-19' }],
          hasMore: false,
        }),
      );
      const res = await provider.fetchPreapproval('sub_1');
      expect(res.status).toBe('paused');
    });

    it('subscription ACTIVE + apenas payment PENDING → pending', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonRes(200, { id: 'sub_1', status: 'ACTIVE', nextDueDate: '2026-05-19' }),
      );
      fetchMock.mockResolvedValueOnce(
        jsonRes(200, {
          data: [{ id: 'p1', status: 'PENDING', value: 49.9, dueDate: '2026-05-19' }],
          hasMore: false,
        }),
      );
      const res = await provider.fetchPreapproval('sub_1');
      expect(res.status).toBe('pending');
    });

    it('subscription INACTIVE → cancelled', async () => {
      fetchMock.mockResolvedValueOnce(jsonRes(200, { id: 'sub_1', status: 'INACTIVE' }));
      const res = await provider.fetchPreapproval('sub_1');
      expect(res).toEqual({ preapprovalId: 'sub_1', status: 'cancelled', nextPaymentDate: null });
    });

    it('subscription EXPIRED → paused', async () => {
      fetchMock.mockResolvedValueOnce(jsonRes(200, { id: 'sub_1', status: 'EXPIRED' }));
      const res = await provider.fetchPreapproval('sub_1');
      expect(res.status).toBe('paused');
    });
  });

  describe('cancelPreapproval', () => {
    it('DELETE /v3/subscriptions/{id}', async () => {
      fetchMock.mockResolvedValueOnce(jsonRes(200, { deleted: true, id: 'sub_1' }));
      await provider.cancelPreapproval('sub_1');
      const [url, init] = fetchMock.mock.calls[0];
      expect(urlOf(url)).toBe(`${baseUrl}/v3/subscriptions/sub_1`);
      expect(init?.method).toBe('DELETE');
    });

    it('404 é idempotente (não lança)', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonRes(404, { errors: [{ code: 'invalid_object', description: 'Not found' }] }),
      );
      await expect(provider.cancelPreapproval('sub_X')).resolves.toBeUndefined();
    });
  });

  describe('listPayments', () => {
    it('GET /v3/subscriptions/{id}/payments com offset/limit, mapeia centavos e status', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonRes(200, {
          data: [
            {
              id: 'p1',
              status: 'RECEIVED',
              value: 49.9,
              dueDate: '2026-05-19',
              paymentDate: '2026-05-20',
            },
            {
              id: 'p2',
              status: 'REFUNDED',
              value: 49.9,
              dueDate: '2026-04-19',
              paymentDate: '2026-04-19',
            },
            {
              id: 'p3',
              status: 'OVERDUE',
              value: 49.9,
              dueDate: '2026-03-19',
            },
          ],
          hasMore: false,
        }),
      );

      const res = await provider.listPayments('sub_1', { page: 1, pageSize: 20 });
      expect(res).toEqual([
        {
          id: 'p1',
          amountCents: 4990,
          status: 'approved',
          paidAt: new Date('2026-05-20'),
          dueAt: new Date('2026-05-19'),
        },
        {
          id: 'p2',
          amountCents: 4990,
          status: 'refunded',
          paidAt: new Date('2026-04-19'),
          dueAt: new Date('2026-04-19'),
        },
        {
          id: 'p3',
          amountCents: 4990,
          status: 'pending',
          paidAt: null,
          dueAt: new Date('2026-03-19'),
        },
      ]);

      const [url] = fetchMock.mock.calls[0];
      const u = new URL(urlOf(url));
      expect(u.pathname).toBe('/v3/subscriptions/sub_1/payments');
      expect(u.searchParams.get('offset')).toBe('0');
      expect(u.searchParams.get('limit')).toBe('20');
    });

    it('page=3 calcula offset=40 com pageSize=20', async () => {
      fetchMock.mockResolvedValueOnce(jsonRes(200, { data: [], hasMore: false }));
      await provider.listPayments('sub_1', { page: 3, pageSize: 20 });
      const u = new URL(urlOf(fetchMock.mock.calls[0][0]));
      expect(u.searchParams.get('offset')).toBe('40');
    });
  });

  describe('healthCheck', () => {
    it('GET /v3/customers?limit=1 → 200 → ok:true', async () => {
      fetchMock.mockResolvedValueOnce(jsonRes(200, { data: [], totalCount: 0 }));
      const out = await provider.healthCheck();
      expect(out).toEqual({ ok: true });
    });

    it('500 → ok:false (sem lançar)', async () => {
      fetchMock.mockResolvedValueOnce(jsonRes(500, { errors: [{ description: 'boom' }] }));
      const out = await provider.healthCheck();
      expect(out).toEqual({ ok: false });
    });
  });

  describe('request() timeout (A2 / R-F3-02 + R-F3-03)', () => {
    it('passa AbortSignal.timeout(10_000) no init do fetch', async () => {
      fetchMock.mockResolvedValueOnce(jsonRes(200, { data: [], hasMore: false, totalCount: 0 }));
      await provider.healthCheck();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0];
      expect(init?.signal).toBeDefined();
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect((init?.signal as AbortSignal).aborted).toBe(false);
    });

    it('mapeia TimeoutError do fetch pra DomainException 504 BILLING_PROVIDER_ERROR', async () => {
      const timeoutErr = new DOMException(
        'The operation was aborted due to timeout',
        'TimeoutError',
      );
      fetchMock.mockRejectedValueOnce(timeoutErr);
      await expect(provider.listPayments('sub_X', { page: 1, pageSize: 20 })).rejects.toMatchObject(
        {
          opts: {
            code: ErrorCodes.BILLING_PROVIDER_ERROR,
            status: HttpStatus.GATEWAY_TIMEOUT,
          },
        },
      );
    });

    it('mapeia AbortError externo pra DomainException 504 (mesma classe)', async () => {
      const abortErr = new DOMException('Aborted', 'AbortError');
      fetchMock.mockRejectedValueOnce(abortErr);
      await expect(provider.listPayments('sub_Y', { page: 1, pageSize: 20 })).rejects.toMatchObject(
        {
          opts: {
            code: ErrorCodes.BILLING_PROVIDER_ERROR,
            status: HttpStatus.GATEWAY_TIMEOUT,
          },
        },
      );
    });

    it('preserva method+path nos details da DomainException de timeout', async () => {
      const timeoutErr = new DOMException('Timeout', 'TimeoutError');
      fetchMock.mockRejectedValueOnce(timeoutErr);
      await expect(provider.listPayments('sub_Z', { page: 1, pageSize: 20 })).rejects.toMatchObject(
        {
          opts: {
            details: {
              method: 'GET',
              path: expect.stringContaining('/v3/subscriptions/sub_Z/payments') as unknown,
            },
          },
        },
      );
    });
  });
});
