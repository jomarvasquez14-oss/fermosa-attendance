// kiosk-punch — attendance punches from shared branch tablets.
//
// Kiosks have no user session, so every claim is verified server-side:
// the device key proves the tablet, the employee code + PIN prove the person,
// and repeated PIN failures lock the employee out for 15 minutes.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const PIN_MAX_FAILURES = 5;
const PIN_WINDOW_MIN = 15;

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { ok: false, error: 'method not allowed' });

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: 'invalid JSON body' });
  }

  const deviceId = String(body.device_id ?? '');
  const deviceKey = String(body.device_key ?? '');
  const employeeCode = String(body.employee_code ?? '').trim();
  const pin = String(body.pin ?? '');
  const type = String(body.type ?? '');
  const clientUuid = String(body.client_uuid ?? '');

  if (!deviceId || !deviceKey) return json(401, { ok: false, error: 'device credentials required' });
  if (!employeeCode || !pin) return json(400, { ok: false, error: 'employee code and PIN required' });
  if (!['clock_in', 'break_start', 'break_end', 'clock_out'].includes(type)) {
    return json(400, { ok: false, error: 'invalid punch type' });
  }
  if (!clientUuid) return json(400, { ok: false, error: 'client_uuid required' });

  // 1. Verify the kiosk device.
  const { data: device } = await admin
    .from('attendance_devices')
    .select('id, company_id, branch_id, is_active, device_key_hash')
    .eq('id', deviceId)
    .maybeSingle();
  if (!device || !device.is_active) return json(401, { ok: false, error: 'unknown or deactivated kiosk device' });

  const { data: keyOk } = await admin.rpc('bcrypt_matches', {
    p_value: deviceKey,
    p_hash: device.device_key_hash,
  });
  if (!keyOk) return json(401, { ok: false, error: 'invalid device key' });

  // 2. Find the employee within the device's company.
  const { data: employee } = await admin
    .from('profiles')
    .select('id, full_name, pin_hash, employment_status')
    .eq('company_id', device.company_id)
    .eq('employee_code', employeeCode)
    .maybeSingle();

  // Uniform error for unknown code vs wrong PIN — no employee-code probing.
  const badCredentials = () => json(401, { ok: false, error: 'invalid employee code or PIN' });

  if (!employee || !employee.pin_hash || employee.employment_status === 'terminated') {
    return badCredentials();
  }

  // 3. Lockout: too many recent failures for this employee?
  const windowStart = new Date(Date.now() - PIN_WINDOW_MIN * 60 * 1000).toISOString();
  const { count: failures } = await admin
    .from('audit_logs')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', device.company_id)
    .eq('action', 'kiosk_pin_failed')
    .eq('record_id', employee.id)
    .gte('created_at', windowStart);
  if ((failures ?? 0) >= PIN_MAX_FAILURES) {
    return json(429, { ok: false, error: `too many failed attempts — try again in ${PIN_WINDOW_MIN} minutes` });
  }

  // 4. Verify the PIN.
  const { data: pinOk } = await admin.rpc('bcrypt_matches', {
    p_value: pin,
    p_hash: employee.pin_hash,
  });
  if (!pinOk) {
    await admin.from('audit_logs').insert({
      company_id: device.company_id,
      action: 'kiosk_pin_failed',
      table_name: 'profiles',
      record_id: employee.id,
      details: { device_id: device.id },
    });
    return badCredentials();
  }

  // 5. Store the selfie, if provided (base64 jpeg from the kiosk camera).
  let selfiePath: string | null = null;
  const selfieB64 = typeof body.selfie_base64 === 'string' ? body.selfie_base64 : null;
  if (selfieB64) {
    try {
      const bytes = Uint8Array.from(atob(selfieB64), (c) => c.charCodeAt(0));
      const path = `${device.company_id}/${employee.id}/${clientUuid}.jpg`;
      const { error: upErr } = await admin.storage
        .from('selfies')
        .upload(path, bytes, { contentType: 'image/jpeg', upsert: true });
      if (!upErr) selfiePath = path;
    } catch {
      // A bad selfie never blocks the punch — it just stays unproven.
    }
  }

  // 6. Ingest the punch as the verified employee, bound to the kiosk's branch.
  const { data: result, error: ingestErr } = await admin.rpc('ingest_punch_as', {
    p_employee_id: employee.id,
    p_client_uuid: clientUuid,
    p_type: type,
    p_happened_at: typeof body.happened_at === 'string' ? body.happened_at : new Date().toISOString(),
    p_branch_id: device.branch_id,
    p_lat: typeof body.lat === 'number' ? body.lat : null,
    p_lng: typeof body.lng === 'number' ? body.lng : null,
    p_gps_accuracy_m: typeof body.gps_accuracy_m === 'number' ? body.gps_accuracy_m : null,
    p_source: 'kiosk',
    p_device_info: { kiosk_device_id: device.id },
    p_selfie_path: selfiePath,
  });
  if (ingestErr) return json(500, { ok: false, error: ingestErr.message });

  await admin
    .from('attendance_devices')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', device.id);

  return json(200, {
    ok: true,
    employee_name: employee.full_name,
    ...(result as Record<string, unknown>),
  });
});
