import { HttpStatus } from '@nestjs/common';
import { AvailabilityService } from './availability.service';
import type { BusinessHours } from 'src/modules/tenants/business-hours';

function bhMondayOnly9to12(): BusinessHours {
  const days = Array.from({ length: 7 }, () => ({
    open: false,
    intervals: [] as { startMin: number; endMin: number }[],
  }));
  days[1] = { open: true, intervals: [{ startMin: 9 * 60, endMin: 12 * 60 }] };
  return { days };
}

describe('AvailabilityService', () => {
  let svc: AvailabilityService;
  const now = new Date('2025-05-11T12:00:00Z'); // dom 09:00 SP

  beforeEach(() => {
    svc = new AvailabilityService(() => now);
  });

  it('gera slots de 15min dentro de business hours, respeitando duração do serviço', () => {
    const slots = svc.computeSlots({
      tenantTimezone: 'America/Sao_Paulo',
      businessHours: bhMondayOnly9to12(),
      durationMin: 30,
      barberId: 'b1',
      timeOffs: [],
      appointments: [],
      from: new Date('2025-05-12T00:00:00Z'),
      to: new Date('2025-05-13T00:00:00Z'),
    });
    // Segunda 09:00..12:00 SP → 12:00..15:00 UTC. Slots de 15min com duração 30min:
    // 09:00, 09:15, 09:30, ..., 11:30 (último que cabe 30min dentro de 12:00)
    // = 11 slots
    expect(slots).toHaveLength(11);
    expect(slots[0].startsAt.toISOString()).toBe('2025-05-12T12:00:00.000Z');
    expect(slots[10].startsAt.toISOString()).toBe('2025-05-12T14:30:00.000Z');
  });

  it('exclui slots que cruzam o fim do intervalo (duração não cabe)', () => {
    const slots = svc.computeSlots({
      tenantTimezone: 'America/Sao_Paulo',
      businessHours: bhMondayOnly9to12(),
      durationMin: 90,
      barberId: 'b1',
      timeOffs: [],
      appointments: [],
      from: new Date('2025-05-12T00:00:00Z'),
      to: new Date('2025-05-13T00:00:00Z'),
    });
    // 09:00..10:30 último que cabe 90min antes de 12:00
    expect(slots[slots.length - 1].startsAt.toISOString()).toBe('2025-05-12T13:30:00.000Z');
  });

  it('dia fechado não gera slots', () => {
    const slots = svc.computeSlots({
      tenantTimezone: 'America/Sao_Paulo',
      businessHours: bhMondayOnly9to12(),
      durationMin: 30,
      barberId: 'b1',
      timeOffs: [],
      appointments: [],
      from: new Date('2025-05-13T00:00:00Z'), // terça (fechado)
      to: new Date('2025-05-14T00:00:00Z'),
    });
    expect(slots).toHaveLength(0);
  });

  it('exclui slots que sobrepõem TimeOff', () => {
    const slots = svc.computeSlots({
      tenantTimezone: 'America/Sao_Paulo',
      businessHours: bhMondayOnly9to12(),
      durationMin: 30,
      barberId: 'b1',
      timeOffs: [
        {
          barberId: 'b1',
          startsAt: new Date('2025-05-12T13:00:00Z'), // 10:00 SP
          endsAt: new Date('2025-05-12T14:00:00Z'), // 11:00 SP
        },
      ],
      appointments: [],
      from: new Date('2025-05-12T00:00:00Z'),
      to: new Date('2025-05-13T00:00:00Z'),
    });
    // Removidos: 09:45 (sobrepõe), 10:00..10:45 (4 slots) = 5 slots fora
    const isos = slots.map((s) => s.startsAt.toISOString());
    expect(isos).not.toContain('2025-05-12T12:45:00.000Z');
    expect(isos).not.toContain('2025-05-12T13:00:00.000Z');
    expect(isos).not.toContain('2025-05-12T13:45:00.000Z');
    expect(isos).toContain('2025-05-12T14:00:00.000Z'); // 11:00 SP - começa exatamente quando timeOff acaba
  });

  it('exclui slots que sobrepõem Appointment ativo', () => {
    const slots = svc.computeSlots({
      tenantTimezone: 'America/Sao_Paulo',
      businessHours: bhMondayOnly9to12(),
      durationMin: 30,
      barberId: 'b1',
      timeOffs: [],
      appointments: [
        {
          barberId: 'b1',
          startsAt: new Date('2025-05-12T13:00:00Z'),
          endsAt: new Date('2025-05-12T13:30:00Z'),
        },
      ],
      from: new Date('2025-05-12T00:00:00Z'),
      to: new Date('2025-05-13T00:00:00Z'),
    });
    const isos = slots.map((s) => s.startsAt.toISOString());
    expect(isos).not.toContain('2025-05-12T12:45:00.000Z');
    expect(isos).not.toContain('2025-05-12T13:00:00.000Z');
    expect(isos).not.toContain('2025-05-12T13:15:00.000Z');
    expect(isos).toContain('2025-05-12T13:30:00.000Z');
  });

  it('filtra slots no passado', () => {
    const svcWithLaterNow = new AvailabilityService(() => new Date('2025-05-12T13:15:00Z')); // 10:15 SP
    const slots = svcWithLaterNow.computeSlots({
      tenantTimezone: 'America/Sao_Paulo',
      businessHours: bhMondayOnly9to12(),
      durationMin: 30,
      barberId: 'b1',
      timeOffs: [],
      appointments: [],
      from: new Date('2025-05-12T00:00:00Z'),
      to: new Date('2025-05-13T00:00:00Z'),
    });
    expect(slots.every((s) => s.startsAt > new Date('2025-05-12T13:15:00Z'))).toBe(true);
  });

  it('valida range from/to (rejeita > 31 dias)', () => {
    expect(() =>
      svc.assertRangeValid(new Date('2026-05-01T00:00:00Z'), new Date('2026-07-01T00:00:00Z')),
    ).toThrow(expect.objectContaining({ status: HttpStatus.BAD_REQUEST }));
  });

  it('valida range from/to (rejeita to <= from)', () => {
    expect(() =>
      svc.assertRangeValid(new Date('2026-05-12T00:00:00Z'), new Date('2026-05-11T00:00:00Z')),
    ).toThrow();
  });

  it('aceita business hours com 2 intervalos no mesmo dia (almoço)', () => {
    const days = Array.from({ length: 7 }, () => ({
      open: false,
      intervals: [] as { startMin: number; endMin: number }[],
    }));
    days[1] = {
      open: true,
      intervals: [
        { startMin: 9 * 60, endMin: 12 * 60 },
        { startMin: 14 * 60, endMin: 18 * 60 },
      ],
    };
    const slots = svc.computeSlots({
      tenantTimezone: 'America/Sao_Paulo',
      businessHours: { days },
      durationMin: 30,
      barberId: 'b1',
      timeOffs: [],
      appointments: [],
      from: new Date('2025-05-12T00:00:00Z'),
      to: new Date('2025-05-13T00:00:00Z'),
    });
    const isos = slots.map((s) => s.startsAt.toISOString());
    // não tem slots entre 12:00 e 14:00 local (15:00..17:00 UTC)
    expect(
      isos.some((i) => i >= '2025-05-12T15:00:00.000Z' && i < '2025-05-12T17:00:00.000Z'),
    ).toBe(false);
    expect(isos).toContain('2025-05-12T17:00:00.000Z'); // 14:00 SP
  });
});

