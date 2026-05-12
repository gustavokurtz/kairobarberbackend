export type AppointmentConfirmationInput = {
  customerName: string;
  tenantName: string;
  tenantSlug: string;
  barberName: string;
  serviceName: string;
  startsAtLocal: string;
  priceFormatted: string;
  cancelUrl: string;
  claimUrl?: string;
};

export function appointmentConfirmationTemplate(i: AppointmentConfirmationInput): {
  subject: string;
  text: string;
} {
  const claimSection = i.claimUrl
    ? `\n\nQuer acompanhar seus agendamentos? Crie sua conta em:\n${i.claimUrl}\n`
    : '';
  return {
    subject: `Agendamento confirmado em ${i.tenantName}`,
    text:
      `Olá ${i.customerName}!\n\n` +
      `Seu agendamento em ${i.tenantName} foi registrado:\n` +
      `• Serviço: ${i.serviceName}\n` +
      `• Barbeiro: ${i.barberName}\n` +
      `• Horário: ${i.startsAtLocal}\n` +
      `• Valor: ${i.priceFormatted}\n\n` +
      `Precisa cancelar? Use o link (até 2h antes):\n${i.cancelUrl}` +
      claimSection +
      `\nObrigado!\n— ${i.tenantName}`,
  };
}
