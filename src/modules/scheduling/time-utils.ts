import { DateTime } from 'luxon';

export function dayOfWeekInZone(d: Date, zone: string): number {
  // Luxon: weekday 1=Monday..7=Sunday. We want 0=Sun..6=Sat (matches BusinessHours.days indexing).
  const wd = DateTime.fromJSDate(d, { zone }).weekday; // 1..7
  return wd === 7 ? 0 : wd;
}

export function minutesSinceMidnightInZone(d: Date, zone: string): number {
  const local = DateTime.fromJSDate(d, { zone });
  return local.hour * 60 + local.minute;
}

export function combineDateAndMinutesInZone(
  anyInstantOnDay: Date,
  minutesSinceMidnight: number,
  zone: string,
): Date {
  const localDay = DateTime.fromJSDate(anyInstantOnDay, { zone }).startOf('day');
  return localDay.plus({ minutes: minutesSinceMidnight }).toUTC().toJSDate();
}

export function formatLocal(d: Date, zone: string): string {
  return DateTime.fromJSDate(d, { zone }).toFormat('dd/LL/yyyy HH:mm');
}

export function priceFormatBRL(cents: number): string {
  return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

export function intervalsOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}
