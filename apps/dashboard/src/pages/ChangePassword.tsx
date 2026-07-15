import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { supabase } from '../lib/supabase';

/** Self-service password change for the signed-in user (already authenticated → no current-password step). */
export function ChangePassword() {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    const { error: updErr } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (updErr) {
      setError(updErr.message);
      return;
    }
    setDone(true);
  };

  return (
    <div className="mx-auto max-w-md">
      <PageHeader
        title="Change password"
        crumb="Change password"
        subtitle="Set a new password for your account."
      />
      <div className="card p-6">
        {done ? (
          <>
            <p className="text-sm font-medium text-green-700">✅ Your password has been changed.</p>
            <button onClick={() => navigate('/my')} className="btn-primary mt-4 w-full">
              Done
            </button>
          </>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-ink">New password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                placeholder="at least 8 characters"
                className="input"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink">Confirm new password</label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                placeholder="re-type it"
                className="input"
              />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button type="submit" disabled={busy} className="btn-primary w-full disabled:opacity-50">
              {busy ? 'Saving…' : 'Save new password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
