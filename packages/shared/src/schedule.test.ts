import { describe, expect, it } from 'vitest';
import {
  formatShift,
  isOvernight,
  punchWindowForWorkDate,
  workDayCutoffMinutes,
} from './schedule';

describe('workDayCutoffMinutes', () => {
  // Same table the SQL smoke test uses (app.work_day_cutoff).
  const cases: Array<[string, string, number, string]> = [
    ['10:00', '19:00', 150, '02:30'],
    ['22:00', '06:00', 840, '14:00'],
    ['09:00', '18:00', 90, '01:30'],
    ['10:00', '21:00', 210, '03:30'],
    ['09:00', '06:00', 450, '07:30'],
  ];

  it.each(cases)('cutoff(%s, %s) = %i (%s)', (start, end, minutes) => {
    expect(workDayCutoffMinutes(start, end)).toBe(minutes);
  });

  it('accepts Postgres HH:MM:SS times', () => {
    expect(workDayCutoffMinutes('10:00:00', '19:00:00')).toBe(150);
  });
});

describe('isOvernight', () => {
  it('is false for day shifts, true when end <= start', () => {
    expect(isOvernight('10:00', '19:00')).toBe(false);
    expect(isOvernight('22:00', '06:00')).toBe(true);
    expect(isOvernight('09:00', '09:00')).toBe(true);
  });
});

describe('punchWindowForWorkDate', () => {
  it('day shift: window runs from cutoff to cutoff in Manila time', () => {
    // 10:00–19:00 → cutoff 02:30 Manila = 18:30 UTC the day before.
    const w = punchWindowForWorkDate('2026-07-10', '10:00', '19:00');
    expect(w.startIso).toBe('2026-07-09T18:30:00.000Z');
    expect(w.endIso).toBe('2026-07-10T18:30:00.000Z');
  });

  it('overnight shift: whole night maps to the start day', () => {
    // 22:00–06:00 → cutoff 14:00 Manila = 06:00 UTC same day.
    const w = punchWindowForWorkDate('2026-07-10', '22:00', '06:00');
    expect(w.startIso).toBe('2026-07-10T06:00:00.000Z');
    expect(w.endIso).toBe('2026-07-11T06:00:00.000Z');
    // The shift itself (22:00 D → 06:00 D+1 Manila = 14:00 D → 22:00 D UTC) is inside.
    expect(Date.parse('2026-07-10T14:00:00Z')).toBeGreaterThanOrEqual(Date.parse(w.startIso));
    expect(Date.parse('2026-07-10T22:00:00Z')).toBeLessThan(Date.parse(w.endIso));
  });
});

describe('formatShift', () => {
  it('formats day and overnight shifts', () => {
    expect(formatShift('10:00:00', '19:00:00')).toBe('10:00 AM – 7:00 PM');
    expect(formatShift('09:00', '18:00')).toBe('9:00 AM – 6:00 PM');
    expect(formatShift('22:00', '06:00')).toBe('10:00 PM – 6:00 AM +1');
    expect(formatShift('00:00', '12:00')).toBe('12:00 AM – 12:00 PM');
  });
});
