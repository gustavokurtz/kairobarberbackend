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

export type AsaasBillingCycle =
  | 'WEEKLY'
  | 'BIWEEKLY'
  | 'MONTHLY'
  | 'QUARTERLY'
  | 'SEMIANNUALLY'
  | 'YEARLY';

export interface AsaasBillingProviderOptions {
  apiKey: string;
  apiBaseUrl: string;
  billingCycle: AsaasBillingCycle;
  /** Quando definido, é enviado como `callback.successUrl` na criação da subscription. */
  returnUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

type AsaasSubscriptionStatus = 'ACTIVE' | 'EXPIRED' | 'INACTIVE';

type AsaasPaymentStatus =
  | 'PENDING'
  | 'RECEIVED'
  | 'CONFIRMED'
  | 'OVERDUE'
  | 'REFUNDED'
  | 'RECEIVED_IN_CASH'
  | 'REFUND_REQUESTED'
  | 'CHARGEBACK_REQUESTED'
  | 'CHARGEBACK_DISPUTE'
  | 'AWAITING_CHARGEBACK_REVERSAL'
  | 'DUNNING_REQUESTED'
  | 'DUNNING_RECEIVED'
  | 'AWAITING_RISK_ANALYSIS';

interface AsaasSubscriptionResponse {
  id: string;
  status: AsaasSubscriptionStatus;
  nextDueDate?: string;
}

interface AsaasPaymentResponse {
  id: string;
  status: AsaasPaymentStatus;
  value: number;
  dueDate?: string;
  paymentDate?: string;
  invoiceUrl?: string;
}

interface AsaasList<T> {
  data: T[];
  hasMore?: boolean;
  totalCount?: number;
}

interface AsaasCustomerResponse {
  id: string;
  externalReference?: string | null;
}

export class AsaasBillingProvider implements BillingProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly nowFn: () => Date;
  private readonly logger = new Logger(AsaasBillingProvider.name);

  constructor(private readonly opts: AsaasBillingProviderOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.nowFn = opts.now ?? (() => new Date());
  }

  async createPreapproval(input: CreatePreapprovalInput): Promise<CreatePreapprovalResult> {
    const customerId = await this.findOrCreateCustomer(input);

    const today = this.nowFn();
    const nextDueDate = formatYmd(today);

    const subscriptionBody: Record<string, unknown> = {
      customer: customerId,
      billingType: 'UNDEFINED',
      value: input.amountCents / 100,
      nextDueDate,
      cycle: this.opts.billingCycle,
      description: input.reason,
      externalReference: input.tenantId,
    };
    if (this.opts.returnUrl) {
      subscriptionBody.callback = { successUrl: this.opts.returnUrl, autoRedirect: true };
    }

    const subRes = await this.request('POST', '/v3/subscriptions', subscriptionBody);
    const sub = (await subRes.json()) as AsaasSubscriptionResponse;

    const firstInvoiceUrl = await this.fetchFirstInvoiceUrl(sub.id);
    if (!firstInvoiceUrl) {
      throw new DomainException({
        code: ErrorCodes.BILLING_PROVIDER_ERROR,
        message: 'Asaas criou a assinatura mas não retornou link de pagamento.',
        status: HttpStatus.BAD_GATEWAY,
        details: { subscriptionId: sub.id },
      });
    }

    return { preapprovalId: sub.id, initPoint: firstInvoiceUrl };
  }

  async fetchPreapproval(preapprovalId: string): Promise<RemoteSubscription> {
    const subRes = await this.request(
      'GET',
      `/v3/subscriptions/${encodeURIComponent(preapprovalId)}`,
    );
    const sub = (await subRes.json()) as AsaasSubscriptionResponse;

    if (sub.status === 'INACTIVE') {
      return { preapprovalId: sub.id, status: 'cancelled', nextPaymentDate: null };
    }
    if (sub.status === 'EXPIRED') {
      return { preapprovalId: sub.id, status: 'paused', nextPaymentDate: null };
    }

    const paymentsRes = await this.request(
      'GET',
      `/v3/subscriptions/${encodeURIComponent(preapprovalId)}/payments?limit=20`,
    );
    const payments = ((await paymentsRes.json()) as AsaasList<AsaasPaymentResponse>).data ?? [];

    const status = derivePreapprovalStatusFromPayments(payments);
    const nextPaymentDate = sub.nextDueDate ? new Date(sub.nextDueDate) : null;

    return { preapprovalId: sub.id, status, nextPaymentDate };
  }

  async cancelPreapproval(preapprovalId: string): Promise<void> {
    try {
      await this.request('DELETE', `/v3/subscriptions/${encodeURIComponent(preapprovalId)}`);
    } catch (err) {
      if (err instanceof DomainException && err.opts.details?.statusCode === 404) {
        return; // idempotente
      }
      throw err;
    }
  }

  async listPayments(preapprovalId: string, q: ListPaymentsQuery): Promise<RemotePayment[]> {
    const offset = (q.page - 1) * q.pageSize;
    const url = `/v3/subscriptions/${encodeURIComponent(
      preapprovalId,
    )}/payments?offset=${offset}&limit=${q.pageSize}`;
    const res = await this.request('GET', url);
    const json = (await res.json()) as AsaasList<AsaasPaymentResponse>;
    return (json.data ?? []).map((p) => ({
      id: p.id,
      amountCents: Math.round((p.value ?? 0) * 100),
      status: mapPaymentStatus(p.status),
      paidAt: p.paymentDate ? new Date(p.paymentDate) : null,
      dueAt: p.dueDate ? new Date(p.dueDate) : null,
    }));
  }

