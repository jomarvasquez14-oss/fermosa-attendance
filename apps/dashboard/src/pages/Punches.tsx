import { PUNCH_LABELS, type PunchSource, type PunchType } from '@fermosa/shared';
import { useCallback, useEffect, useState } from 'react';
import { SelfieThumb } from '../components/SelfieThumb';
import { supabase } from '../lib/supabase';

interface EventRow {
  id: string;
  type: PunchType;
  source: PunchSource;
  happened_at: string;
  received_at: string;
  inside_geofence: boolean | null;
  distance_from_branch_m: number | null;
  selfie_path: string | null;
  employee: { full_name: string; employee_code: string } | null;
  branch: { name: string } | null;
}

const timeFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
});

const SOURCE_ICON: Record<PunchSource, string> = { mobile: '📱', web: '💻', kiosk: '🖥️' };

function fenceBadge(e: EventRow) {
  if (e.inside_geofence === null)
    return <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">No GPS</span>;
  if (e.inside_geofence)
    return <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">In branch</span>;
  return (
    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
      {Math.round(e.distance_from_branch_m ?? 0)} m away
    </span>
  );
}

/** Punch synced noticeably later than it happened (offline punch or clock drift). */
function syncedLate(e: EventRow): boolean {
  return new Date(e.received_at).getTime() - new Date(e.happened_at).getTime() > 5 * 60 * 1000;
}

export function Punches() {
  const [rows, setRows] = useState<EventRow[]>([]);
  const [selfies, setSelfies] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    supabase
      .from('attendance_events')
      .select(
        'id, type, source, happened_at, received_at, inside_geofence, distance_from_branch_m, selfie_path, employee:profiles(full_name, employee_code), branch:branches(name)',
      )
      .order('happened_at', { ascending: false })
      .limit(50)
      .then(async ({ data }) => {
        const list = (data as unknown as EventRow[]) ?? [];
        setRows(list);
        setLoading(false);
        const paths = list.filter((r) => r.selfie_path).map((r) => r.selfie_path!);
        if (paths.length > 0) {
          const { data: signed } = await supabase.storage.from('selfies').createSignedUrls(paths, 600);
          const map: Record<string, string> = {};
          signed?.forEach((s) => {
            if (s.signedUrl && s.path) map[s.path] = s.signedUrl;
          });
          setSelfies(map);
        }
      });
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000); // live-ish view while testing devices
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Punches</h2>
          <p className="text-sm text-gray-500">
            Latest raw clock events (auto-refreshes every 10s). Approve or correct them on the Reviews page.
          </p>
        </div>
        <button
          onClick={load}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
        >
          Refresh
        </button>
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="px-4 py-2 font-medium">Selfie</th>
              <th className="px-4 py-2 font-medium">When (Manila)</th>
              <th className="px-4 py-2 font-medium">Employee</th>
              <th className="px-4 py-2 font-medium">Punch</th>
              <th className="px-4 py-2 font-medium">Branch</th>
              <th className="px-4 py-2 font-medium">Geofence</th>
              <th className="px-4 py-2 font-medium">Sync</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-gray-400">Loading…</td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-gray-400">
                  No punches yet — clock in from the mobile app.
                </td>
              </tr>
            )}
            {rows.map((e) => (
              <tr key={e.id} className="hover:bg-gray-50">
                <td className="px-4 py-2">
                  {e.selfie_path && selfies[e.selfie_path] ? (
                    <SelfieThumb
                      src={selfies[e.selfie_path]!}
                      alt={`${e.employee?.full_name ?? 'Selfie'} · ${PUNCH_LABELS[e.type]} · ${timeFmt.format(new Date(e.happened_at))}`}
                      className="h-10 w-10 rounded-full object-cover"
                    />
                  ) : e.type === 'clock_in' || e.type === 'clock_out' ? (
                    <span className="text-xs text-amber-600" title="Selfie required but missing">⚠️</span>
                  ) : (
                    <span className="text-xs text-gray-300">—</span>
                  )}
                </td>
                <td className="px-4 py-2 text-gray-900">{timeFmt.format(new Date(e.happened_at))}</td>
                <td className="px-4 py-2">
                  <span className="font-medium text-gray-900">{e.employee?.full_name ?? '—'}</span>{' '}
                  <span className="text-xs text-gray-500">{e.employee?.employee_code}</span>
                </td>
                <td className="px-4 py-2 text-gray-700">
                  {SOURCE_ICON[e.source]} {PUNCH_LABELS[e.type]}
                </td>
                <td className="px-4 py-2 text-gray-600">{e.branch?.name ?? '—'}</td>
                <td className="px-4 py-2">{fenceBadge(e)}</td>
                <td className="px-4 py-2">
                  {syncedLate(e) ? (
                    <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs text-sky-700">
                      Synced late (offline)
                    </span>
                  ) : (
                    <span className="text-xs text-gray-400">Live</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
