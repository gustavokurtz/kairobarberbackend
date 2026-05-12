export type AppointmentCancellationInput = {
  customerName: string;
  tenantName: string;
  startsAtLocal: string;
  cancellationReason?: string;
};

export function appointmentCancellationTemplate(i: AppointmentCancellationInput): {
  subject: string;
  text: string;
} {
  const reason = i.cancellationReason ? `\n\nMotivo: ${i.cancellationReason}` : '';
  return {
    subject: `Agendamento cancelado em ${i.tenantName}`,
    text:
      `Olá ${i.customerName}!\n\n` +
      `Seu agendamento em ${i.tenantName} (${i.startsAtLocal}) foi cancelado.` +
      reason +
      `\n\n— ${i.tenantName}`,
  };
}
