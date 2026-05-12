import {
  dayOfWeekInZone,
  minutesSinceMidnightInZone,
  combineDateAndMinutesInZone,
  formatLocal,
} from './time-utils';

describe('time-utils', () => {
  it('dayOfWeekInZone retorna 0 (Sun)..6 (Sat) na zona dada', () => {
    // 2026-05-12T03:00:00Z = 2026-05-12 00:00 em São Paulo (UTC-3) → terça → 2
    expect(dayOfWeekInZone(new Date('2026-05-12T03:00:00Z'), 'America/Sao_Paulo')).toBe(2);
    // 2026-05-12T02:00:00Z = 2026-05-11 23:00 em São Paulo → segunda → 1
    expect(dayOfWeekInZone(new Date('2026-05-12T02:00:00Z'), 'America/Sao_Paulo')).toBe(1);
  });

  it('minutesSinceMidnightInZone retorna minutos desde 00:00 local', () => {
    // 14:30 local SP = 17:30 UTC
    expect(minutesSinceMidnightInZone(new Date('2026-05-12T17:30:00Z'), 'America/Sao_Paulo')).toBe(
      14 * 60 + 30,
    );
  });

  it('combineDateAndMinutesInZone monta UTC a partir de "dia local + minutos"', () => {
    // 12/05/2026 14:00 em São Paulo → 17:00 UTC
    const utc = combineDateAndMinutesInZone(
      new Date('2026-05-12T15:00:00Z'), // qualquer instante no mesmo dia local
      14 * 60,
      'America/Sao_Paulo',
    );
    expect(utc.toISOString()).toBe('2026-05-12T17:00:00.000Z');
  });

  it('formatLocal devolve string pt-BR esperada', () => {
    const s = formatLocal(new Date('2026-05-12T17:00:00Z'), 'America/Sao_Paulo');
    expect(s).toBe('12/05/2026 14:00');
  });
});
