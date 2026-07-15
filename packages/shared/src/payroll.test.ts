import { describe, expect, it } from 'vitest';
import { formatPeriodLabel, lastDayOfMonth, payPeriodFor, semiMonthlyPeriods } from './payroll';

describe('payPeriodFor', () => {
  it('maps an early-month date to the 1st half', () => {
    expect(payPeriodFor('2026-07-05')).toMatchObject({
      year: 2026,
      month: 7,
      half: 1,
      start: '2026-07-01',
      end: '2026-07-15',
      label: '2026-07 (1–15)',
    });
  });

  it('treats the 15th as the last day of the 1st half', () => {
    expect(payPeriodFor('2026-07-15').half).toBe(1);
    expect(payPeriodFor('2026-07-15').end).toBe('2026-07-15');
  });

  it('maps the 16th onward to the 2nd half', () => {
    expect(payPeriodFor('2026-07-16')).toMatchObject({
      half: 2,
      start: '2026-07-16',
      end: '2026-07-31',
      label: '2026-07 (16–31)',
    });
  });

  it('ends the 2nd half on a short month (Feb, non-leap)', () => {
    expect(payPeriodFor('2026-02-20').end).toBe('2026-02-28');
  });

  it('ends the 2nd half on Feb 29 in a leap year', () => {
    expect(payPeriodFor('2028-02-20').end).toBe('2028-02-29');
  });

  it('accepts a full ISO timestamp', () => {
    expect(payPeriodFor('2026-07-16T03:00:00Z').half).toBe(2);
  });
});

describe('semiMonthlyPeriods', () => {
  it('returns both halves of a month with correct labels', () => {
    const [first, second] = semiMonthlyPeriods(2026, 7);
    expect(formatPeriodLabel(first)).toBe('2026-07 (1–15)');
    expect(formatPeriodLabel(second)).toBe('2026-07 (16–31)');
    expect(second.start).toBe('2026-07-16');
    expect(second.end).toBe('2026-07-31');
  });

  it('labels a 30-day month correctly', () => {
    expect(formatPeriodLabel(semiMonthlyPeriods(2026, 6)[1])).toBe('2026-06 (16–30)');
  });
});

describe('lastDayOfMonth', () => {
  it('handles 31-, 30-, and 28/29-day months', () => {
    expect(lastDayOfMonth(2026, 7)).toBe(31);
    expect(lastDayOfMonth(2026, 6)).toBe(30);
    expect(lastDayOfMonth(2026, 2)).toBe(28);
    expect(lastDayOfMonth(2028, 2)).toBe(29);
  });
});
