/**
 * Semi-monthly pay-period math (Philippine "kinsenas"): each calendar month
 * splits into 1–15 and 16–end-of-month. Pure calendar-date logic (no time of
 * day), so the dashboard derives a period's from/to dates and the Google Sheets
 * tab label here; the SQL report function just takes the two dates.
 */

export interface PayPeriod {
  year: number;
  month: number; // 1–12
  half: 1 | 2; // 1 = 1st–15th, 2 = 16th–end of month
  start: string; // 'YYYY-MM-DD'
  end: string; // 'YYYY-MM-DD'
  label: string; // e.g. "2026-07 (1–15)"
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Last calendar day of a 1–12 month (handles leap years). */
export function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function buildPeriod(year: number, month: number, half: 1 | 2): PayPeriod {
  const startDay = half === 1 ? 1 : 16;
  const endDay = half === 1 ? 15 : lastDayOfMonth(year, month);
  return {
    year,
    month,
    half,
    start: `${year}-${pad2(month)}-${pad2(startDay)}`,
    end: `${year}-${pad2(month)}-${pad2(endDay)}`,
    label: `${year}-${pad2(month)} (${startDay}–${endDay})`,
  };
}

/** The two semi-monthly periods of a calendar month. */
export function semiMonthlyPeriods(year: number, month: number): [PayPeriod, PayPeriod] {
  return [buildPeriod(year, month, 1), buildPeriod(year, month, 2)];
}

/** The semi-monthly period containing the given date ('YYYY-MM-DD' or full ISO). */
export function payPeriodFor(dateIso: string): PayPeriod {
  const [y = 0, m = 0, d = 0] = dateIso.slice(0, 10).split('-').map(Number);
  return buildPeriod(y, m, d <= 15 ? 1 : 2);
}

/** Display/tab label for a period, e.g. "2026-07 (16–31)". */
export function formatPeriodLabel(period: PayPeriod): string {
  return period.label;
}
