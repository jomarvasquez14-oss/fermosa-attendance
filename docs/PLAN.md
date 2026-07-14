# Fermosa Attendance System — Project Plan

## Context

Fermosa Skin Care Clinic (22 branches, Philippines) needs an employee attendance system with mobile clock-in/out, GPS geofencing, selfie proof, offline support, HR approval workflow, automatic hours calculation, scheduling, leave management, reporting, and payroll export to Google Sheets. After evaluating Jibble, the decision is to **build a custom system** (full control, no per-user fees, future integration with the Fermosa AI platform).

**Decisions made with the user:**
- **Direction:** Custom build (not Jibble)
- **Stack:** React Native (Expo) mobile app + Supabase backend
- **Scope:** Phases 1–9 of the spec before first launch (identity → payroll integration). Phase 10 enterprise features are designed-for but deferred where possible.
- **Builder:** The user, working here with Claude Code — plan is structured as executable milestones.

Working directory: `D:\Attedance apps` (empty, greenfield).

---

## Architecture Overview

```
┌─────────────────────────┐      ┌──────────────────────────┐
│  Mobile App (Expo RN)   │      │  Web Dashboard (Vite +    │
│  - Employee clock in/out│      │  React + Tailwind/shadcn) │
│  - Kiosk mode (PIN)     │      │  - HR/Manager approvals   │
│  - Offline queue        │      │  - Scheduling, leave      │
└───────────┬─────────────┘      │  - Reports & exports      │
            │                    └────────────┬─────────────┘
            ▼                                 ▼
┌─────────────────────────────────────────────────────────┐
│                       Supabase                          │
│  Postgres (data + RLS RBAC) · Auth · Storage (selfies)  │
│  Edge Functions (attendance engine, Sheets sync, exports)│
└────────────────────────────┬────────────────────────────┘
                             ▼
                    Google Sheets (payroll dataset)
```

**Key components**
1. **Mobile app** — Expo (React Native), TypeScript, Expo Router. Two modes in one app: *personal mode* (employee logs in with own account) and *kiosk mode* (shared tablet locked to a branch; employee enters PIN → selfie → GPS → saved).
2. **Web dashboard** — Vite + React + TypeScript + Tailwind + shadcn/ui, talking directly to Supabase (no custom API server needed). Hosted on Vercel/Netlify.
3. **Supabase** — Postgres with Row Level Security for RBAC, Supabase Auth (email/phone + PIN hash for kiosk), Storage private bucket for selfies, Edge Functions for server-side logic (geofence validation, hours calculation, Google Sheets sync, Excel export).
4. **Monorepo layout:**

```
D:\Attedance apps\
  apps/
    mobile/        # Expo app (employee + kiosk)
    dashboard/     # Vite React admin dashboard
  packages/
    shared/        # Shared TS types, constants, geofence math
  supabase/
    migrations/    # SQL schema migrations
    functions/     # Edge Functions (Deno)
  docs/            # Spec, decisions, runbooks
```

---

## Core Design Decisions

### Data model (Postgres)
- `companies` — multi-business ready (Fermosa, Suteki, etc.) from day 1; every table carries `company_id`.
- `branches` — name, address, `lat`, `lng`, `geofence_radius_m` (e.g. 100), timezone (default Asia/Manila).
- `departments`, `positions`.
- `profiles` — extends `auth.users`: employee ID, name, branch_id, department, position, role, employment_status, `pin_hash` (kiosk), photo.
- `roles` — enum: `employee`, `branch_manager`, `hr`, `operations_manager`, `super_admin` (receptionist/aesthetician/etc. are *positions*, not permission roles).
- `schedules` / `shifts` / `shift_assignments` — shift templates (morning/mid/night/custom), assignable per employee, team, or branch; supports rotation.
- `attendance_events` — the raw punches: `type` (clock_in | break_start | break_end | clock_out), `client_uuid` (idempotency key for offline sync), `happened_at` (device time), `received_at`, lat/lng, `inside_geofence` (server-recomputed), `selfie_path`, `device_info`, `source` (mobile | web | kiosk), `sync_status`.
- `attendance_records` — one row per employee per work day, built from events: computed hours, late minutes, early-out, OT, break duration; `status` (pending_review | approved | rejected | corrected), flags (on_time/late/early_out/no_clock_out/overtime), reviewer, review note.
- `leave_types`, `leave_requests` (manager → HR two-step approval), `leave_balances`, `holidays`.
- `audit_logs` — append-only, trigger-populated on corrections/approvals/role changes.
- `payroll_syncs` — log of what was pushed to Google Sheets (period, row counts, checksum) so sync is idempotent.

### Offline-first sync (the hardest requirement — design it in from day 1)
- Punches are written to a local SQLite queue (`expo-sqlite`) **first, always** — even online. UI reads from local; a background sync worker uploads.
- Each punch gets a client-generated UUID; server upsert is idempotent on `client_uuid`, so retries never duplicate.
- Device timestamp `happened_at` is preserved as the official punch time; `received_at` records upload time. Large gaps get an automatic flag for HR review (defends against device-clock tampering).
- GPS fix is captured at tap time and stored with the queued punch (GPS works without internet). Selfie is saved to the local filesystem and uploaded with the punch.
- Sync statuses surface in the UI exactly as the spec: 📱 Pending Sync → ⏳ Pending Review → ✅/❌/✏️.

### Verification layer
- **Geofence:** client checks distance for instant UX feedback, but the **server recomputes** haversine distance against the branch geofence on ingest — client is never trusted. Out-of-fence punches are accepted but flagged (HR decides), not silently dropped.
- **Selfie:** front-camera capture required on clock in/out; stored in a **private** Supabase Storage bucket (path `selfies/{company}/{employee}/{date}/…`), served to reviewers via short-lived signed URLs. V1 verification is **human review** (HR sees selfie + profile photo side by side). Automated face-matching is deferred to the AI phase (options noted: on-device face detect for liveness hinting, AWS Rekognition/Face++ for matching).
- **Kiosk PIN:** shared tablet in branch-locked kiosk mode. Flow: PIN → selfie → GPS → saved. PINs stored hashed; kiosk device registers itself to a branch.