  async healthCheck(): Promise<{ ok: boolean }> {
    try {
      await this.request('GET', '/v3/customers?limit=1');
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  private async findOrCreateCustomer(input: CreatePreapprovalInput): Promise<string> {
    const searchRes = await this.request(
      'GET',
      `/v3/customers?externalReference=${encodeURIComponent(input.tenantId)}&limit=1`,
    );
    const searchJson = (await searchRes.json()) as AsaasList<AsaasCustomerResponse>;
    const existing = searchJson.data?.[0];
    if (existing?.id) {
      // Customer existente pode ter sido criado em rodada anterior sem cpfCnpj (ou com dados
      // desatualizados). Asaas exige cpfCnpj pra gerar cobrança PIX/boleto, e o customer não
      // herda automaticamente dados novos. Re-sincroniza name/email/cpfCnpj antes de criar a
      // subscription — sem isso, o POST /v3/subscriptions falha com 400 "CPF obrigatório".
      const updateBody: Record<string, unknown> = {
        name: input.payerName,
        email: input.payerEmail,
      };
      if (input.payerCpfCnpj) updateBody.cpfCnpj = input.payerCpfCnpj;
      await this.request(
        'PUT',
        `/v3/customers/${encodeURIComponent(existing.id)}`,
        updateBody,
      );
      return existing.id;
    }

    const customerBody: Record<string, unknown> = {
      name: input.payerName,
      email: input.payerEmail,
      externalReference: input.tenantId,
      notificationDisabled: false,
    };
    if (input.payerCpfCnpj) customerBody.cpfCnpj = input.payerCpfCnpj;

    const res = await this.request('POST', '/v3/customers', customerBody);
    const created = (await res.json()) as AsaasCustomerResponse;
    return created.id;
  }

  private async fetchFirstInvoiceUrl(subscriptionId: string): Promise<string | null> {
    const res = await this.request(
      'GET',
      `/v3/subscriptions/${encodeURIComponent(subscriptionId)}/payments?limit=1`,
    );
    const json = (await res.json()) as AsaasList<AsaasPaymentResponse>;
    return json.data?.[0]?.invoiceUrl ?? null;
  }

  private async request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) {
    const res = await this.fetchImpl(`${this.opts.apiBaseUrl}${path}`, {
      method,
      headers: {
        access_token: this.opts.apiKey,
        'Content-Type': 'application/json',
        'User-Agent': 'kairobarber-api',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return res;

    const errBody = await safeJson(res);
    const firstError = errBody?.errors?.[0];
    this.logger.warn({
      event: 'asaas.request_failed',
      method,
      path,
      statusCode: res.status,
      providerCode: firstError?.code,
      providerMessage: firstError?.description,
      requestBody: sanitizeBody(body),
    });
    if (res.status === 401 || res.status === 403) {
      throw new DomainException({
        code: ErrorCodes.BILLING_PROVIDER_UNAUTHORIZED,
        message: 'Provedor de pagamento (Asaas) rejeitou as credenciais.',
        status: HttpStatus.BAD_GATEWAY,
        details: { statusCode: res.status, providerMessage: firstError?.description },
      });
    }
    throw new DomainException({
      code: ErrorCodes.BILLING_PROVIDER_ERROR,
      message: 'Falha ao falar com o provedor de pagamento (Asaas).',
      status: HttpStatus.BAD_GATEWAY,
      details: { statusCode: res.status, providerMessage: firstError?.description },
    });
  }
}

const PII_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'email',
  'cpfCnpj',
  'phone',
  'mobilePhone',
  'address',
  'addressNumber',
  'complement',
  'postalCode',
  'creditCard',
  'creditCardHolderInfo',
]);

function sanitizeBody(body: unknown): unknown {
  if (body === undefined || body === null) return body;
  if (typeof body !== 'object') return body;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (PII_FIELDS.has(k)) {
      out[k] = '[redacted]';
    } else {
      out[k] = v;
    }
  }
  return out;
}

function formatYmd(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function mapPaymentStatus(s: AsaasPaymentStatus): RemotePayment['status'] {
  switch (s) {
    case 'RECEIVED':
    case 'CONFIRMED':
    case 'RECEIVED_IN_CASH':
    case 'DUNNING_RECEIVED':
      return 'approved';
    case 'REFUNDED':
      return 'refunded';
    default:
      return 'pending';
  }
}

function derivePreapprovalStatusFromPayments(
  payments: AsaasPaymentResponse[],
): RemoteSubscriptionStatus {
  if (payments.length === 0) return 'pending';
  const hasReceived = payments.some(
    (p) => p.status === 'RECEIVED' || p.status === 'CONFIRMED' || p.status === 'RECEIVED_IN_CASH',
  );
  if (hasReceived) return 'authorized';
  const hasOverdue = payments.some((p) => p.status === 'OVERDUE');
  if (hasOverdue) return 'paused';
  return 'pending';
}

async function safeJson(
  res: Response,
): Promise<{ errors?: Array<{ code?: string; description?: string }> } | null> {
  try {
    return (await res.json()) as { errors?: Array<{ code?: string; description?: string }> };
  } catch {
    return null;
  }
}
