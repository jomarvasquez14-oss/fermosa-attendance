import { LEAVE_STATUS_LABELS, countLeaveDays, type LeaveStatus } from '@fermosa/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';

interface TypeRow {
  id: string;
  name: string;
  is_paid: boolean;
}
interface BalanceRow {
  leave_type_id: string;
  entitled_days: number;
  used_days: number;
  remaining_days: number;
}
interface RequestRow {
  id: string;
  start_date: string;
  end_date: string;
  half_day: boolean;
  day_count: number;
  reason: string | null;
  status: LeaveStatus;
  review_note: string | null;
  leave_type: { name: string } | null;
}

const STATUS_STYLE: Record<LeaveStatus, string> = {
  pending: 'bg-amber-100 text-amber-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  cancelled: 'bg-gray-100 text-gray-500',
};

const YEAR = new Date().getFullYear();
const todayYmd = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const fmtDays = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** Employee self-service leave — balances, request form, and history (browser equivalent of the mobile leave screen). */
export function MyLeave() {
  const { profile } = useAuth();
  const [types, setTypes] = useState<TypeRow[]>([]);
  const [balances, setBalances] = useState<BalanceRow[]>([]);
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [workDays, setWorkDays] = useState<number[]>([1, 2, 3, 4, 5, 6]);
  const [holidays, setHolidays] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const [typeId, setTypeId] = useState<string>('');
  const [start, setStart] = useState(todayYmd);
  const [end, setEnd] = useState(todayYmd);
  const [halfDay, setHalfDay] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!profile) return;
    const [t, b, r] = await Promise.all([
      supabase.from('leave_types').select('id, name, is_paid').eq('is_active', true).order('name'),
      supabase
        .from('leave_balances_view')
        .select('leave_type_id, entitled_days, used_days, remaining_days')
        .eq('employee_id', profile.id)
        .eq('year', YEAR),
      supabase
        .from('leave_requests')
        .select(
          'id, start_date, end_date, half_day, day_count, reason, status, review_note, leave_type:leave_types(name)',
        )
        .eq('employee_id', profile.id)
        .order('start_date', { ascending: false })
        .limit(50),
    ]);
    const typeRows = (t.data as TypeRow[]) ?? [];
    setTypes(typeRows);
    setBalances((b.data as BalanceRow[]) ?? []);
    setRequests((r.data as unknown as RequestRow[]) ?? []);
    setTypeId((prev) => prev || (typeRows[0]?.id ?? ''));

    if (profile.branch_id) {
      const { data: br } = await supabase
        .from('branches')
        .select('work_days')
        .eq('id', profile.branch_id)
        .maybeSingle();
      if (br?.work_days) setWorkDays(br.work_days as number[]);
    }
    const { data: hol } = await supabase
      .from('holidays')
      .select('holiday_date')
      .gte('holiday_date', `${YEAR}-01-01`)
      .lte('holiday_date', `${YEAR}-12-31`);
    setHolidays(((hol as { holiday_date: string }[]) ?? []).map((h) => h.holiday_date));
    setLoading(false);
  }, [profile]);

  useEffect(() => {
    void load();
  }, [load]);

  const endYmd = halfDay ? start : end;
  const dayCount = useMemo(
    () => countLeaveDays(start, endYmd, workDays, holidays, halfDay),
    [start, endYmd, workDays, holidays, halfDay],
  );
  const selectedType = types.find((t) => t.id === typeId) ?? null;
  const balanceForType = balances.find((b) => b.leave_type_id === typeId) ?? null;

  const submit = async () => {
    if (!profile || !typeId) return;
    setError(null);
    setMsg(null);
    if (endYmd < start) {
      setError('The end date is before the start date.');
      return;
    }
    setBusy(true);
    const { error: insErr } = await supabase.from('leave_requests').insert({
      company_id: profile.company_id,
      employee_id: profile.id,
      leave_type_id: typeId,
      start_date: start,
      end_date: endYmd,
      half_day: halfDay,
      reason: reason.trim() || null,
      status: 'pending',
    });
    setBusy(false);
    if (insErr) {
      setError(insErr.message);
      return;
    }
    setReason('');
    setHalfDay(false);
    setMsg('Request filed — pending HR approval.');
    void load();
  };

  const cancel = async (r: RequestRow) => {
    if (!window.confirm(`Cancel ${r.leave_type?.name ?? 'leave'} on ${r.start_date}?`)) return;
    const { error: updErr } = await supabase
      .from('leave_requests')
      .update({ status: 'cancelled' })
      .eq('id', r.id);
    if (updErr) setError(updErr.message);
    else void load();
  };

  if (!profile) return null;

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="My leave" crumb="My leave" subtitle={`Balances & requests · ${YEAR}`} />

      {loading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <>
          {balances.length === 0 ? (
            <p className="text-sm text-muted">No balances yet. HR sets these up.</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {balances.map((bal) => {
                const name = types.find((t) => t.id === bal.leave_type_id)?.name ?? 'Leave';
                return (
                  <div key={bal.leave_type_id} className="card px-4 py-3 text-center">
                    <div className="text-xs text-muted">{name}</div>
                    <div className="text-2xl font-bold text-ink">{fmtDays(bal.remaining_days)}</div>
                    <div className="text-xs text-muted">of {fmtDays(bal.entitled_days)} left</div>
                  </div>
                );
              })}
            </div>
          )}

          <h3 className="mt-8 text-sm font-semibold uppercase tracking-wide text-muted">
            Request leave
          </h3>
          <div className="card mt-2 space-y-4 p-5">
            <div>
              <label className="mb-1 block text-sm font-medium text-ink">Type</label>
              <div className="flex flex-wrap gap-2">
                {types.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTypeId(t.id)}
                    className={`rounded-full border px-4 py-1.5 text-sm transition ${
                      typeId === t.id
                        ? 'border-brand-500 bg-brand-500 font-semibold text-on-gold'
                        : 'border-line text-ink hover:bg-ground'
                    }`}
                  >
                    {t.name}
                    {t.is_paid ? '' : ' (unpaid)'}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-ink">Start</label>
                <input
                  type="date"
                  value={start}
                  onChange={(e) => {
                    setStart(e.target.value);
                    if (e.target.value > end) setEnd(e.target.value);
                  }}
                  className="input"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-ink">End</label>
                <input
                  type="date"
                  value={endYmd}
                  min={start}
                  disabled={halfDay}
                  onChange={(e) => setEnd(e.target.value)}
                  className="input disabled:opacity-50"
                />
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={halfDay} onChange={(e) => setHalfDay(e.target.checked)} />
              Half day (0.5)
            </label>

            <div>
              <label className="mb-1 block text-sm font-medium text-ink">Reason (optional)</label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. medical appointment"
                className="input min-h-[64px]"
              />
            </div>

            <div className="text-sm text-muted">
              This uses <span className="font-bold text-ink">{fmtDays(dayCount)}</span> day
              {dayCount === 1 ? '' : 's'}
              {selectedType?.is_paid && balanceForType
                ? ` · ${fmtDays(balanceForType.remaining_days)} left before this`
                : ''}
              {selectedType?.is_paid && balanceForType && dayCount > balanceForType.remaining_days && (
                <span className="mt-1 block text-amber-700">
                  Over your remaining balance — HR may still approve.
                </span>
              )}
              {dayCount === 0 && (
                <span className="mt-1 block">No working days in this range — pick a working day.</span>
              )}
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}
            {msg && <p className="text-sm text-green-700">{msg}</p>}

            <button
              onClick={submit}
              disabled={busy || !typeId || dayCount === 0}
              className="btn-primary w-full disabled:opacity-50"
            >
              {busy ? 'Filing…' : 'File request'}
            </button>
          </div>

          <h3 className="mt-8 text-sm font-semibold uppercase tracking-wide text-muted">
            Your requests
          </h3>
          <div className="mt-2 space-y-2">
            {requests.length === 0 && <p className="text-sm text-muted">No leave requests yet.</p>}
            {requests.map((r) => (
              <div key={r.id} className="card flex items-center justify-between px-4 py-3">
                <div>
                  <div className="text-sm font-semibold text-ink">
                    {r.leave_type?.name ?? 'Leave'} · {fmtDays(r.day_count)}d
                  </div>
                  <div className="text-xs text-muted">
                    {r.start_date}
                    {r.end_date !== r.start_date ? ` → ${r.end_date}` : ''}
                    {r.half_day ? ' · ½ day' : ''}
                  </div>
                  {r.review_note && (
                    <div className="mt-1 text-xs italic text-muted">Note: {r.review_note}</div>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className={`pill ${STATUS_STYLE[r.status]}`}>
                    {LEAVE_STATUS_LABELS[r.status]}
                  </span>
                  {r.status === 'pending' && (
                    <button onClick={() => cancel(r)} className="text-xs text-red-600 hover:underline">
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