### Attendance engine
- Postgres functions + an Edge Function (invoked on event ingest and by a nightly job) pair punches into daily `attendance_records`, compare against the employee's assigned shift, and compute worked hours, late, early-out, OT (only counted past a configurable threshold), break time, holiday/rest-day classification, and absences (scheduled but no punches).
- All computations recalculate when HR corrects a record; corrections always write an audit log entry.

### RBAC
- Supabase RLS policies keyed on the requester's role + branch: employees see only their own data; branch managers see their branch; HR/ops/super-admin see company-wide. Enforced in the database, not just the UI.

### Payroll → Google Sheets
- Edge Function (manual trigger from dashboard + scheduled) pushes **approved-only** records for a pay period to a Google Sheet via a service account. Idempotent per period (tracked in `payroll_syncs`). Excel/CSV export from the dashboard uses SheetJS.

---

## Milestones (each ends runnable + verifiable)

**M0 — Foundation (≈ setup)**
Monorepo scaffold, Supabase project + local CLI, initial migrations (companies, branches, profiles, roles), seed script (Fermosa + a few branches with real coordinates + test users per role), auth wired in both apps, RLS baseline. *Verify: log in as each role; RLS blocks cross-branch reads.*

**M1 — Employee Identity (Phase 1)**
Dashboard CRUD for employees, branches, departments, positions; role assignment; employment status; PIN setup. *Verify: create employee on dashboard → log in on mobile.*

**M2 — Time Clock + Offline (Phase 2)**
Mobile clock in / break / clock out; local SQLite queue; background sync; idempotent server ingest; sync-status UI. *Verify: airplane-mode punch → re-enable network → record appears server-side with original timestamp, no duplicates on retry.*

**M3 — Verification Layer (Phase 3)**
GPS capture + server-side geofence check; selfie capture + private storage + signed URLs; kiosk mode (branch-locked tablet, PIN flow); approval workflow (pending review → approve/reject/correct) with audit logs. *Verify: punch outside geofence gets flagged; reviewer sees selfie; correction writes audit log.*

**M4 — Attendance Engine (Phase 4)**
Daily record builder, hours/late/early-out/OT/break/holiday/absent calculations, flags, recalculation on correction, nightly no-clock-out sweep. *Verify: table-driven unit tests over punch scenarios (late, OT, missed clock-out, holiday).*

**M5 — Scheduling (Phase 5)**
Shift templates, assignment by employee/team/branch, rotation support; engine reads schedules for late/OT logic (until M5, a default branch schedule is used). *Verify: assign night shift → late computed against it.*

**M6 — Leave Management (Phase 6)**
Leave types, request flow (employee → manager → HR), balances auto-update, leave reflected in attendance records/absence logic. *Verify: full request→approve cycle; balance decrements; approved leave day not marked absent.*

**M7 — Dashboards (Phase 7)**
Branch manager live view (clocked in / late / absent now), pending reviews queue, leave queue, daily summary; HR company-wide equivalents. *Verify: seed a day of punches; dashboard numbers match.*

**M8 — Reporting (Phase 8)**
Daily/weekly/monthly, per-employee, per-branch, overtime, leave, payroll-attendance reports; Excel + CSV export. *Verify: export against known seed data, check totals.*

**M9 — Payroll Sheets Sync (Phase 9)**
Google service-account integration, approved-only push per pay period, idempotent re-push, sync log UI. *Verify: approve records → sync → rows in Sheet; re-run sync → no duplicates.*

**M10 — Hardening & rollout prep**
2FA for HR/ops/super-admin roles, audit-log viewer, EAS builds (Android APK/AAB + iOS TestFlight), pilot-branch rollout runbook, kiosk tablet provisioning guide.

*Deferred (designed-for, not built now): automated face matching, AI assistant/natural-language queries, payroll/ERP APIs beyond Sheets — schema and event log already support them.*

---

## Risks & Practical Notes

- **iOS distribution** needs an Apple Developer account ($99/yr) + TestFlight; Android can sideload APKs immediately. Kiosk tablets are Android — cheapest path.
- **GPS spoofing** is possible on rooted/developer devices; mitigations: mock-location detection flag on Android, selfie proof, HR review. Don't promise perfect anti-fraud.
- **Selfie storage growth**: ~2 punches × selfie/day × headcount. Compress to ~100 KB; add a retention policy (e.g., purge after 6 months post-approval).
- **Device clock tampering**: flag large `happened_at` vs `received_at` gaps for review.
- **Timezone**: single-TZ (Asia/Manila) now, but store everything UTC with branch TZ — free multi-TZ later.
- **Supabase tier**: free tier fine for development; Pro (~$25/mo) recommended for production (daily backups, no project pausing).
- Phases 1–9 before launch is a long runway; each milestone is independently demo-able, so a pilot branch can start realistic testing from M3–M4 even before full launch.

## Verification (end-to-end)

- Unit tests for the attendance engine (Vitest) and geofence math run in CI-style via `npm test`.
- Mobile app exercised in Expo Go / Android emulator: full punch flow incl. airplane-mode offline test.
- Dashboard exercised via the browser preview against local Supabase (`supabase start`) with seed data.
- Per-milestone verify steps listed above; before rollout, a scripted end-to-end scenario: seed branch → employee punches (one in-fence, one out-of-fence, one offline) → manager reviews → engine computes → report exports → Sheets sync.
