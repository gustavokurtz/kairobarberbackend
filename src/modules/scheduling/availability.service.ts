import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { DateTime } from 'luxon';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';
import type { BusinessHours } from 'src/modules/tenants/business-hours';
import { combineDateAndMinutesInZone, dayOfWeekInZone, intervalsOverlap } from './time-utils';

export type Slot = { barberId: string; startsAt: Date; endsAt: Date };
export type TimeOffWindow = { barberId: string; startsAt: Date; endsAt: Date };
export type AppointmentWindow = { barberId: string; startsAt: Date; endsAt: Date };

export type ComputeSlotsInput = {
  tenantTimezone: string;
  businessHours: BusinessHours;
  durationMin: number;
  barberId: string;
  timeOffs: TimeOffWindow[];
  appointments: AppointmentWindow[];
  from: Date;
  to: Date;
};

export type AvailabilityByServiceInput = {
  tenantTimezone: string;
  businessHours: BusinessHours;
  durationMin: number;
  barberIds: string[];
  timeOffsByBarber: Record<string, TimeOffWindow[]>;
  appointmentsByBarber: Record<string, AppointmentWindow[]>;
  from: Date;
  to: Date;
};

export type AvailabilityGroup = { barberId: string; slots: Slot[] };

export const SLOT_STEP_MIN = 15;
export const MAX_RANGE_DAYS = 31;

export const NOW_PROVIDER = Symbol('NOW_PROVIDER');

@Injectable()
export class AvailabilityService {
  constructor(
    @Optional() @Inject(NOW_PROVIDER) private readonly nowFn: () => Date = () => new Date(),
  ) {}

  assertRangeValid(from: Date, to: Date): void {
    if (!(to > from)) {
      throw new DomainException({
        code: ErrorCodes.AVAILABILITY_RANGE_INVALID,
        message: 'to deve ser maior que from.',
        status: HttpStatus.BAD_REQUEST,
      });
    }
    const days = (to.getTime() - from.getTime()) / (24 * 3600 * 1000);
    if (days > MAX_RANGE_DAYS) {
      throw new DomainException({
        code: ErrorCodes.AVAILABILITY_RANGE_INVALID,
        message: `Range máximo ${MAX_RANGE_DAYS} dias.`,
        status: HttpStatus.BAD_REQUEST,
      });
    }
  }

  computeSlots(input: ComputeSlotsInput): Slot[] {
    this.assertRangeValid(input.from, input.to);
    const now = this.nowFn();
    const out: Slot[] = [];

    // Itera dia por dia (na zona local). Cada dia gera slots dos seus intervals.
    let cursor = DateTime.fromJSDate(input.from, { zone: input.tenantTimezone }).startOf('day');
    const end = DateTime.fromJSDate(input.to, { zone: input.tenantTimezone });

    while (cursor < end) {
      const dayJs = cursor.toJSDate();
      const dow = dayOfWeekInZone(dayJs, input.tenantTimezone);
      const day = input.businessHours.days[dow];
      if (day?.open) {
        for (const interval of day.intervals) {
          for (
            let m = interval.startMin;
            m + input.durationMin <= interval.endMin;
            m += SLOT_STEP_MIN
          ) {
            const slotStart = combineDateAndMinutesInZone(dayJs, m, input.tenantTimezone);
            const slotEnd = new Date(slotStart.getTime() + input.durationMin * 60 * 1000);

            if (slotStart <= now) continue;
            if (slotStart < input.from || slotEnd > input.to) continue;

            const blockedByTimeOff = input.timeOffs.some(
              (t) =>
                t.barberId === input.barberId &&
                intervalsOverlap(slotStart, slotEnd, t.startsAt, t.endsAt),
            );
            if (blockedByTimeOff) continue;

            const blockedByAppt = input.appointments.some(
              (a) =>
                a.barberId === input.barberId &&
                intervalsOverlap(slotStart, slotEnd, a.startsAt, a.endsAt),
            );
            if (blockedByAppt) continue;

            out.push({ barberId: input.barberId, startsAt: slotStart, endsAt: slotEnd });
          }
        }
      }
      cursor = cursor.plus({ days: 1 });
    }

    return out;
  }

  getAvailabilityByService(i: AvailabilityByServiceInput): AvailabilityGroup[] {
    return i.barberIds.map((barberId) => ({
      barberId,
      slots: this.computeSlots({
        tenantTimezone: i.tenantTimezone,
        businessHours: i.businessHours,
        durationMin: i.durationMin,
        barberId,
        timeOffs: i.timeOffsByBarber[barberId] ?? [],
        appointments: i.appointmentsByBarber[barberId] ?? [],
        from: i.from,
        to: i.to,
      }),
    }));
  }
}
