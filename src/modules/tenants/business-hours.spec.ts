import { validateBusinessHours, BUSINESS_HOURS_EMPTY, BusinessDay } from './business-hours';

const CLOSED_DAY: BusinessDay = { open: false, intervals: [] };
const CLOSED_6: BusinessDay[] = Array.from({ length: 6 }, () => CLOSED_DAY);

describe('validateBusinessHours', () => {
  it('accepts a default empty week', () => {
    expect(() => validateBusinessHours(BUSINESS_HOURS_EMPTY)).not.toThrow();
  });

  it('accepts a full valid week with multiple intervals per day', () => {
    const bh = {
      days: [
        { open: false, intervals: [] },
        {
          open: true,
          intervals: [
            { startMin: 540, endMin: 720 },
            { startMin: 780, endMin: 1140 },
          ],
        },
        { open: true, intervals: [{ startMin: 540, endMin: 1140 }] },
        { open: true, intervals: [{ startMin: 540, endMin: 1140 }] },
        { open: true, intervals: [{ startMin: 540, endMin: 1140 }] },
        { open: true, intervals: [{ startMin: 540, endMin: 1140 }] },
        { open: true, intervals: [{ startMin: 540, endMin: 1080 }] },
      ],
    };
    expect(() => validateBusinessHours(bh)).not.toThrow();
  });

  it('rejects when days length != 7', () => {
    expect(() => validateBusinessHours({ days: [] })).toThrow(/exactly 7/);
  });

  it('rejects an interval where endMin <= startMin', () => {
    const bh = {
      days: [{ open: true, intervals: [{ startMin: 600, endMin: 600 }] }, ...CLOSED_6],
    };
    expect(() => validateBusinessHours(bh)).toThrow(/start.*end/i);
  });

  it('rejects an interval out of [0, 1440]', () => {
    const bh = {
      days: [{ open: true, intervals: [{ startMin: -10, endMin: 600 }] }, ...CLOSED_6],
    };
    expect(() => validateBusinessHours(bh)).toThrow(/0.*1440/);
  });

  it('rejects overlapping intervals in the same day', () => {
    const bh = {
      days: [
        {
          open: true,
          intervals: [
            { startMin: 540, endMin: 720 },
            { startMin: 700, endMin: 800 },
          ],
        },
        ...CLOSED_6,
      ],
    };
    expect(() => validateBusinessHours(bh)).toThrow(/overlap/i);
  });

  it('rejects an open day with no intervals', () => {
    const bh = {
      days: [{ open: true, intervals: [] }, ...CLOSED_6],
    };
    expect(() => validateBusinessHours(bh)).toThrow(/open.*no intervals/i);
  });

  it('rejects a closed day with intervals', () => {
    const bh = {
      days: [{ open: false, intervals: [{ startMin: 540, endMin: 720 }] }, ...CLOSED_6],
    };
    expect(() => validateBusinessHours(bh)).toThrow(/closed.*intervals/i);
  });
});
