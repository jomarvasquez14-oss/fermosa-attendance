import type { PunchType } from './types';

/**
 * Punch sequencing state machine.
 *
 * Multiple clock-in/out sessions per day are allowed (split shifts, corrections),
 * but order within a session is enforced: you can only clock out after clocking
 * in, and only end a break you started. The server accepts any punch (HR review
 * catches anomalies in M4); this guides the UI.
 */
export function nextAllowedPunchTypes(lastType: PunchType | null): PunchType[] {
  switch (lastType) {
    case null:
    case 'clock_out':
      return ['clock_in'];
    case 'clock_in':
    case 'break_end':
      return ['break_start', 'clock_out'];
    case 'break_start':
      return ['break_end'];
  }
}

export type WorkStatus = 'clocked_out' | 'working' | 'on_break';

/** Human-facing status derived from the last punch of the day. */
export function workStatusFromLastPunch(lastType: PunchType | null): WorkStatus {
  switch (lastType) {
    case null:
    case 'clock_out':
      return 'clocked_out';
    case 'clock_in':
    case 'break_end':
      return 'working';
    case 'break_start':
      return 'on_break';
  }
}

export const PUNCH_LABELS: Record<PunchType, string> = {
  clock_in: 'Clock In',
  break_start: 'Start Break',
  break_end: 'End Break',
  clock_out: 'Clock Out',
};
