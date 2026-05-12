import {
  BillingProvider,
  CreatePreapprovalInput,
  CreatePreapprovalResult,
  ListPaymentsQuery,
  RemotePayment,
  RemoteSubscription,
  RemoteSubscriptionStatus,
} from './billing.provider';

export interface ConsoleBillingProviderOptions {
  returnUrl: string;
}

interface ConsoleSubscriptionState {
  status: RemoteSubscriptionStatus;
  nextPaymentDate: Date | null;
  payments: RemotePayment[];
}

export class ConsoleBillingProvider implements BillingProvider {
  private counter = 0;
  private store = new Map<string, ConsoleSubscriptionState>();

  constructor(private readonly opts: ConsoleBillingProviderOptions) {}

  createPreapproval(input: CreatePreapprovalInput): Promise<CreatePreapprovalResult> {
    this.counter += 1;
    const id = `CONSOLE-PRE-${input.tenantId}-${this.counter}`;
    this.store.set(id, { status: 'pending', nextPaymentDate: null, payments: [] });
    return Promise.resolve({
      preapprovalId: id,
      initPoint: `${this.opts.returnUrl}?ok=1&preapproval_id=${id}`,
    });
  }

  fetchPreapproval(preapprovalId: string): Promise<RemoteSubscription> {
    const s = this.store.get(preapprovalId);
    if (!s) {
      return Promise.resolve({ preapprovalId, status: 'pending', nextPaymentDate: null });
    }
    return Promise.resolve({
      preapprovalId,
      status: s.status,
      nextPaymentDate: s.nextPaymentDate,
    });
  }

  cancelPreapproval(preapprovalId: string): Promise<void> {
    const s = this.store.get(preapprovalId);
    if (s) {
      s.status = 'cancelled';
      s.nextPaymentDate = null;
    }
    return Promise.resolve();
  }

  listPayments(preapprovalId: string, q: ListPaymentsQuery): Promise<RemotePayment[]> {
    const s = this.store.get(preapprovalId);
    if (!s) return Promise.resolve([]);
    const start = (q.page - 1) * q.pageSize;
    return Promise.resolve(s.payments.slice(start, start + q.pageSize));
  }

  healthCheck(): Promise<{ ok: boolean }> {
    return Promise.resolve({ ok: true });
  }

  // ---- test hooks (não fazem parte da interface) ----
  __test_advance(
    preapprovalId: string,
    status: RemoteSubscriptionStatus,
    nextPaymentDate: Date | null,
  ): void {
    const s = this.store.get(preapprovalId);
    if (!s) throw new Error(`Unknown preapproval ${preapprovalId}`);
    s.status = status;
    s.nextPaymentDate = nextPaymentDate;
  }

  __test_addPayment(preapprovalId: string, payment: RemotePayment): void {
    const s = this.store.get(preapprovalId);
    if (!s) throw new Error(`Unknown preapproval ${preapprovalId}`);
    s.payments.push(payment);
  }

  __test_reset(): void {
    this.counter = 0;
    this.store.clear();
  }
}
