import type { Profile, PunchType } from '@fermosa/shared';
import { supabase } from './supabase';

export interface GpsFix {
  lat: number;
  lng: number;
  accuracy: number | null;
}

const GPS_TIMEOUT_MS = 6000;

/** UUID that also works in insecure contexts (crypto.randomUUID needs HTTPS/localhost). */
function uuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
}

/** Best-effort browser GPS: a punch must never hang or fail because of location. */
export async function tryGetLocation(): Promise<GpsFix | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation || !window.isSecureContext) {
    return null;
  }
  return new Promise<GpsFix | null>((resolve) => {
    let settled = false;
    const done = (v: GpsFix | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const timer = setTimeout(() => done(null), GPS_TIMEOUT_MS);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        done({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy ?? null,
        });
      },
      () => {
        clearTimeout(timer);
        done(null);
      },
      { enableHighAccuracy: false, timeout: GPS_TIMEOUT_MS, maximumAge: 5 * 60 * 1000 },
    );
  });
}

function base64ToBlob(b64: string, type = 'image/jpeg'): Blob {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type });
}

export interface WebPunchResult {
  ok: boolean;
  error?: string;
  duplicate?: boolean;
  inside_geofence?: boolean | null;
  distance_m?: number | null;
  gps: GpsFix | null;
}

/**
 * Record a punch from the browser as the signed-in employee. Online-only:
 * uploads the selfie (if any) to the employee's own storage prefix, then calls
 * the same `ingest_punch` RPC the mobile app uses, tagged `source='web'`. The
 * server recomputes the geofence — the client result is advisory only.
 */
export async function submitWebPunch(args: {
  profile: Profile;
  branchId: string | null;
  type: PunchType;
  selfieB64: string | null;
}): Promise<WebPunchResult> {
  const { profile, branchId, type, selfieB64 } = args;
  const clientUuid = uuid();
  const gps = await tryGetLocation();

  let selfiePath: string | null = null;
  if (selfieB64) {
    const path = `${profile.company_id}/${profile.id}/${clientUuid}.jpg`;
    const { error: upErr } = await supabase.storage
      .from('selfies')
      .upload(path, base64ToBlob(selfieB64), { contentType: 'image/jpeg', upsert: true });
    // A failed selfie upload never blocks the punch — it just stays unproven.
    if (!upErr) selfiePath = path;
  }

  const { data, error } = await supabase.rpc('ingest_punch', {
    p_client_uuid: clientUuid,
    p_type: type,
    p_happened_at: new Date().toISOString(),
    p_branch_id: branchId,
    p_lat: gps?.lat ?? null,
    p_lng: gps?.lng ?? null,
    p_gps_accuracy_m: gps?.accuracy ?? null,
    p_source: 'web',
    p_device_info: { web: true, ua: navigator.userAgent },
    p_selfie_path: selfiePath,
  });

  if (error) return { ok: false, error: error.message, gps };
  const r = data as { duplicate?: boolean; inside_geofence?: boolean | null; distance_m?: number | null };
  return {
    ok: true,
    duplicate: r?.duplicate ?? false,
    inside_geofence: r?.inside_geofence ?? null,
    distance_m: r?.distance_m ?? null,
    gps,
  };
}
