# Hosted Supabase Setup (one-time, ~5 minutes)

We use a free hosted Supabase project as the development database (Docker is not
installed on this machine, so local `supabase start` is unavailable).

## 1. Create the project (you do this part)

1. Go to <https://supabase.com> → **Start your project** → sign in (GitHub or email).
2. **New project**:
   - Organization: your personal org is fine for dev
   - Name: `fermosa-attendance-dev`
   - Database password: generate a strong one and **save it** (needed for migrations)
   - Region: **Southeast Asia (Singapore)** — closest to the Philippines
3. Wait ~2 minutes for provisioning.

## 2. Collect the credentials

From the project dashboard → **Settings → API**:

| Value | Where it goes |
|---|---|
| Project URL (`https://xxxx.supabase.co`) | `apps/dashboard/.env` → `VITE_SUPABASE_URL`, `apps/mobile/.env` → `EXPO_PUBLIC_SUPABASE_URL` |
| `anon` `public` key | `VITE_SUPABASE_ANON_KEY` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` |
| Database password (from step 1) | used once when linking the CLI |

Paste the Project URL + anon key into the chat (they are safe to share — the anon
key is public by design; RLS is what protects the data). **Never share the
`service_role` key or database password in chat.**

## 3. Apply migrations + seed (Claude does this part)

Done for the current dev project (`lvoqvkbydbkyyaxonzmp`, region **ap-south-1 / Mumbai**).

The direct connection host (`db.<ref>.supabase.co`) is IPv6-only and does not
resolve on this network, so migrations go through the **session pooler**:

```powershell
npx supabase@latest db push --db-url "postgresql://postgres.lvoqvkbydbkyyaxonzmp:<DB-PASSWORD>@aws-1-ap-south-1.pooler.supabase.com:5432/postgres" --yes
```

The dev seed (`supabase/seed.sql`) was applied over the same pooler connection;
it creates the test users below with password `password123`.
**Dev only — never run the seed against a production project.**

## 4. Test accounts (after seeding)

| Email | Role |
|---|---|
| admin@fermosa.test | Super Admin |
| hr@fermosa.test | HR |
| ops@fermosa.test | Operations Manager |
| manager.trece@fermosa.test | Branch Manager (Trece) |
| maria@fermosa.test | Employee (Trece) |
| ana@fermosa.test | Employee (Dasmariñas) |

## Notes

- Free tier pauses projects after ~1 week of inactivity — just hit **Restore** in
  the dashboard when it happens.
- For production we'll create a separate project on the Pro plan (daily backups,
  no pausing) with real branch coordinates and no seed users.