describe('AvailabilityService.getAvailabilityByService', () => {
  function bhAllDays9to18() {
    return {
      days: Array.from({ length: 7 }, () => ({
        open: true,
        intervals: [{ startMin: 9 * 60, endMin: 18 * 60 }],
      })),
    };
  }

  it('agrupa por barberId, chamando computeSlots por barbeiro', () => {
    const svc = new AvailabilityService(() => new Date('2025-05-11T12:00:00Z'));
    const spy = jest.spyOn(svc, 'computeSlots');
    spy.mockImplementation((i) => [
      { barberId: i.barberId, startsAt: i.from, endsAt: new Date(i.from.getTime() + 60000) },
    ]);

    const out = svc.getAvailabilityByService({
      tenantTimezone: 'America/Sao_Paulo',
      businessHours: bhAllDays9to18(),
      durationMin: 30,
      barberIds: ['b1', 'b2'],
      timeOffsByBarber: { b1: [], b2: [] },
      appointmentsByBarber: { b1: [], b2: [] },
      from: new Date('2025-05-12T00:00:00Z'),
      to: new Date('2025-05-13T00:00:00Z'),
    });

    expect(out).toHaveLength(2);
    expect(out[0].barberId).toBe('b1');
    expect(out[1].barberId).toBe('b2');
    expect(out[0].slots).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
