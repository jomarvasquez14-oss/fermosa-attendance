// Bulk importer — load a company's branches + employees (+ holidays, leave
// types, entitlements) from CSVs into a Supabase project in one pass.
//
// Run from the repo root (so @supabase/supabase-js resolves) with the PROD
// service-role key. This bypasses RLS by design — it is an admin bootstrap,
// never committed with secrets, never shipped to clients.
//
//   SUPABASE_URL=https://<ref>.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=<service role key> \
//   node scripts/bulk-import/import.mjs
//
// Idempotent: re-running updates branches, skips employees that already exist
// (matched on employee_code), and never overwrites manual leave-balance edits.
// PINs (kiosk) are intentionally NOT set here — web-first round; set them later.

import { createClient } from '@supabase/supabase-js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const COMPANY_NAME = process.env.COMPANY_NAME || 'Fermosa Skin Care Clinic';
const YEAR = Number(process.env.YEAR || new Date().getFullYear());
const USERNAME_DOMAIN = 'fermosa.local'; // keep in sync with packages/shared USERNAME_EMAIL_DOMAIN

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (prod project).');
  process.exit(1);
}
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// --- minimal CSV (handles quoted fields with commas) ---
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}
function readCsv(name) {
  const path = join(DIR, name);
  if (!existsSync(path)) {
    console.error(`Missing ${name}. Copy ${name.replace('.csv', '.example.csv')} → ${name} and fill it.`);
    process.exit(1);
  }
  const rows = parseCsv(readFileSync(path, 'utf8'));
  const header = rows.shift().map((h) => h.trim());
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}
function usernameToEmail(u) {
  return u.includes('@') ? u.toLowerCase() : `${u.toLowerCase()}@${USERNAME_DOMAIN}`;
}
function tempPassword() {
  return randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) + 'A1';
}
function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  // 1. Company
  let { data: company } = await db.from('companies').select('id').eq('name', COMPANY_NAME).maybeSingle();
  if (!company) {
    const ins = await db.from('companies').insert({ name: COMPANY_NAME }).select('id').single();
    if (ins.error) throw ins.error;
    company = ins.data;
    console.log(`Created company: ${COMPANY_NAME}`);
  }
  const companyId = company.id;

  // 2. Attendance settings (defaults; kept if already present)
  await db.from('attendance_settings').upsert({ company_id: companyId }, { onConflict: 'company_id', ignoreDuplicates: true });

  // 3. Leave types
  for (const lt of [
    { name: 'Vacation', is_paid: true, default_days_per_year: 5 },
    { name: 'Sick', is_paid: true, default_days_per_year: 5 },
    { name: 'Unpaid', is_paid: false, default_days_per_year: 0 },
  ]) {
    await db.from('leave_types').upsert({ company_id: companyId, ...lt }, { onConflict: 'company_id,name', ignoreDuplicates: true });
  }

  // 4. Holidays
  const holidays = readCsv('holidays.csv');
  for (const h of holidays) {
    if (!h.holiday_date) continue;
    await db.from('holidays').upsert(
      { company_id: companyId, holiday_date: h.holiday_date, name: h.name, kind: h.kind || 'regular' },
      { onConflict: 'company_id,holiday_date', ignoreDuplicates: true },
    );
  }
  console.log(`Holidays: ${holidays.length}`);

  // 5. Branches (upsert so a re-run refreshes coords/hours)
  const branchRows = readCsv('branches.csv');
  const branchIdByName = {};
  for (const b of branchRows) {
    const workDays = (b.work_days || '1 2 3 4 5 6').split(/\s+/).map(Number).filter((n) => n >= 1 && n <= 7);
    const { data, error } = await db
      .from('branches')
      .upsert(
        {
          company_id: companyId,
          name: b.name,
          address: b.address || null,
          lat: Number(b.lat),
          lng: Number(b.lng),
          geofence_radius_m: Number(b.geofence_radius_m || 100),
          shift_start: b.shift_start || '10:00',
          shift_end: b.shift_end || '19:00',
          work_days: workDays,
        },
        { onConflict: 'company_id,name' },
      )
      .select('id, name')
      .single();
    if (error) throw new Error(`Branch "${b.name}": ${error.message}`);
    branchIdByName[b.name] = data.id;
  }
  console.log(`Branches: ${branchRows.length}`);

  // 6. Employees (auth user + profile). Company-wide roles may omit branch.
  const empRows = readCsv('employees.csv');
  const creds = [['full_name', 'username', 'employee_code', 'role', 'branch', 'temp_password']];
  let created = 0, skipped = 0;
  for (const e of empRows) {
    if (!e.username || !e.full_name || !e.employee_code) { console.warn('Skipping incomplete row:', JSON.stringify(e)); skipped++; continue; }
    const role = e.role || 'employee';
    const branchId = e.branch ? branchIdByName[e.branch] : null;
    if (e.branch && !branchId) throw new Error(`Employee "${e.username}": unknown branch "${e.branch}"`);

    const { data: existing } = await db.from('profiles').select('id').eq('company_id', companyId).eq('employee_code', e.employee_code).maybeSingle();
    if (existing) { skipped++; continue; }

    const email = usernameToEmail(e.username);
    const password = tempPassword();
    const { data: userRes, error: uErr } = await db.auth.admin.createUser({ email, password, email_confirm: true });
    if (uErr) { console.warn(`Auth create failed for "${e.username}": ${uErr.message}`); skipped++; continue; }
    const userId = userRes.user.id;

    const { error: pErr } = await db.from('profiles').insert({
      id: userId,
      company_id: companyId,
      branch_id: branchId,
      employee_code: e.employee_code,
      full_name: e.full_name,
      role,
      employment_status: 'active',
    });
    if (pErr) {
      await db.auth.admin.deleteUser(userId); // no orphan auth users
      throw new Error(`Profile insert failed for "${e.username}": ${pErr.message}`);
    }
    creds.push([e.full_name, e.username, e.employee_code, role, e.branch || '', password]);
    created++;
  }
  console.log(`Employees created: ${created}, skipped: ${skipped}`);

  // 7. Leave entitlements: every active employee × active leave type (keeps manual edits)
  const { data: types } = await db.from('leave_types').select('id, default_days_per_year').eq('company_id', companyId).eq('is_active', true);
  const { data: emps } = await db.from('profiles').select('id').eq('company_id', companyId).in('employment_status', ['active', 'probationary']);
  const balances = [];
  for (const emp of emps ?? []) for (const t of types ?? []) {
    balances.push({ company_id: companyId, employee_id: emp.id, leave_type_id: t.id, year: YEAR, entitled_days: t.default_days_per_year });
  }
  if (balances.length) {
    const { error } = await db.from('leave_balances').upsert(balances, { onConflict: 'employee_id,leave_type_id,year', ignoreDuplicates: true });
    if (error) throw error;
  }
  console.log(`Leave balances ensured: ${balances.length}`);

  if (created > 0) {
    writeFileSync(join(DIR, 'credentials.csv'), creds.map((r) => r.map(csvCell).join(',')).join('\n'));
    console.log(`Wrote credentials.csv (${created} logins) — distribute securely; staff change theirs at /my/password.`);
  }
  console.log('Done.');
}

main().catch((e) => { console.error('FAILED:', e?.message || e); process.exit(1); });
