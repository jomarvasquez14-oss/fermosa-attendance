import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { supabase } from '../lib/supabase';

/**
 * Self-service kiosk PIN — an employee sets or changes their own 4–6 digit PIN
 * (used to time in on a shared branch tablet). Mirrors the Change password page.
 * Goes through the set_my_pin RPC, which always targets auth.uid().
 */
export function KioskPin() {
  const navigate = useNavigate();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!/^[0-9]{4,6}$/.test(pin)) {
      setError('PIN must be 4–6 digits.');
      return;
    }
    setBusy(true);
    const { error: err } = await supabase.rpc('set_my_pin', { p_pin: pin });
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    setDone(true);
  };

  return (
    <div className="mx-auto max-w-md">
      <PageHeader
        title="Kiosk PIN"
        crumb="Kiosk PIN"
        subtitle="A 4–6 digit code for timing in on a shared branch tablet."
      />
      <div className="card p-6">
        {done ? (
          <>
            <p className="text-sm font-medium text-green-700">
              ✅ Your kiosk PIN has been saved. Use it to time in on a branch tablet.
            </p>
            <button onClick={() => navigate('/my')} className="btn-primary mt-4 w-full">
              Done
            </button>
          </>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-ink">New PIN</label>
              <input
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                placeholder="4–6 digits"
                className="input"
              />
              <p className="mt-1 text-xs text-muted">You can change it anytime.</p>
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              type="submit"
              disabled={busy || pin.length < 4}
              className="btn-primary w-full disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save kiosk PIN'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
