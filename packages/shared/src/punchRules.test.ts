import { describe, expect, it } from 'vitest';
import { nextAllowedPunchTypes, workStatusFromLastPunch } from './punchRules';
import type { PunchType } from './types';

describe('nextAllowedPunchTypes', () => {
  const cases: Array<[PunchType | null, PunchType[]]> = [
    [null, ['clock_in']],
    ['clock_out', ['clock_in']], // new session after clocking out (split shift)
    ['clock_in', ['break_start', 'clock_out']],
    ['break_end', ['break_start', 'clock_out']], // multiple breaks allowed
    ['break_start', ['break_end']], // must end the break first
  ];

  it.each(cases)('after %s allows %j', (last, expected) => {
    expect(nextAllowedPunchTypes(last)).toEqual(expected);
  });

  it('never allows clocking out without being clocked in', () => {
    expect(nextAllowedPunchTypes(null)).not.toContain('clock_out');
    expect(nextAllowedPunchTypes('clock_out')).not.toContain('clock_out');
  });
});

describe('workStatusFromLastPunch', () => {
  it('maps punches to statuses', () => {
    expect(workStatusFromLastPunch(null)).toBe('clocked_out');
    expect(workStatusFromLastPunch('clock_out')).toBe('clocked_out');
    expect(workStatusFromLastPunch('clock_in')).toBe('working');
    expect(workStatusFromLastPunch('break_end')).toBe('working');
    expect(workStatusFromLastPunch('break_start')).toBe('on_break');
  });
});
