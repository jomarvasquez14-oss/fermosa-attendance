import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { readKioskConfig, registerAndStoreKiosk } from '../lib/kioskWeb';
import { supabase } from '../lib/supabase';

/**
 * Bare, full-screen kiosk provisioning page shown to a signed-in `kiosk`-role
 * login (never the dashboard shell — see RequireAuth). The account is locked to
 * one branch, so there is no branch picker: just name the device and activate,
 * which registers the device and opens the locked /kiosk terminal.
 */
export function KioskSetup() {
  const { profile, signOut } = useAuth();
  const navigate = useNavigate();
  const [branchName, setBranchName] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const existing = readKioskConfig();

  useEffect(() => {
    if (!profile?.branch_id) return;
    supabase
      .from('branches')
      .select('name')
      .eq('id', profile.branch_id)
      .maybeSingle()
      .then(({ data }) => setBranchName((data as { name: string } | null)?.name ?? null));
  }, [profile?.branch_id]);

  if (!profile) return null;

  const canActivate = !!profile.branch_id && !!branchName && !!deviceName.trim() && !busy;

  const activate = async () => {
    if (!profile.branch_id || !branchName || !deviceName.trim()) return;
    setBusy(true);
    setError(null);
    const res = await registerAndStoreKiosk({
      branchId: profile.branch_id,
      branchName,
      deviceName: deviceName.trim(),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    navigate('/kiosk');
  };

  return (
    <div className="fixed inset-0 flex flex-col bg-ground">
      <div className="fm-bar relative flex items-center justify-between px-5 py-4">
        <div className="fm-bar-shine pointer-events-none absolute inset-0" />
        <div className="relative flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-white shadow-[0_2px_6px_rgba(120,84,0,0.28)]">
            <img src="/fermosa-mark.jpg" alt="Fermosa" className="h-8 w-8 rounded-lg object-contain" />
          </span>
          <div className="relative leading-tight text-white">
            <div className="text-lg font-bold [text-shadow:0_1px_1px_rgba(140,96,0,0.35)]">Kiosk setup</div>
            <div className="text-[11px] text-white/90">{profile.full_name}</div>
          </div>
        </div>
        <button onClick={signOut} className="relative text-xs font-medium text-white/80 hover:text-white">
          Sign out
        </button>
      </div>

      <div className="flex flex-1 items-center justify-center p-6">
        <div className="card w-full max-w-sm space-y-4 p-6">
          {!profile.branch_id ? (
            <p className="text-sm text-muted">
              This kiosk login has no branch assigned yet. Ask an admin to set its branch in
              Settings → Kiosk logins, then sign in again.
            </p>
          ) : (
            <>
              {existing && (
                <div className="rounded-xl bg-ground p-3">
                  <p className="text-sm font-semibold text-ink">
                    This device is already the {existing.branch_name} kiosk.
                  </p>
                  <button onClick={() => navigate('/kiosk')} className="btn-primary mt-2 w-full">
                    Open kiosk terminal
                  </button>
                </div>
              )}
              <div>
                <p className="text-sm font-semibold text-ink">
                  {existing ? 'Re-activate on this device' : 'Set up this tablet as a kiosk'}
                </p>
                <p className="mt-1 text-sm text-muted">
                  This tablet will be the{' '}
                  <span className="font-semibold text-ink">{branchName ?? '…'}</span> kiosk. Staff
                  punch here with their employee code, PIN and a selfie.
                </p>
              </div>
              <label className="block text-sm">
                <span className="block text-xs font-medium text-gray-500">Device name</span>
                <input
                  value={deviceName}
                  onChange={(e) => setDeviceName(e.target.value)}
                  placeholder="e.g. Front desk tablet"
                  className="mt-1 input w-full"
                />
              </label>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <button
                onClick={() => void activate()}
                disabled={!canActivate}
                className="btn-primary w-full disabled:opacity-50"
              >
                {busy ? 'Activating…' : existing ? 'Re-activate' : 'Activate kiosk mode'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
