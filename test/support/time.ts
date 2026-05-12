export function nextOpenSlotISO(daysAhead = 2, hourLocal = 14): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourLocal + 3, 0, 0, 0); // 14:00 SP = 17:00 UTC (SP is UTC-3)
  return d.toISOString();
}
