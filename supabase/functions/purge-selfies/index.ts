// purge-selfies — storage retention: delete attendance selfies older than 7 days.
//
// Selfies are proof for HR review, which happens within a day or two. After 7
// days they are no longer needed, so this job removes them from the private
// `selfies` bucket to cap storage growth
// (~100 staff × 2 selfies/day × ~60 KB × 7 days ≈ 84 MB steady-state).
//
// Called daily by pg_cron (see the selfie-retention migration). It is NOT a
// user endpoint: it authorises with a shared PURGE_SECRET header so only the
// scheduler (or an admin running it manually) can trigger it.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const RETENTION_DAYS = 7;
const BATCH = 500; // rows per pass
const MAX_BATCHES = 20; // cap per run so a backlog can't time the function out

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { ok: false, error: 'method not allowed' });

  const secret = Deno.env.get('PURGE_SECRET');
  if (!secret || req.headers.get('x-purge-secret') !== secret) {
    return json(401, { ok: false, error: 'unauthorized' });
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let purged = 0;
  let failed = 0;

  for (let i = 0; i < MAX_BATCHES; i++) {
    // Oldest first; received_at ≈ selfie upload time (they ride the same sync).
    const { data: rows, error: selErr } = await admin
      .from('attendance_events')
      .select('id, selfie_path')
      .not('selfie_path', 'is', null)
      .lt('received_at', cutoff)
      .order('received_at', { ascending: true })
      .limit(BATCH);
    if (selErr) return json(500, { ok: false, error: selErr.message, purged, failed });
    if (!rows || rows.length === 0) break;

    const paths = rows.map((r) => r.selfie_path as string);
    const ids = rows.map((r) => r.id as string);

    const { error: rmErr } = await admin.storage.from('selfies').remove(paths);
    if (rmErr) {
      // Leave selfie_path set so these retry next run; stop this pass.
      failed += paths.length;
      return json(200, { ok: true, purged, failed, note: `storage remove failed: ${rmErr.message}` });
    }

    // Object gone → drop the now-dangling pointer (UI shows it as "no selfie").
    const { error: updErr } = await admin
      .from('attendance_events')
      .update({ selfie_path: null })
      .in('id', ids);
    if (updErr) return json(500, { ok: false, error: updErr.message, purged, failed });

    purged += paths.length;
    if (rows.length < BATCH) break; // drained
  }

  return json(200, { ok: true, purged, failed, retention_days: RETENTION_DAYS });
});
