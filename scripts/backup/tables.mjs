// Business tables in FK-safe order (parents first). Shared by backup.mjs and
// restore.mjs so a full-project load inserts in a valid sequence. Schema itself
// lives in git (supabase/migrations); this is the data these snapshots carry.
export const TABLES = [
  'companies',
  'departments',
  'positions',
  'branches',
  'holidays',
  'attendance_settings',
  'leave_types',
  'profiles',
  'attendance_devices',
  'leave_requests',
  'leave_balances',
  'employee_compensation',
  'attendance_events',
  'attendance_records',
  'payroll_syncs',
  'audit_logs',
];
