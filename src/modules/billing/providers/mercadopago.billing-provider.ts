import { HttpStatus, Logger } from '@nestjs/common';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import {
  BillingProvider,
  CreatePreapprovalInput,
  CreatePreapprovalResult,
  ListPaymentsQuery,
  RemotePayment,
  RemoteSubscription,
  RemoteSubscriptionStatus,
} from './billing.provider';

export interface MercadopagoBillingProviderOptions {
  accessToken: string;
  apiBaseUrl: string;
  /**
   * Quando preenchido com HTTPS público é enviado como `back_url` no preapproval do MP.
   * Localhost/HTTP é rejeitado pelo MP, então omitimos nesses casos. Sem back_url o usuário
   * paga e volta manualmente pro `/admin/billing` (que faz sync on-demand).
   */
  returnUrl?: string;
  fetchImpl?: typeof fetch;
}

const VALID_REMOTE_STATUSES: ReadonlySet<RemoteSubscriptionStatus> = new Set([
  'pending',
  'authorized',
  'paused',
  'cancelled',
]);

export class MercadopagoBillingProvider implements BillingProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly logger = new Logger(MercadopagoBillingProvider.name);

  constructor(private readonly opts: MercadopagoBillingProviderOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async createPreapproval(input: CreatePreapprovalInput): Promise<CreatePreapprovalResult> {
    const body: Record<string, unknown> = {
      reason: input.reason,
      external_reference: input.tenantId,
      payer_email: input.payerEmail,
      auto_recurring: {
        frequency: 1,
        frequency_type: input.frequency,
        transaction_amount: input.amountCents / 100,
        currency_id: 'BRL',
      },
    };
    if (this.opts.returnUrl && /^https:\/\//i.test(this.opts.returnUrl)) {
      body.back_url = this.opts.returnUrl;
    }
    const res = await this.request('POST', '/preapproval', body);
    const json = (await res.json()) as { id: string; init_point: string };
    return { preapprovalId: json.id, initPoint: json.init_point };
  }

  async fetchPreapproval(preapprovalId: string): Promise<RemoteSubscription> {
    const res = await this.request('GET', `/preapproval/${encodeURIComponent(preapprovalId)}`);
    const json = (await res.json()) as { id: string; status: string; next_payment_date?: string };
    const status: RemoteSubscriptionStatus = VALID_REMOTE_STATUSES.has(
      json.status as RemoteSubscriptionStatus,
    )
      ? (json.status as RemoteSubscriptionStatus)
      : 'pending';
    return {
      preapprovalId: json.id,
      status,
      nextPaymentDate: json.next_payment_date ? new Date(json.next_payment_date) : null,
    };
  }

  async cancelPreapproval(preapprovalId: string): Promise<void> {
    try {
      await this.request('PUT', `/preapproval/${encodeURIComponent(preapprovalId)}`, {
        status: 'cancelled',
      });
    } catch (err) {
      if (err instanceof DomainException && err.opts.details?.statusCode === 404) {
        return; // idempotente
      }
      throw err;
    }
  }

  async listPayments(preapprovalId: string, q: ListPaymentsQuery): Promise<RemotePayment[]> {
    const offset = (q.page - 1) * q.pageSize;
    const url = `/authorized_payments/search?preapproval_id=${encodeURIComponent(
      preapprovalId,
    )}&offset=${offset}&limit=${q.pageSize}`;
    const res = await this.request('GET', url);
    const json = (await res.json()) as {
      results: Array<{
        id: string;
        transaction_amount: number;
        status: 'approved' | 'rejected' | 'pending' | 'refunded';
        payment_date?: string;
        date_created?: string;
      }>;
    };
    return json.results.map((p) => ({
      id: p.id,
      amountCents: Math.round(p.transaction_amount * 100),
      status: p.status,
      paidAt: p.payment_date ? new Date(p.payment_date) : null,
      dueAt: p.date_created ? new Date(p.date_created) : null,
    }));
  }

  async healthCheck(): Promise<{ ok: boolean }> {
    try {
      await this.request('GET', '/preapproval/search?limit=1');
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  private async request(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) {
    const res = await this.fetchImpl(`${this.opts.apiBaseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.opts.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.ok) return res;

    const errBody = await safeJson(res);
    this.logger.warn({
      event: 'mercadopago.request_failed',
      method,
      path,
      statusCode: res.status,
      providerMessage: errBody?.message,
      providerError: errBody?.error,
      providerCause: errBody?.cause,
      providerBody: errBody,
      requestBody: body,
    });
    if (res.status === 401 || res.status === 403) {
      throw new DomainException({
        code: ErrorCodes.BILLING_PROVIDER_UNAUTHORIZED,
        message: 'Provedor de pagamento rejeitou as credenciais.',
        status: HttpStatus.BAD_GATEWAY,
        details: { statusCode: res.status, providerMessage: errBody?.message },
      });
    }
    throw new DomainException({
      code: ErrorCodes.BILLING_PROVIDER_ERROR,
      message: 'Falha ao falar com o provedor de pagamento.',
      status: HttpStatus.BAD_GATEWAY,
      details: { statusCode: res.status, providerMessage: errBody?.message },
    });
  }
}

async function safeJson(
  res: Response,
): Promise<{ message?: string; error?: string; cause?: unknown } | null> {
  try {
    return (await res.json()) as { message?: string; error?: string; cause?: unknown };
  } catch {
    return null;
  }
}
