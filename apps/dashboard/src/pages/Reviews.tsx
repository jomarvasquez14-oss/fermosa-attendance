import {
  PUNCH_LABELS,
  REVIEWER_ROLES,
  type AttendanceStatus,
  type PunchSource,
  type PunchType,
} from '@fermosa/shared';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';

interface RecordRow {
  id: string;
  work_date: string;
  status: AttendanceStatus;
  review_note: string | null;
  reviewed_at: string | null;
  employee: { id: string; full_name: string; employee_code: string } | null;
  branch: { name: string } | null;
  reviewer: { full_name: string } | null;
}

interface EventRow {
  id: string;
  type: PunchType;
  source: PunchSource;
  happened_at: string;
  received_at: string;
  inside_geofence: boolean | null;
  distance_from_branch_m: number | null;
  selfie_path: string | null;
}

const STATUS_BADGE: Record<AttendanceStatus, string> = {
  pending_review: 'bg-amber-100 text-amber-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  corrected: 'bg-sky-100 text-sky-700',
};

const STATUS_LABEL: Record<AttendanceStatus, string> = {
  pending_review: 'Pending review',
  approved: 'Approved',
  rejected: 'Rejected',
  corrected: 'Corrected',
};

const timeFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
});

function DayDetail({ record }: { record: RecordRow }) {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [selfies, setSelfies] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!record.employee) return;
    // The Manila work day in UTC.
    const start = new Date(`${record.work_date}T00:00:00+08:00`).toISOString();
    const end = new Date(new Date(start).getTime() + 24 * 3600 * 1000).toISOString();
    supabase
      .from('attendance_events')
      .select('id, type, source, happened_at, received_at, inside_geofence, distance_from_branch_m, selfie_path')
      .eq('employee_id', record.employee.id)
      .gte('happened_at', start)
      .lt('happened_at', end)
      .order('happened_at')
      .then(async ({ data }) => {
        const rows = (data as EventRow[]) ?? [];
        setEvents(rows);
        const paths = rows.filter((r) => r.selfie_path).map((r) => r.selfie_path!);
        if (paths.length > 0) {
          const { data: signed } = await supabase.storage.from('selfies').createSignedUrls(paths, 600);
          const map: Record<string, string> = {};
          signed?.forEach((s) => {
            if (s.signedUrl && s.path) map[s.path] = s.signedUrl;
          });
          setSelfies(map);
        }
      });
  }, [record]);

  if (events.length === 0) {
    return <p className="px-4 py-3 text-sm text-gray-400">No punches loaded for this day.</p>;
  }

  return (
    <div className="flex flex-wrap gap-3 bg-gray-50 px-4 py-3">
      {events.map((e) => (
        <div key={e.id} className="w-40 rounded-lg border border-gray-200 bg-white p-2">
          {e.selfie_path && selfies[e.selfie_path] ? (
            <img
              src={selfies[e.selfie_path]}
              alt={`Selfie for ${PUNCH_LABELS[e.type]}`}
              className="h-32 w-full rounded object-cover"
            />
          ) : (
            <div className="flex h-32 w-full items-center justify-center rounded bg-gray-100 text-xs text-gray-400">
              {e.type === 'clock_in' || e.type === 'clock_out' ? 'No selfie ⚠️' : 'No selfie needed'}
            </div>
          )}
          <p className="mt-2 text-xs font-semibold text-gray-900">{PUNCH_LABELS[e.type]}</p>
          <p className="text-xs text-gray-500">{timeFmt.format(new Date(e.happened_at))} · {e.source}</p>
          <p className="text-xs">
            {e.inside_geofence === null ? (
              <span className="text-gray-400">No GPS</span>
            ) : e.inside_geofence ? (
              <span className="text-green-700">In branch</span>
            ) : (
              <span className="text-amber-700">{Math.round(e.distance_from_branch_m ?? 0)} m away</span>
            )}
          </p>
        </div>
      ))}
    </div>
  );
}

