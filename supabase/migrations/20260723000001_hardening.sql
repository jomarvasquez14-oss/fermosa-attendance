-- M10: Hardening (Phase 10).
-- Surfaces the existing audit trail and lets users record their own 2FA
-- (enroll/disable) events into it. Two objects, no schema changes to existing
-- tables:
--   * audit_log_view — a SECURITY INVOKER view over audit_logs joined to the
--     actor's profile (name/role), so the dashboard can show "who did what"
--     without a second round trip. RLS on audit_logs applies as the caller
--     (company admins only), so the view is automatically company-scoped.
--   * log_audit(action, details) — a narrow SECURITY DEFINER RPC that lets a
--     signed-in user append a *whitelisted* security event (2FA enroll/disable)
--     to the audit trail. audit_logs has no direct-insert policy by design;
--     this RPC is the only user-facing writer and it can only emit the
--     whitelisted actions, so it can't be used to forge arbitrary log lines.

-- ---------------------------------------------------------------------------
-- Audit log view: audit_logs + actor name/role.
-- security_invoker so audit_logs' admin-only RLS scopes the result. The join to
-- profiles resolves the actor's name (admins can read their company's profiles);
-- a null/absent actor (system action) simply yields null actor_name.
-- ---------------------------------------------------------------------------
create or replace view public.audit_log_view
with (security_invoker = true) as
select
  al.id,
  al.company_id,
  al.actor_id,
  ap.full_name as actor_name,
  ap.role      as actor_role,
  al.action,
  al.table_name,
  al.record_id,
  al.details,
  al.created_at
from public.audit_logs al
left join public.profiles ap on ap.id = al.actor_id;

grant select on public.audit_log_view to authenticated;

-- ---------------------------------------------------------------------------
-- log_audit: append a whitelisted security event as the current user.
-- Used by the dashboard when an admin enrolls or disables their 2FA factor.
-- ---------------------------------------------------------------------------
create or replace function public.log_audit(p_action text, p_details jsonb default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
begin
  if p_action not in ('mfa_enrolled', 'mfa_disabled') then
    raise exception 'log_audit: action % is not allowed', p_action;
  end if;

  v_company := app.user_company_id();
  if v_company is null then
    raise exception 'log_audit: no company for caller';
  end if;

  insert into public.audit_logs (company_id, actor_id, action, table_name, record_id, details)
  values (v_company, auth.uid(), p_action, 'auth', auth.uid()::text, p_details);
end;
$$;

revoke all on function public.log_audit(text, jsonb) from public;
grant execute on function public.log_audit(text, jsonb) to authenticated;
