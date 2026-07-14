import { ROLE_LABELS } from '@fermosa/shared';
import { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';

interface BranchRow {
  id: string;
  name: string;
  address: string | null;
  geofence_radius_m: number;
  is_active: boolean;
}

export function Overview() {
  const { profile } = useAuth();
  const [branches, setBranches] = useState<BranchRow[]>([]);

  useEffect(() => {
    supabase
      .from('branches')
      .select('id, name, address, geofence_radius_m, is_active')
      .order('name')
      .then(({ data }) => setBranches((data as BranchRow[]) ?? []));
  }, []);

  if (!profile) return null;

  return (
    <div className="mx-auto max-w-4xl">
      <h2 className="text-lg font-semibold text-gray-900">
        Welcome, {profile.full_name.split(' ')[0]}
      </h2>
      <p className="text-sm text-gray-500">
        {ROLE_LABELS[profile.role]} · {profile.employee_code}
      </p>

      <h3 className="mt-6 text-base font-semibold text-gray-900">Branches you can see</h3>
      <p className="mt-1 text-sm text-gray-500">
        Visibility is enforced by database row-level security based on your role.
      </p>
      <div className="mt-4 overflow-hidden rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="px-4 py-2 font-medium">Branch</th>
              <th className="px-4 py-2 font-medium">Address</th>
              <th className="px-4 py-2 font-medium">Geofence</th>
              <th className="px-4 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {branches.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-gray-400">
                  No branches visible
                </td>
              </tr>
            )}
            {branches.map((b) => (
              <tr key={b.id}>
                <td className="px-4 py-2 font-medium text-gray-900">{b.name}</td>
                <td className="px-4 py-2 text-gray-600">{b.address ?? '—'}</td>
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
