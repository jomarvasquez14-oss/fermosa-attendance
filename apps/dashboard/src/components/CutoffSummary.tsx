import { payPeriodFor, type PayPeriod, type Profile } from '@fermosa/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';

interface EffectiveRow {
  work_date: string;
  status: string;
  first_in: string | null;
  late_minutes: number;
  overtime_minutes: number;
}

interface EngineSettings {
  late_grace_min: number;
  half_day_late_min: number;
}

const manilaDateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' });

/** The cutoff before the given one (e.g. Jul 1–15 → Jun 16–30). */
function previousPeriod(p: PayPeriod): PayPeriod {
  const prev = new Date(`${p.start}T00:00:00Z`);
  prev.setUTCDate(prev.getUTCDate() - 1);
  return payPeriodFor(prev.toISOString());
}

function fmtMinutes(min: number): string {
  if (min <= 0) return '0m';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * The employee's own standing for a pay cutoff (semi-monthly): days present,
 * late, overtime. Reads the corrected (effective) values — RLS scopes the
 * query to the employee's own records — and applies the same half-day rule
 * payroll uses. Includes days still awaiting HR review (with a footnote),
 * since approval lags punching by a day or two.
 */
export function CutoffSummary({ profile }: { profile: Profile }) {
  const current = useMemo(() => payPeriodFor(manilaDateFmt.format(new Date())), []);
  const previous = useMemo(() => previousPeriod(current), [current]);
  const [half, setHalf] = useState<'current' | 'previous'>('current');
  const period = half === 'current' ? current : previous;
  const [rows, setRows] = useState<EffectiveRow[] | null>(null);
  const [settings, setSettings] = useState<EngineSettings | null>(null);

  useEffect(() => {
    if (!navigator.onLine) return;
    supabase
      .from('attendance_settings')
      .select('late_grace_min, half_day_late_min')
      .maybeSingle()
      .then(({ data }) => setSettings((data as EngineSettings | null) ?? null));
  }, []);

  const load = useCallback(() => {
    if (!navigator.onLine) return;
    supabase
      .from('attendance_effective')
      .select('work_date, status, first_in, late_minutes, overtime_minutes')
      .eq('employee_id', profile.id)
      .gte('work_date', period.start)
      .lte('work_date', period.end)
      .then(({ data }) => {
        if (data) setRows(data as EffectiveRow[]);
      });
  }, [profile.id, period.start, period.end]);

  useEffect(() => {
    load();
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const summary = useMemo(() => {
    if (!rows) return null;
    // Same half-day rule as payroll: effective late ≥ (threshold − grace).
    const grace = settings?.late_grace_min ?? 15;
    const halfDayAt = settings?.half_day_late_min ?? 60;
    const halfDayLate = Math.max(halfDayAt - grace, 1);
    let present = 0;
    let lateMin = 0;
    let otMin = 0;
    let pending = 0;
    for (const r of rows) {
      if (r.status === 'rejected') continue; // rejected days count nothing
      if (r.status === 'pending_review') pending += 1;
      if (r.first_in) {
        present += halfDayAt > 0 && r.late_minutes >= halfDayLate ? 0.5 : 1;
        lateMin += r.late_minutes;
        otMin += r.overtime_minutes;
      }
    }
    return { present, lateMin, otMin, pending };
  }, [rows, settings]);

  // Nothing loaded yet (e.g. opened offline) — keep the clock page clean.
  if (!summary) return null;

  return (
    <div className="card mt-6 px-4 py-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">My summary</h3>
        <select
          value={half}
          onChange={(e) => setHalf(e.target.value as 'current' | 'previous')}
          className="input py-1 text-xs"
        >
          <option value="current">This cutoff ({current.label})</option>
          <option value="previous">Last cutoff ({previous.label})</option>
        </select>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-3 text-center">
        <div>
          <div className="text-2xl font-bold tabular-nums text-ink">{summary.present}</div>
          <div className="text-xs text-muted">Days present</div>
        </div>
        <div>
          <div className="text-2xl font-bold tabular-nums text-ink">{fmtMinutes(summary.lateMin)}</div>
          <div className="text-xs text-muted">Late</div>
        </div>
        <div>
          <div className="text-2xl font-bold tabular-nums text-ink">{fmtMinutes(summary.otMin)}</div>
          <div className="text-xs text-muted">Overtime</div>
        </div>
      </div>
      {summary.pending > 0 && (
        <p className="mt-3 text-center text-xs text-muted">
          {summary.pending} day{summary.pending > 1 ? 's' : ''} still awaiting HR review.
        </p>
      )}
    </div>
  );
}
