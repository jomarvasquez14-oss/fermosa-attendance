import { COMPANY_WIDE_ROLES, ROLE_LABELS, type Role, type EmploymentStatus } from '@fermosa/shared';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';

export const STATUS_LABELS: Record<EmploymentStatus, string> = {
  active: 'Active',
  probationary: 'Probationary',
  on_leave: 'On Leave',
  resigned: 'Resigned',
  terminated: 'Terminated',
};

interface EmployeeRow {
  id: string;
  full_name: string;
  employee_code: string;
  role: Role;
  employment_status: EmploymentStatus;
  branch: { id: string; name: string } | null;
  position: { name: string } | null;
}

export function Employees() {
  const { profile } = useAuth();
  const [rows, setRows] = useState<EmployeeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [branchFilter, setBranchFilter] = useState('all');

  const isAdmin = profile ? COMPANY_WIDE_ROLES.includes(profile.role) : false;

  useEffect(() => {
    supabase
      .from('profiles')
      .select(
        'id, full_name, employee_code, role, employment_status, branch:branches(id, name), position:positions(name)',
      )
      .order('full_name')
      .then(({ data }) => {
        setRows((data as unknown as EmployeeRow[]) ?? []);
        setLoading(false);
      });
  }, []);

  const branches = useMemo(() => {
    const map = new Map<string, string>();
    rows.forEach((r) => r.branch && map.set(r.branch.id, r.branch.name));
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  const visible = rows.filter((r) => {
    const q = search.trim().toLowerCase();
    const matchesSearch =
      !q ||
      r.full_name.toLowerCase().includes(q) ||
      r.employee_code.toLowerCase().includes(q);
    const matchesBranch = branchFilter === 'all' || r.branch?.id === branchFilter;
    return matchesSearch && matchesBranch;
  });

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Employees</h2>
          <p className="text-sm text-gray-500">
            {isAdmin ? 'Everyone in the company.' : 'Employees in your branch.'}
          </p>
        </div>
        {isAdmin && (
          <Link
            to="/employees/new"
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            New employee
          </Link>
        )}
      </div>

      <div className="mt-4 flex gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name or code…"
          className="w-64 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
        />
        <select
          value={branchFilter}
          onChange={(e) => setBranchFilter(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
        >
          <option value="all">All branches</option>
          {branches.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Code</th>
              <th className="px-4 py-2 font-medium">Role</th>
              <th className="px-4 py-2 font-medium">Branch</th>
              <th className="px-4 py-2 font-medium">Position</th>
              <th className="px-4 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-gray-400">
                  Loading…
                </td>
              </tr>
            )}
            {!loading && visible.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-gray-400">
                  No employees found
                </td>
              </tr>
            )}
            {visible.map((r) => (
              <tr key={r.id} className="hover:bg-gray-50">
                <td className="px-4 py-2 font-medium text-gray-900">
                  {isAdmin ? (
                    <Link to={`/employees/${r.id}`} className="text-brand-700 hover:underline">
                      {r.full_name}
                    </Link>
                  ) : (
                    r.full_name
                  )}
                </td>
                <td className="px-4 py-2 text-gray-600">{r.employee_code}</td>
                <td className="px-4 py-2 text-gray-600">{ROLE_LABELS[r.role]}</td>
                <td className="px-4 py-2 text-gray-600">{r.branch?.name ?? '—'}</td>
                <td className="px-4 py-2 text-gray-600">{r.position?.name ?? '—'}</td>
                <td className="px-4 py-2">
                  <span
                    className={
                      r.employment_status === 'active' || r.employment_status === 'probationary'
                        ? 'rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700'
                        : 'rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500'
                    }
                  >
                    {STATUS_LABELS[r.employment_status]}
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
