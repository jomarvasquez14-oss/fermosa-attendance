// admin-users — privileged account management for the dashboard.
//
// The browser can never hold the service_role key, so account creation and
// password resets go through this function. It verifies the caller's JWT,
// requires an admin role, and scopes every write to the caller's company.

import { createClient } from 'jsr:@supabase/supabase-js@2';

type Role = 'employee' | 'branch_manager' | 'hr' | 'operations_manager' | 'super_admin';

const ADMIN_ROLES: Role[] = ['hr', 'operations_manager', 'super_admin'];

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { ok: false, error: 'method not allowed' });

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

  // Identify the caller from their JWT.
  const authHeader = req.headers.get('Authorization') ?? '';
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user: caller },
  } = await callerClient.auth.getUser();
  if (!caller) return json(401, { ok: false, error: 'not authenticated' });

  const admin = createClient(supabaseUrl, serviceKey);

  const { data: callerProfile } = await admin
    .from('profiles')
    .select('company_id, role')
    .eq('id', caller.id)
    .maybeSingle();

  if (!callerProfile || !ADMIN_ROLES.includes(callerProfile.role as Role)) {
    return json(403, { ok: false, error: 'admin role required' });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: 'invalid JSON body' });
  }

  if (body.action === 'create') {
    const input = body.input as Record<string, unknown> | undefined;
    const email = String(input?.email ?? '').trim().toLowerCase();
    const password = String(input?.password ?? '');
    const fullName = String(input?.full_name ?? '').trim();
    const employeeCode = String(input?.employee_code ?? '').trim();
    const role = String(input?.role ?? 'employee') as Role;

    if (!email || !email.includes('@')) return json(400, { ok: false, error: 'valid email required' });
    if (password.length < 8) return json(400, { ok: false, error: 'password must be at least 8 characters' });
    if (!fullName) return json(400, { ok: false, error: 'full_name required' });
    if (!employeeCode) return json(400, { ok: false, error: 'employee_code required' });
    if (role === 'super_admin' && callerProfile.role !== 'super_admin') {
      return json(403, { ok: false, error: 'only a super admin can grant super_admin' });
    }

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (createErr || !created.user) {
      return json(400, { ok: false, error: createErr?.message ?? 'auth user creation failed' });
    }

    const { error: profileErr } = await admin.from('profiles').insert({
      id: created.user.id,
      company_id: callerProfile.company_id,
      branch_id: input?.branch_id ?? null,
      employee_code: employeeCode,
      full_name: fullName,
      role,
      department_id: input?.department_id ?? null,
      position_id: input?.position_id ?? null,
      employment_status: input?.employment_status ?? 'active',
      phone: input?.phone ?? null,
    });

    if (profileErr) {
      // No orphaned logins: roll the auth user back if the profile failed.
      await admin.auth.admin.deleteUser(created.user.id);
      return json(400, { ok: false, error: profileErr.message });
    }

    await admin.from('audit_logs').insert({
      company_id: callerProfile.company_id,
      actor_id: caller.id,
      action: 'employee_created',
      table_name: 'profiles',
      record_id: created.user.id,
      details: { email, employee_code: employeeCode, role },
    });

    return json(200, { ok: true, user_id: created.user.id });
  }

  if (body.action === 'reset_password') {
    const userId = String(body.user_id ?? '');
    const newPassword = String(body.new_password ?? '');
    if (newPassword.length < 8) return json(400, { ok: false, error: 'password must be at least 8 characters' });

    // Target must exist in the caller's company.
    const { data: target } = await admin
      .from('profiles')
      .select('id, role')
      .eq('id', userId)
      .eq('company_id', callerProfile.company_id)
      .maybeSingle();
    if (!target) return json(404, { ok: false, error: 'employee not found in your company' });
    if (target.role === 'super_admin' && callerProfile.role !== 'super_admin') {
      return json(403, { ok: false, error: 'only a super admin can reset a super admin password' });
    }

    const { error: resetErr } = await admin.auth.admin.updateUserById(userId, {
      password: newPassword,
    });
    if (resetErr) return json(400, { ok: false, error: resetErr.message });

    await admin.from('audit_logs').insert({
      company_id: callerProfile.company_id,
      actor_id: caller.id,
      action: 'password_reset',
      table_name: 'profiles',
      record_id: userId,
    });

    return json(200, { ok: true, user_id: userId });
  }

  return json(400, { ok: false, error: 'unknown action' });
});
