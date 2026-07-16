import { describe, expect, it } from 'vitest';
import { computeDayMinutes, type DayMathInput } from './dayMath';

// Fermosa defaults, day shift 10:00–19:00 Manila.
const base: DayMathInput = {
  workDate: '2026-07-13',
  shiftStart: '10:00',
  shiftEnd: '19:00',
  firstInIso: '2026-07-13T10:00:00+08:00',
  lastOutIso: '2026-07-13T19:00:00+08:00',
  punchedBreakMin: 0,
  lateGraceMin: 15,
  otThresholdMin: 30,
  minBreakMin: 60,
};

describe('computeDayMinutes (mirrors app.compute_attendance_record)', () => {
  it('on-time full day: 60-min break auto-deducted, no late/OT', () => {
    expect(computeDayMinutes(base)).toEqual({
      worked_minutes: 480, // 540 span − 60 break
      break_minutes: 60,
      late_minutes: 0,
      undertime_minutes: 0,
      overtime_minutes: 0,
    });
  });

  it('grace is not counted as late: in at +16 → 1 late minute', () => {
    const r = computeDayMinutes({ ...base, firstInIso: '2026-07-13T10:16:00+08:00' });
    expect(r?.late_minutes).toBe(1);
  });

  it('within grace: in at +10 → not late', () => {
    const r = computeDayMinutes({ ...base, firstInIso: '2026-07-13T10:10:00+08:00' });
    expect(r?.late_minutes).toBe(0);
  });

  it('1 hour after shift start → 45 counted late (grace 15)', () => {
    const r = computeDayMinutes({ ...base, firstInIso: '2026-07-13T11:00:00+08:00' });
    expect(r?.late_minutes).toBe(45);
  });

  it("Ronalisa's fix: corrected in 9:06, out 19:01 → not late, no OT", () => {
    const r = computeDayMinutes({
      ...base,
      firstInIso: '2026-07-13T09:06:00+08:00',
      lastOutIso: '2026-07-13T19:01:00+08:00',
    });
    expect(r).toEqual({
      worked_minutes: 535, // 595 span − 60 break
      break_minutes: 60,
      late_minutes: 0,
      undertime_minutes: 0,
      overtime_minutes: 0, // 1 min past shift end ≤ 30-min threshold
    });
  });

  it('overtime counts only past the threshold', () => {
    const at29 = computeDayMinutes({ ...base, lastOutIso: '2026-07-13T19:29:00+08:00' });
    const at45 = computeDayMinutes({ ...base, lastOutIso: '2026-07-13T19:45:00+08:00' });
    expect(at29?.overtime_minutes).toBe(0);
    expect(at45?.overtime_minutes).toBe(45);
  });

  it('early out → undertime', () => {
    const r = computeDayMinutes({ ...base, lastOutIso: '2026-07-13T16:00:00+08:00' });
    expect(r?.undertime_minutes).toBe(180);
  });

  it('short day (≤ 5 h) has no forced break deduction', () => {
    const r = computeDayMinutes({ ...base, lastOutIso: '2026-07-13T14:00:00+08:00' });
    expect(r?.worked_minutes).toBe(240);
    expect(r?.break_minutes).toBe(0);
  });

  it('punched break beyond the minimum is deducted in full', () => {
    const r = computeDayMinutes({ ...base, punchedBreakMin: 90 });
    expect(r?.break_minutes).toBe(90);
    expect(r?.worked_minutes).toBe(450);
  });

  it('overnight shift: late and OT computed against the rolled-over end', () => {
    const r = computeDayMinutes({
      ...base,
      shiftStart: '22:00',
      shiftEnd: '06:00',
      firstInIso: '2026-07-13T22:40:00+08:00',
      lastOutIso: '2026-07-14T06:05:00+08:00',
    });
    expect(r).toEqual({
      worked_minutes: 385, // 445 span − 60 break
      break_minutes: 60,
      late_minutes: 25, // 40 after start − 15 grace
      undertime_minutes: 0,
      overtime_minutes: 0, // 5 min ≤ threshold
    });
  });

  it('rejects an out time at or before the in time', () => {
    expect(computeDayMinutes({ ...base, lastOutIso: base.firstInIso })).toBeNull();
    expect(computeDayMinutes({ ...base, lastOutIso: '2026-07-13T09:00:00+08:00' })).toBeNull();
  });
});