export function Reviews() {
  const { profile } = useAuth();
  const [rows, setRows] = useState<RecordRow[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('pending_review');
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canReview = profile ? REVIEWER_ROLES.includes(profile.role) : false;

  const load = useCallback(() => {
    let q = supabase
      .from('attendance_records')
      .select(
        'id, work_date, status, review_note, reviewed_at, employee:profiles!attendance_records_employee_id_fkey(id, full_name, employee_code), branch:branches(name), reviewer:profiles!attendance_records_reviewed_by_fkey(full_name)',
      )
      .order('work_date', { ascending: false })
      .limit(100);
    if (statusFilter !== 'all') q = q.eq('status', statusFilter);
    q.then(({ data }) => setRows((data as unknown as RecordRow[]) ?? []));
  }, [statusFilter]);

  useEffect(load, [load]);

  const review = async (id: string, status: AttendanceStatus) => {
    setError(null);
    let note: string | null = null;
    if (status === 'rejected' || status === 'corrected') {
      note = window.prompt(
        status === 'rejected' ? 'Reason for rejection:' : 'Correction note (what was fixed):',
      );
      if (!note?.trim()) return;
    }
    const { error: rpcErr } = await supabase.rpc('review_attendance', {
      p_record_id: id,
      p_status: status,
      p_note: note,
    });
    if (rpcErr) setError(rpcErr.message);
    else load();
  };

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Attendance reviews</h2>
          <p className="text-sm text-gray-500">
            {canReview
              ? 'Only approved attendance becomes official. Rejections and corrections require a note.'
              : 'View-only: approvals are handled by HR, operations, or super admin.'}
          </p>
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
        >
          <option value="pending_review">Pending review</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="corrected">Corrected</option>
          <option value="all">All</option>
        </select>
      </div>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-4 overflow-hidden rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="px-4 py-2 font-medium">Date</th>
              <th className="px-4 py-2 font-medium">Employee</th>
              <th className="px-4 py-2 font-medium">Branch</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Note</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-gray-400">
                  Nothing here — punches create review entries automatically.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <>
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2 text-gray-900">{r.work_date}</td>
                  <td className="px-4 py-2">
                    <span className="font-medium text-gray-900">{r.employee?.full_name ?? '—'}</span>{' '}
                    <span className="text-xs text-gray-500">{r.employee?.employee_code}</span>
                  </td>
                  <td className="px-4 py-2 text-gray-600">{r.branch?.name ?? '—'}</td>
                  <td className="px-4 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_BADGE[r.status]}`}>
                      {STATUS_LABEL[r.status]}
                    </span>
                  </td>
                  <td className="max-w-40 truncate px-4 py-2 text-xs text-gray-500" title={r.review_note ?? ''}>
                    {r.review_note ?? '—'}
                  </td>
                  <td className="space-x-2 whitespace-nowrap px-4 py-2 text-right">
                    <button
                      onClick={() => setOpenId(openId === r.id ? null : r.id)}
                      className="text-sm text-brand-700 hover:underline"
                    >
                      {openId === r.id ? 'Hide' : 'Punches'}
                    </button>
                    {canReview && r.status === 'pending_review' && (
                      <>
                        <button
                          onClick={() => review(r.id, 'approved')}
                          className="rounded-lg bg-green-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-green-700"
                        >
                          Approve
                        </button>
                        <button
                          onClick={() => review(r.id, 'rejected')}
                          className="rounded-lg bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700"
                        >
                          Reject
                        </button>
                        <button
                          onClick={() => review(r.id, 'corrected')}
                          className="rounded-lg border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-100"
                        >
                          Correct
                        </button>
                      </>
                    )}
                  </td>
                </tr>
                {openId === r.id && (
                  <tr key={`${r.id}-detail`}>
                    <td colSpan={6} className="p-0">
                      <DayDetail record={r} />
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
