/**
 * Daily attendance math, mirroring app.compute_attendance_record (SQL).
 *
 * Used by the dashboard's time-based correction form: HR enters the real
 * Time in / Time out, and the minute overrides stored in `corrections` are
 * computed here with exactly the engine's rules, so a corrected day and an
 * engine-computed day always agree. Keep in sync with the latest
 * compute_attendance_record migration; parity is locked by dayMath.test.ts.
 */

import { isOvernight } from './schedule';

/** Parse Postgres time ("HH:MM" or "HH:MM:SS") to minutes since midnight. */
function toMinutes(time: string): number {
  const [h = 0, m = 0] = time.split(':').map(Number);
  return h * 60 + m;
}

export interface DayMathInput {
  workDate: string; // 'YYYY-MM-DD' (the day the shift starts)
  shiftStart: string; // branch shift, 'HH:MM[:SS]'
  shiftEnd: string;
  firstInIso: string; // actual/corrected times
  lastOutIso: string;
  /** Break minutes already on the record (0 when breaks aren't punched). */
  punchedBreakMin: number;
  lateGraceMin: number;
  otThresholdMin: number;
  minBreakMin: number;
  tzOffsetHours?: number; // default Asia/Manila (UTC+8, no DST)
}

export interface DayMinutes {
  worked_minutes: number;
  break_minutes: number;
  late_minutes: number;
  undertime_minutes: number;
  overtime_minutes: number;
}

/** Whole minutes between two instants, rounded like Postgres ::int. */
function minutesBetween(fromMs: number, toMs: number): number {
  return Math.round((toMs - fromMs) / 60_000);
}

/**
 * Compute the day's minute figures from actual in/out times.
 * Returns null when the times don't form a valid span (out must be after in).
 */
export function computeDayMinutes(input: DayMathInput): DayMinutes | null {
  const tz = input.tzOffsetHours ?? 8;
  const localMidnightUtcMs = Date.parse(`${input.workDate}T00:00:00Z`) - tz * 3_600_000;
  const shiftStartMs = localMidnightUtcMs + toMinutes(input.shiftStart) * 60_000;
  const shiftEndMs =
    localMidnightUtcMs +
    toMinutes(input.shiftEnd) * 60_000 +
    (isOvernight(input.shiftStart, input.shiftEnd) ? 24 * 3_600_000 : 0);

  const inMs = Date.parse(input.firstInIso);
  const outMs = Date.parse(input.lastOutIso);
  if (Number.isNaN(inMs) || Number.isNaN(outMs) || outMs <= inMs) return null;

  const span = minutesBetween(inMs, outMs);
  // Days longer than 5 h always give up at least the company minimum break,
  // whether or not breaks were punched.
  const deduct = span > 5 * 60 ? Math.max(input.punchedBreakMin, input.minBreakMin) : input.punchedBreakMin;

  // Late = minutes beyond the grace period.
  const late = Math.max(0, minutesBetween(shiftStartMs, inMs) - input.lateGraceMin);
  const under = Math.max(0, minutesBetween(outMs, shiftEndMs));
  const otRaw = Math.max(0, minutesBetween(shiftEndMs, outMs));

  return {
    worked_minutes: Math.max(0, span - deduct),
    break_minutes: deduct,
    late_minutes: late,
    undertime_minutes: under,
    overtime_minutes: otRaw <= input.otThresholdMin ? 0 : otRaw,
  };
}
