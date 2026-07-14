import { DEFAULT_TIMEZONE } from '@fermosa/shared';

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000; // Asia/Manila is UTC+8, no DST

/** UTC ISO timestamp of midnight today in Manila (the attendance day boundary). */
export function manilaDayStartUtcIso(): string {
  const nowManila = Date.now() + MANILA_OFFSET_MS;
  const dayStartManila = Math.floor(nowManila / 86_400_000) * 86_400_000;
  return new Date(dayStartManila - MANILA_OFFSET_MS).toISOString();
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

export const formatClock = (d: Date) => timeFmt.format(d);
export const formatDate = (d: Date) => dateFmt.format(d);
export const formatPunchTime = (iso: string) => shortTimeFmt.format(new Date(iso));
