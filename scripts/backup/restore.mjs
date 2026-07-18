// Restore a snapshot produced by backup.mjs back into a Supabase project.
//
// Two real use-cases:
//   • Surgical recovery — someone deleted rows (e.g. a day of punches / payroll
//     records) in a live project; restore just those tables. Parents (profiles,
//     branches, auth users) still exist, so foreign keys resolve.
//   • Disaster recovery — load a snapshot into a CLEAN/empty project. Restore
//     the login accounts FIRST via Supabase's own tools or re-create them; this
//     script does NOT recreate auth.users (passwords aren't in the snapshot),
//     so profiles will fail until the matching auth users exist. Supabase Pro's
//     native backup is the right tool for a full incl.-passwords restore.
//
// Writes are GATED: without --yes it only previews (dry-run).
//
// Env (the TARGET project to restore INTO):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (required)
//   BACKUP_BUCKET  (default 'backups')  — only for --object / --list
//
// Usage:
//   node restore.mjs --list --label=fermosa
//   node restore.mjs --object=fermosa/2026-07-18.json               (dry-run)
//   node restore.mjs --object=fermosa/2026-07-18.json --yes         (writes ALL)
//   node restore.mjs --file=snapshot.json --tables=attendance_records,attendance_events --yes
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { TABLES } from './tables.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);

const URL = need('SUPABASE_URL');
const SERVICE_KEY = need('SUPABASE_SERVICE_ROLE_KEY');
const BUCKET = (process.env.BACKUP_BUCKET || 'backups').trim();
const WRITE = args.yes === true;
const CHUNK = 500;

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env ${name}`);
    process.exit(2);
  }
  return v;
}

const db = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });

async function listBackups() {
  const label = args.label || '';
  const { data, error } = await db.storage.from(BUCKET).list(label || undefined, {
    limit: 1000,
    sortBy: { column: 'name', order: 'desc' },
  });
  if (error) throw new Error(`list ${BUCKET}/${label}: ${error.message}`);
  console.log(`Backups in ${BUCKET}/${label || '(root)'}:`);
  for (const o of data ?? []) console.log(`  ${label ? label + '/' : ''}${o.name}`);
}

async function loadSnapshot() {
  if (args.file) return JSON.parse(readFileSync(args.file, 'utf8'));
  if (args.object) {
    const { data, error } = await db.storage.from(BUCKET).download(args.object);
    if (error) throw new Error(`download ${BUCKET}/${args.object}: ${error.message}`);
    return JSON.parse(await data.text());
  }
  throw new Error('provide --file=<path> or --object=<label/name.json> (or --list)');
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function restore() {
  const snap = await loadSnapshot();
  if (!snap?.tables) throw new Error('not a valid snapshot (missing .tables)');

  const only = typeof args.tables === 'string' ? args.tables.split(',').map((s) => s.trim()) : null;
  const order = TABLES.filter((t) => !only || only.includes(t));

  console.log(`Snapshot taken_at: ${snap._meta?.taken_at ?? 'unknown'}`);
  console.log(WRITE ? '*** WRITE MODE — this will modify the target DB ***' : '(dry-run — no writes; pass --yes to apply)');
  console.log(`Target: ${URL}`);
  console.log('');

  let totalOk = 0;
  let totalFail = 0;
  for (const t of order) {
    const rows = snap.tables[t] ?? [];
    if (!rows.length) {
      console.log(`  skip  ${t} (0 rows in snapshot)`);
      continue;
    }
    if (!WRITE) {
      console.log(`  would restore ${String(rows.length).padStart(6)}  ${t}`);
      continue;
    }
    // audit_logs.id is GENERATED ALWAYS — strip it and insert fresh (append-only
    // history; re-running may duplicate). Everything else upserts on its PK.
    let ok = 0;
    let failed = 0;
    let lastErr = '';
    for (const part of chunk(rows, CHUNK)) {
      let res;
      if (t === 'audit_logs') {
        res = await db.from(t).insert(part.map(({ id, ...r }) => r));
      } else {
        res = await db.from(t).upsert(part);
      }
      if (res.error) {
        failed += part.length;
        lastErr = res.error.message;
      } else {
        ok += part.length;
      }
    }
    totalOk += ok;
    totalFail += failed;
    console.log(
      `  ${failed ? 'PART' : ' ok '}  ${String(ok).padStart(6)}/${rows.length}  ${t}` +
        (failed ? `  (${failed} failed: ${lastErr})` : ''),
    );
  }

  if (WRITE) console.log(`\nRestored ${totalOk} rows${totalFail ? `, ${totalFail} failed` : ''}.`);
  else console.log('\nDry-run complete. Re-run with --yes to apply.');
  if (snap.auth_users?.length) {
    console.log(
      `Note: ${snap.auth_users.length} login account(s) are in the snapshot as a roster only ` +
        '(no passwords). Recreate logins / reset passwords separately — see docs/BACKUP-RESTORE.md.',
    );
  }
}

const main = args.list ? listBackups : restore;
main().catch((e) => {
  console.error(`RESTORE FAILED: ${e.message}`);
  process.exit(1);
});
