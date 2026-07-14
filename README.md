# Fermosa Attendance System

Custom attendance system for Fermosa Skin Care Clinic (22 branches): mobile clock-in/out with GPS geofencing and selfie proof, offline-first sync, HR approval workflow, scheduling, leave management, reporting, and payroll export to Google Sheets.

## Structure

```
apps/
  mobile/        Expo React Native app (employee + kiosk mode)
  dashboard/     Vite React admin dashboard (HR / managers)
packages/
  shared/        Shared TS types, constants, geofence math
supabase/
  migrations/    Postgres schema (SQL)
  functions/     Edge Functions (Deno)
docs/            Spec and plan
```

## Prerequisites

- Node.js ≥ 20, npm ≥ 10
- Docker Desktop (for local Supabase) — or a hosted Supabase project
- Expo Go app on a phone (for mobile dev), or Android emulator

## Getting started

```powershell
npm install

# Database — hosted Supabase (current dev setup, see docs/SETUP-SUPABASE.md):
#   create the project, then:
npx supabase@latest link --project-ref <ref>
npx supabase@latest db push

# ...or local database (requires Docker):
npm run db:start          # starts local Supabase, prints URL + anon key
npm run db:reset          # applies migrations + seed

# Apps (put the Supabase URL + anon key in each app's .env first — see .env.example files):
npm run dashboard         # web dashboard at http://localhost:5173
npm run mobile            # Expo dev server

npm test                  # unit tests
```

## Test accounts (seed data, local dev only)

| Role | Email | Password |
|---|---|---|
| Super Admin | admin@fermosa.test | password123 |
| HR | hr@fermosa.test | password123 |
| Operations Manager | ops@fermosa.test | password123 |
| Branch Manager (Trece) | manager.trece@fermosa.test | password123 |
| Employee (Trece) | maria@fermosa.test | password123 |
| Employee (Dasma) | ana@fermosa.test | password123 |
