import {
  appointmentConfirmationTemplate,
  appointmentCancellationTemplate,
  customerClaimTemplate,
} from './index';

describe('email templates', () => {
  const baseAppt = {
    customerName: 'João',
    tenantName: 'Studio Bigode',
    tenantSlug: 'studio-bigode',
    barberName: 'Pedro',
    serviceName: 'Corte clássico',
    startsAtLocal: '12/05/2026 14:00',
    priceFormatted: 'R$ 45,00',
    cancelUrl: 'http://localhost:3000/studio-bigode/agendamentos/abc/cancelar?token=tok123',
    claimUrl: 'http://localhost:3000/conta/claim?token=clm456',
  };

  it('confirmação inclui dados e link de cancelar', () => {
    const out = appointmentConfirmationTemplate(baseAppt);
    expect(out.subject).toMatch(/Studio Bigode/);
    expect(out.text).toMatch(/12\/05\/2026 14:00/);
    expect(out.text).toMatch(/Pedro/);
    expect(out.text).toMatch(/Corte clássico/);
    expect(out.text).toMatch(/R\$ 45,00/);
    expect(out.text).toContain(baseAppt.cancelUrl);
  });

  it('confirmação omite seção de claim quando claimUrl ausente', () => {
    const out = appointmentConfirmationTemplate({ ...baseAppt, claimUrl: undefined });
    expect(out.text).not.toMatch(/Crie sua conta|claim/i);
  });

  it('cancelamento inclui motivo se houver', () => {
    const out = appointmentCancellationTemplate({
      customerName: 'João',
      tenantName: 'Studio Bigode',
      startsAtLocal: '12/05/2026 14:00',
      cancellationReason: 'Barbeiro doente',
    });
    expect(out.text).toMatch(/Barbeiro doente/);
  });

  it('claim aponta para URL com token', () => {
    const out = customerClaimTemplate({
      customerName: 'João',
      tenantName: 'Studio Bigode',
      claimUrl: 'http://localhost:3000/conta/claim?token=clm456',
    });
    expect(out.text).toContain('clm456');
  });
});
