import * as SQLite from 'expo-sqlite';
import type { PunchType } from '@fermosa/shared';

/**
 * Local punch queue. Every punch is written here FIRST — even when online —
 * and a sync worker uploads rows to Supabase. The UI reads from this table.
 */

export type LocalSyncStatus = 'pending_sync' | 'syncing' | 'synced' | 'failed';

export interface LocalPunch {
  client_uuid: string;
  type: PunchType;
  happened_at: string; // ISO, device time — the official punch time
  branch_id: string | null;
  lat: number | null;
  lng: number | null;
  gps_accuracy_m: number | null;
  device_info: string | null; // JSON string
  sync_status: LocalSyncStatus;
  attempts: number;
  last_error: string | null;
  inside_geofence: number | null; // 0/1, server verdict after sync
  distance_m: number | null;
  selfie_b64: string | null; // compressed jpeg awaiting upload; cleared once uploaded
  selfie_path: string | null; // storage path after upload
}

const db = SQLite.openDatabaseSync('fermosa-attendance.db');

// Setup runs on every launch (and again on dev hot reloads, where a stale
// native handle can reject statements) — each step is individually safe to
// re-run and individually tolerated on failure.
function safeExec(sql: string): void {
  try {
    db.execSync(sql);
  } catch {
    // duplicate column / transient hot-reload failure — non-fatal
  }
}

safeExec(`create table if not exists punches (
  client_uuid text primary key,
  type text not null,
  happened_at text not null,
  branch_id text,
  lat real,
  lng real,
  gps_accuracy_m real,
  device_info text,
  sync_status text not null default 'pending_sync',
  attempts integer not null default 0,
  last_error text,
  inside_geofence integer,
  distance_m real
)`);
safeExec('create index if not exists punches_happened_idx on punches (happened_at desc)');
safeExec('create table if not exists app_kv (key text primary key, value text not null)');

// Lightweight local migration: M3 added selfie columns.
try {
  const punchCols = db.getAllSync<{ name: string }>('pragma table_info(punches)');
  if (!punchCols.some((c) => c.name === 'selfie_b64')) {
    safeExec('alter table punches add column selfie_b64 text');
  }
  if (!punchCols.some((c) => c.name === 'selfie_path')) {
    safeExec('alter table punches add column selfie_path text');
  }
} catch {
  // pragma failed on a stale handle; the next cold start migrates cleanly
}

/**
 * Tiny synchronous key/value store on OUR database. Deliberately not
 * expo-sqlite/kv-store: that engine is reserved for the Supabase session
 * (its async calls and our sync calls racing on one connection at startup
 * poisoned the connection — the M3 hot-reload crash).
 */
export function kvGetSync(key: string): string | null {
  try {
    const row = db.getFirstSync<{ value: string }>('select value from app_kv where key = ?', [key]);
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export function kvSetSync(key: string, value: string): void {
  db.runSync('insert into app_kv (key, value) values (?, ?) on conflict (key) do update set value = excluded.value', [key, value]);
}

export function kvRemoveSync(key: string): void {
  db.runSync('delete from app_kv where key = ?', [key]);
}

export function insertPunch(p: {
  client_uuid: string;
  type: PunchType;
  happened_at: string;
  branch_id: string | null;
  lat: number | null;
  lng: number | null;
  gps_accuracy_m: number | null;
  device_info: string | null;
  selfie_b64: string | null;
}): void {
  db.runSync(
    `insert into punches (client_uuid, type, happened_at, branch_id, lat, lng, gps_accuracy_m, device_info, selfie_b64)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [p.client_uuid, p.type, p.happened_at, p.branch_id, p.lat, p.lng, p.gps_accuracy_m, p.device_info, p.selfie_b64],
  );
}

/** Selfie uploaded: remember the storage path, drop the heavy base64 payload. */
export function setSelfieUploaded(clientUuid: string, path: string): void {
  db.runSync('update punches set selfie_path = ?, selfie_b64 = null where client_uuid = ?', [
    path,
    clientUuid,
  ]);
}

export function punchesSince(isoUtc: string): LocalPunch[] {
  return db.getAllSync<LocalPunch>(
    'select * from punches where happened_at >= ? order by happened_at asc',
    [isoUtc],
  );
}

export function unsyncedPunches(): LocalPunch[] {
  return db.getAllSync<LocalPunch>(
    "select * from punches where sync_status in ('pending_sync', 'failed') order by happened_at asc",
  );
}

export function pendingCount(): number {
  const row = db.getFirstSync<{ n: number }>(
    "select count(*) as n from punches where sync_status in ('pending_sync', 'failed', 'syncing')",
  );
  return row?.n ?? 0;
}

export function markSyncing(clientUuid: string): void {
  db.runSync("update punches set sync_status = 'syncing' where client_uuid = ?", [clientUuid]);
}

export function markSynced(
  clientUuid: string,
  server: { inside_geofence: boolean | null; distance_m: number | null },
): void {
  db.runSync(
    `update punches set sync_status = 'synced', last_error = null,
       inside_geofence = ?, distance_m = ?
     where client_uuid = ?`,
    [
      server.inside_geofence === null ? null : server.inside_geofence ? 1 : 0,
      server.distance_m,
      clientUuid,
    ],
  );
}

export function markFailed(clientUuid: string, error: string): void {
  db.runSync(
    `update punches set sync_status = 'failed', attempts = attempts + 1, last_error = ?
     where client_uuid = ?`,
    [error.slice(0, 300), clientUuid],
  );
}
