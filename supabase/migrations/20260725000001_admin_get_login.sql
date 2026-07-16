-- Admin lookup of an employee's login (their auth email) for the dashboard.
-- Staff forget their username; HR/admins need to see it on the employee page.
-- SECURITY DEFINER reads auth.users; gated so a company admin can only look up
-- someone in their own company.

create or replace function public.admin_get_login(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  if not app.is_company_admin() then
    raise exception 'not authorized';
  end if;
  if not exists (
    select 1
      from public.profiles target
      join public.profiles caller on caller.id = auth.uid()
     where target.id = p_user_id
       and target.company_id = caller.company_id
  ) then
    raise exception 'employee not found in your company';
  end if;
  select email into v_email from auth.users where id = p_user_id;
  return v_email;
end;
$$;

revoke all on function public.admin_get_login(uuid) from public;
grant execute on function public.admin_get_login(uuid) to authenticated;
