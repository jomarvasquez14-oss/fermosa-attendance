import { DEFAULT_GEOFENCE_RADIUS_M, DEFAULT_TIMEZONE, type Branch } from '@fermosa/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';

const inputClass =
  'mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none';
const labelClass = 'block text-sm font-medium text-gray-700';

const emptyForm = {
  name: '',
  address: '',
  lat: '',
  lng: '',
  geofence_radius_m: String(DEFAULT_GEOFENCE_RADIUS_M),
  timezone: DEFAULT_TIMEZONE,
  is_active: true,
};

export function Branches() {
  const { profile } = useAuth();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    supabase.from('branches').select('*').order('name')
      .then(({ data }) => setBranches((data as Branch[]) ?? []));
  }, []);

  useEffect(reload, [reload]);

  const startNew = () => {
    setEditingId('new');
    setForm(emptyForm);
    setError(null);
  };

  const startEdit = (b: Branch) => {
    setEditingId(b.id);
    setForm({
      name: b.name,
      address: b.address ?? '',
      lat: String(b.lat),
      lng: String(b.lng),
      geofence_radius_m: String(b.geofence_radius_m),
      timezone: b.timezone,
      is_active: b.is_active,
    });
    setError(null);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const payload = {
      name: form.name.trim(),
      address: form.address.trim() || null,
      lat: Number(form.lat),
      lng: Number(form.lng),
      geofence_radius_m: Number(form.geofence_radius_m),
      timezone: form.timezone.trim() || DEFAULT_TIMEZONE,
      is_active: form.is_active,
    };
    if (Number.isNaN(payload.lat) || Number.isNaN(payload.lng)) {
      setError('Latitude and longitude must be numbers (e.g. 14.2818, 120.8656).');
      setBusy(false);
      return;
    }

    const result =
      editingId === 'new'
        ? await supabase.from('branches').insert({ ...payload, company_id: profile!.company_id })
        : await supabase.from('branches').update(payload).eq('id', editingId!);

    setBusy(false);
    if (result.error) {
      setError(result.error.message);
      return;
    }
    setEditingId(null);
    reload();
  };

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Branches</h2>
          <p className="text-sm text-gray-500">
            Coordinates + radius define each branch&apos;s clock-in geofence.
          </p>
        </div>
        <button
          onClick={startNew}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          New branch
        </button>
      </div>

      {editingId && (
        <form onSubmit={onSubmit} className="mt-4 rounded-xl border border-gray-200 bg-white p-6">
          <h3 className="text-sm font-semibold text-gray-900">
            {editingId === 'new' ? 'New branch' : 'Edit branch'}
          </h3>
          <div className="mt-3 grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Name</label>
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Address</label>
              <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Latitude</label>
              <input required value={form.lat} onChange={(e) => setForm({ ...form, lat: e.target.value })} placeholder="14.2818" className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Longitude</label>
              <input required value={form.lng} onChange={(e) => setForm({ ...form, lng: e.target.value })} placeholder="120.8656" className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Geofence radius (meters, 10–5000)</label>
              <input required type="number" min={10} max={5000} value={form.geofence_radius_m} onChange={(e) => setForm({ ...form, geofence_radius_m: e.target.value })} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Timezone</label>
              <input value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} className={inputClass} />
            </div>
          </div>
          <label className="mt-4 flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={form.is_active}
              onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
            />
            Active
          </label>

          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

          <div className="mt-4 flex gap-2">
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => setEditingId(null)}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="mt-4 overflow-hidden rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="px-4 py-2 font-medium">Branch</th>
              <th className="px-4 py-2 font-medium">Address</th>
              <th className="px-4 py-2 font-medium">Coordinates</th>
              <th className="px-4 py-2 font-medium">Geofence</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {branches.map((b) => (
              <tr key={b.id} className="hover:bg-gray-50">
                <td className="px-4 py-2 font-medium text-gray-900">{b.name}</td>
                <td className="px-4 py-2 text-gray-600">{b.address ?? '—'}</td>
                <td className="px-4 py-2 font-mono text-xs text-gray-600">
                  {b.lat.toFixed(4)}, {b.lng.toFixed(4)}
                </td>
                <td className="px-4 py-2 text-gray-600">{b.geofence_radius_m} m</td>
                <td className="px-4 py-2">
                  <span
                    className={
                      b.is_active
                        ? 'rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700'
                        : 'rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500'
                    }
                  >
                    {b.is_active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="px-4 py-2 text-right">
                  <button onClick={() => startEdit(b)} className="text-sm text-brand-700 hover:underline">
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
