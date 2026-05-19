export const BILLING_PROVIDER = Symbol('BILLING_PROVIDER');

export type RemoteSubscriptionStatus = 'pending' | 'authorized' | 'paused' | 'cancelled';

export interface CreatePreapprovalInput {
  tenantId: string;
  tenantSlug: string;
  payerEmail: string;
  payerName: string;
  payerCpfCnpj?: string;
  reason: string; // título visível pro payer ("Assinatura KairoBarber - {slug}")
  amountCents: number;
  frequency: 'months';
}

export interface CreatePreapprovalResult {
  preapprovalId: string;
  initPoint: string; // URL pra redirecionar o usuário
}

export interface RemoteSubscription {
  preapprovalId: string;
  status: RemoteSubscriptionStatus;
  nextPaymentDate: Date | null;
}

export interface RemotePayment {
  id: string;
  amountCents: number;
  status: 'approved' | 'rejected' | 'pending' | 'refunded';
  paidAt: Date | null;
  dueAt: Date | null;
}

export interface ListPaymentsQuery {
  page: number; // 1-based
  pageSize: number; // 1..50
}

export interface BillingProvider {
  createPreapproval(input: CreatePreapprovalInput): Promise<CreatePreapprovalResult>;
  fetchPreapproval(preapprovalId: string): Promise<RemoteSubscription>;
  cancelPreapproval(preapprovalId: string): Promise<void>;
  listPayments(preapprovalId: string, q: ListPaymentsQuery): Promise<RemotePayment[]>;
  healthCheck(): Promise<{ ok: boolean }>;
}
