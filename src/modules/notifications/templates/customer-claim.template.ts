export type CustomerClaimInput = {
  customerName: string;
  tenantName: string;
  claimUrl: string;
};

export function customerClaimTemplate(i: CustomerClaimInput): { subject: string; text: string } {
  return {
    subject: `Crie sua conta no KairoBarber`,
    text:
      `Olá ${i.customerName}!\n\n` +
      `Você fez um agendamento em ${i.tenantName}. ` +
      `Crie uma conta para acompanhar seus agendamentos:\n${i.claimUrl}\n\n` +
      `O link expira em 7 dias.`,
  };
}
