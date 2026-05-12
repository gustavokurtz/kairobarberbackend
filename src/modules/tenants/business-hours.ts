import { HttpStatus } from '@nestjs/common';
import { DomainException } from 'src/common/exceptions/domain.exception';
import { ErrorCodes } from 'src/common/exceptions/error-codes';

export type BusinessInterval = { startMin: number; endMin: number };
export type BusinessDay = { open: boolean; intervals: BusinessInterval[] };
export type BusinessHours = { days: BusinessDay[] };

export const BUSINESS_HOURS_EMPTY: BusinessHours = {
  days: Array.from({ length: 7 }, () => ({ open: false, intervals: [] })),
};

function fail(message: string): never {
  throw new DomainException({
    code: ErrorCodes.BUSINESS_HOURS_INVALID,
    message,
    status: HttpStatus.BAD_REQUEST,
  });
}

export function validateBusinessHours(input: unknown): asserts input is BusinessHours {
  if (!input || typeof input !== 'object') fail('businessHours must be an object');
  const days = (input as { days?: unknown }).days;
  if (!Array.isArray(days) || days.length !== 7) {
    fail('businessHours.days must have exactly 7 entries (Sun..Sat)');
  }
  for (let i = 0; i < 7; i++) {
    const day = days[i] as { open?: unknown; intervals?: unknown };
    if (typeof day.open !== 'boolean') fail(`day[${i}].open must be boolean`);
    if (!Array.isArray(day.intervals)) fail(`day[${i}].intervals must be an array`);

    if (!day.open && day.intervals.length > 0) {
      fail(`day[${i}] is closed but has intervals`);
    }

    const intervals = day.intervals as BusinessInterval[];
    for (let j = 0; j < intervals.length; j++) {
      const iv = intervals[j];
      if (
        typeof iv.startMin !== 'number' ||
        typeof iv.endMin !== 'number' ||
        !Number.isInteger(iv.startMin) ||
        !Number.isInteger(iv.endMin)
      ) {
        fail(`day[${i}].intervals[${j}] must have integer startMin/endMin`);
      }
      if (iv.startMin < 0 || iv.endMin > 1440) {
        fail(`day[${i}].intervals[${j}] must be within 0..1440`);
      }
      if (iv.startMin >= iv.endMin) {
        fail(`day[${i}].intervals[${j}] startMin must be < endMin`);
      }
    }
    const sorted = [...intervals].sort((a, b) => a.startMin - b.startMin);
    for (let j = 1; j < sorted.length; j++) {
      if (sorted[j].startMin < sorted[j - 1].endMin) {
        fail(`day[${i}] intervals overlap`);
      }
    }
  }
}
