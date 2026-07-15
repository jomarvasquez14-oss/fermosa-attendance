# Bulk import — branches + employees

One-time loader to populate a Supabase project (usually **production**) with a
company's branches and staff, plus holidays, leave types, and this year's leave
entitlements. Idempotent — safe to re-run.

## 1. Fill the sheets

Copy each template and edit the copy (the copies are **gitignored** — they hold
real staff data):

```
cp branches.example.csv  branches.csv
cp employees.example.csv employees.csv
cp holidays.example.csv  holidays.csv
```

- **branches.csv** — `name, address, lat, lng, geofence_radius_m, shift_start,
  shift_end, work_days`.
  - `lat`/`lng`: the branch's real GPS center (from Google Maps → right-click →
    the coordinates). `geofence_radius_m`: 10–5000 (100 m is typical).
  - `shift_start`/`shift_end`: 24-hour `HH:MM`. For an **overnight** shift set
    end ≤ start (e.g. `22:00`,`06:00`).
  - `work_days`: ISO weekday numbers separated by **spaces** — `1`=Mon … `7`=Sun.
    `1 2 3 4 5 6` = Mon–Sat.
- **employees.csv** — `full_name, username, employee_code, role, branch`.
  - `username`: their login (no email needed) — becomes `<username>@fermosa.local`.
  - `role`: one of `employee`, `branch_manager`, `hr`, `operations_manager`,
    `super_admin`. Leave **branch** blank for company-wide roles (hr / operations
    / super_admin).
  - `employee_code`: unique per company (e.g. `FSC-0101`).
- **holidays.csv** — `holiday_date (YYYY-MM-DD), name, kind (regular|special)`.
  The template has PH 2026 national holidays; adjust as needed.

## 2. Run (from the repo root)

```bash
SUPABASE_URL=https://<PROD_REF>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service role key> \
COMPANY_NAME="Fermosa Skin Care Clinic" \
node scripts/bulk-import/import.mjs
```

The **service role key** (Supabase → Project Settings → API) bypasses RLS — use
it only here, never in the app. Optional env: `COMPANY_NAME` (created if missing),
`YEAR` (defaults to the current year, for leave entitlements).

## 3. After it runs

- It writes **`credentials.csv`** (also gitignored) — one temp password per new
  employee. Distribute securely; staff change theirs at `/my/password` on first
  login.
- Re-running updates branch coordinates/hours, skips employees that already exist
  (matched on `employee_code`), and never overwrites manual leave-balance edits.

**Not set here:** kiosk **PINs** (web-first round) and the owner **super_admin**
2FA. Set the owner up first (see the rollout runbook §2), then run this loader
for everyone else.
