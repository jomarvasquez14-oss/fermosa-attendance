import {
  PUNCH_LABELS,
  SELFIE_PUNCH_TYPES,
  checkGeofence,
  nextAllowedPunchTypes,
  workStatusFromLastPunch,
  type PunchType,
} from '@fermosa/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { WebcamCapture } from '../components/WebcamCapture';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { submitWebPunch } from '../lib/webPunch';

interface BranchInfo {
  id: string;
  name: string;
  lat: number;
  lng: number;
  geofence_radius_m: number;
}

interface PunchRow {
  type: PunchType;
  happened_at: string;
  inside_geofence: boolean | null;
  distance_from_branch_m: number | null;
}

const STATUS_STYLE = {
  clocked_out: 'bg-gray-100 text-gray-600',
  working: 'bg-green-100 text-green-700',
  on_break: 'bg-amber-100 text-amber-700',
} as const;

const STATUS_LABEL = {
  clocked_out: 'Clocked out',
  working: 'Working',
  on_break: 'On break',
} as const;

const clockFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
});
const dateFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  weekday: 'long',
  month: 'long',
  day: 'numeric',
});
const punchTimeFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
});

/** Rolling window (not the calendar day) so an overnight shift keeps its state across midnight. */
function recentWindowStartIso(hours = 18): string {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

/** Employee self-service time clock — the browser equivalent of the mobile home screen. */
export function TimeClock() {
  const { profile } = useAuth();
  const [now, setNow] = useState(() => new Date());
  const [branch, setBranch] = useState<BranchInfo | null>(null);
  const [punches, setPunches] = useState<PunchRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selfieFor, setSelfieFor] = useState<PunchType | null>(null);

  // Live clock.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const loadPunches = useCallback(async () => {
    if (!profile) return;
    const { data } = await supabase
      .from('attendance_events')
      .select('type, happened_at, inside_geofence, distance_from_branch_m')
      .eq('employee_id', profile.id)
      .gte('happened_at', recentWindowStartIso())
      .order('happened_at', { ascending: true });
    setPunches((data as PunchRow[]) ?? []);
  }, [profile]);

  useEffect(() => {
    void loadPunches();
  }, [loadPunches]);

  // Branch coordinates for the instant geofence hint (server stays authoritative).
  useEffect(() => {
    if (!profile?.branch_id) return;
    supabase
      .from('branches')
      .select('id, name, lat, lng, geofence_radius_m')
      .eq('id', profile.branch_id)
      .maybeSingle()
      .then(({ data }) => setBranch((data as BranchInfo | null) ?? null));
  }, [profile?.branch_id]);

  const lastType: PunchType | null = punches.at(-1)?.type ?? null;
  const allowed = nextAllowedPunchTypes(lastType);
  const workStatus = workStatusFromLastPunch(lastType);

  const doPunch = useCallback(
    async (type: PunchType, selfieB64: string | null) => {
      if (!profile) return;
      setBusy(true);
      setError(null);
      setNote(null);
      const res = await submitWebPunch({ profile, branchId: profile.branch_id, type, selfieB64 });
      if (!res.ok) {
        setError(res.error ?? 'Punch failed — please try again.');
      } else {
        if (res.gps && branch) {
          const f = checkGeofence(res.gps.lat, res.gps.lng, branch.lat, branch.lng, branch.geofence_radius_m);
          setNote(
            f.inside
              ? `${PUNCH_LABELS[type]} recorded · inside ${branch.name} (${Math.round(f.distanceM)} m from center)`
              : `${PUNCH_LABELS[type]} recorded · ${Math.round(f.distanceM)} m from ${branch.name} — outside geofence, HR will review`,
          );
        } else {
          setNote(`${PUNCH_LABELS[type]} recorded · no GPS fix, HR will review location`);
        }
        await loadPunches();
      }
      setBusy(false);
    },
    [profile, branch, loadPunches],
  );

  const onAction = (type: PunchType) => {
    if (busy) return;
    // Clock in/out require a selfie: open the camera, which calls back with a
    // selfie (or null). Breaks stay one-tap.
    if (SELFIE_PUNCH_TYPES.includes(type)) setSelfieFor(type);
    else void doPunch(type, null);
  };

  const timeLabel = useMemo(() => clockFmt.format(now), [now]);
  const dateLabel = useMemo(() => dateFmt.format(now), [now]);

  if (!profile) return null;

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title="My time clock" crumb="My time clock" subtitle={branch?.name} />

      <div className="card flex flex-col items-center py-8">
        <div className="text-5xl font-bold tabular-nums text-ink">{timeLabel}</div>
        <div className="mt-1 text-sm text-muted">{dateLabel}</div>
        <span className={`pill mt-4 ${STATUS_STYLE[workStatus]}`}>{STATUS_LABEL[workStatus]}</span>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {allowed.map((type) => (
          <button
            key={type}
            onClick={() => onAction(type)}
            disabled={busy}
            className={`rounded-2xl py-5 text-lg font-bold text-white transition disabled:opacity-50 ${
              type === 'clock_in'
                ? 'bg-green-600 hover:bg-green-700'
                : type === 'clock_out'
                  ? 'bg-red-600 hover:bg-red-700'
                  : 'bg-amber-600 hover:bg-amber-700'
            }`}
          >
            {busy ? '…' : PUNCH_LABELS[type]}
          </button>
        ))}
      </div>

      {note && <p className="mt-4 rounded-xl bg-ground px-4 py-3 text-sm text-ink">{note}</p>}
      {error && <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p>}

      <div className="mt-6 flex flex-wrap gap-2">
        <Link to="/my/leave" className="btn">
          Leave &amp; balances
        </Link>
        <Link to="/my/password" className="btn">
          Change password
        </Link>
      </div>

      <h3 className="mt-8 text-sm font-semibold uppercase tracking-wide text-muted">Recent punches</h3>
      <div className="mt-2 space-y-2">
        {punches.length === 0 && <p className="text-sm text-muted">No recent punches.</p>}
        {[...punches].reverse().map((p, i) => (
          <div key={`${p.happened_at}-${i}`} className="card flex items-center justify-between px-4 py-3">
            <div>
              <div className="text-sm font-semibold text-ink">{PUNCH_LABELS[p.type]}</div>
              <div className="text-xs text-muted">{punchTimeFmt.format(new Date(p.happened_at))}</div>
            </div>
            {p.inside_geofence !== null && (
              <span className="text-xs text-muted">
                {p.inside_geofence
                  ? '📍 In branch'
                  : `📍 ${Math.round(p.distance_from_branch_m ?? 0)} m away`}
              </span>
            )}
          </div>
        ))}
      </div>

      {selfieFor && (
        <WebcamCapture
          title={`${PUNCH_LABELS[selfieFor]} — look at the camera`}
          onCapture={(b64) => {
            const t = selfieFor;
            setSelfieFor(null);
            void doPunch(t, b64);
          }}
          onCancel={() => setSelfieFor(null)}
        />
      )}
    </div>
  );
}
