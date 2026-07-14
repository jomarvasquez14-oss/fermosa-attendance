-- M1: kiosk PIN management.
-- PINs are set by company admins from the dashboard and stored bcrypt-hashed.
-- Verification (kiosk clock-in) arrives in M3.

-- Lives in `public` (not `app`) so PostgREST exposes it to supabase.rpc().
create or replace function public.set_employee_pin(p_employee_id uuid, p_pin text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not app.is_company_admin() then
    raise exception 'only company admins can set PINs';
  end if;

  if p_pin !~ '^[0-9]{4,6}$' then
    raise exception 'PIN must be 4-6 digits';
  end if;

  update public.profiles
     set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf'))
   where id = p_employee_id
     and company_id = app.user_company_id();

  if not found then
    raise exception 'employee not found in your company';
  end if;

  insert into public.audit_logs (company_id, actor_id, action, table_name, record_id)
  values (app.user_company_id(), auth.uid(), 'pin_set', 'profiles', p_employee_id::text);
end;
$$;

revoke all on function public.set_employee_pin(uuid, text) from public;
grant execute on function public.set_employee_pin(uuid, text) to authenticated;
