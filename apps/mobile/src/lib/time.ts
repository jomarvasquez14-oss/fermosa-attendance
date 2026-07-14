import { DEFAULT_TIMEZONE } from '@fermosa/shared';

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000; // Asia/Manila is UTC+8, no DST

/** UTC ISO timestamp of midnight today in Manila (the attendance day boundary). */
export function manilaDayStartUtcIso(): string {
  const nowManila = Date.now() + MANILA_OFFSET_MS;
  const dayStartManila = Math.floor(nowManila / 86_400_000) * 86_400_000;
  return new Date(dayStartManila - MANILA_OFFSET_MS).toISOString();
}

/**
 * Rolling window for the clock state: overnight shifts cross Manila midnight,
 * so "am I clocked in?" derives from the last punch within this window rather
 * than the calendar day. 18 h also ages out a forgotten clock-out by morning.
 */
export function recentWindowStartIso(hours = 18): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

const timeFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: DEFAULT_TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
});

const dateFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: DEFAULT_TIMEZONE,
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

const shortTimeFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: DEFAULT_TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
});

const manilaYmdFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: DEFAULT_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export const formatClock = (d: Date) => timeFmt.format(d);
export const formatDate = (d: Date) => dateFmt.format(d);
export const formatPunchTime = (iso: string) => {
  const d = new Date(iso);
  const prefix = manilaYmdFmt.format(d) !== manilaYmdFmt.format(new Date()) ? 'Yesterday ' : '';
  return prefix + shortTimeFmt.format(d);
};
