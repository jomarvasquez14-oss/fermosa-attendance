-- Constant-space bcrypt comparison for trusted server callers (kiosk Edge
-- Function verifies device keys and PINs). Never exposed to end users.

create or replace function public.bcrypt_matches(p_value text, p_hash text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select extensions.crypt(p_value, p_hash) = p_hash;
$$;

revoke all on function public.bcrypt_matches(text, text) from public;
grant execute on function public.bcrypt_matches(text, text) to service_role;
