import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

interface DeviceRow {
  id: string;
  name: string;
  is_active: boolean;
  last_seen_at: string | null;
  created_at: string;
  branch: { name: string } | null;
}

const dateFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
});

export function Kiosks() {
  const [rows, setRows] = useState<DeviceRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    supabase
      .from('attendance_devices')
      .select('id, name, is_active, last_seen_at, created_at, branch:branches(name)')
      .order('created_at', { ascending: false })
      .then(({ data }) => setRows((data as unknown as DeviceRow[]) ?? []));
  }, []);

  useEffect(load, [load]);

  const toggle = async (d: DeviceRow) => {
    setError(null);
    const { error: err } = await supabase
      .from('attendance_devices')
      .update({ is_active: !d.is_active })
      .eq('id', d.id);
    if (err) setError(err.message);
    else load();
  };

  return (
    <div className="mx-auto max-w-4xl">
      <h2 className="text-lg font-semibold text-gray-900">Kiosk devices</h2>
      <p className="text-sm text-gray-500">
        Shared branch tablets. New kiosks are registered from the mobile app on the device itself
        (admin sign-in → &ldquo;Set up this device as a branch kiosk&rdquo;). Deactivating a device
        blocks its punches immediately.
      </p>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-4 overflow-hidden rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="px-4 py-2 font-medium">Device</th>
              <th className="px-4 py-2 font-medium">Branch</th>
              <th className="px-4 py-2 font-medium">Last punch</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-gray-400">
                  No kiosks registered yet.
                </td>
              </tr>
            )}
            {rows.map((d) => (
              <tr key={d.id} className="hover:bg-gray-50">
                <td className="px-4 py-2 font-medium text-gray-900">{d.name}</td>
                <td className="px-4 py-2 text-gray-600">{d.branch?.name ?? '—'}</td>
                <td className="px-4 py-2 text-gray-600">
                  {d.last_seen_at ? dateFmt.format(new Date(d.last_seen_at)) : 'Never'}
                </td>
                <td className="px-4 py-2">
                  <span
                    className={
                      d.is_active
                        ? 'rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700'
                        : 'rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500'
                    }
                  >
                    {d.is_active ? 'Active' : 'Deactivated'}
                  </span>
                </td>
                <td className="px-4 py-2 text-right">
                  <button onClick={() => toggle(d)} className="text-sm text-brand-700 hover:underline">
                    {d.is_active ? 'Deactivate' : 'Reactivate'}
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
