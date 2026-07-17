-- Hire date + birthday, "Regular Employee" leave rework (user decisions, 2026-07-17):
--   * Store date_hired + birthday per employee (both optional).
--   * Employment status "Active" is displayed as "Regular Employee" (label only —
--     the enum value stays 'active'; relabel lives in the dashboard).
--   * Leave is now ONE 5-day pool: rename the existing "Vacation" type to "Leave"
--     (keeps its id/5-day entitlement/balances), DEACTIVATE the separate "Sick"
--     type, keep "Unpaid".
--   * New "Birthday Leave" type: paid, 1 day/year, usable only within the
--     employee's birth month (flagged birthday_only; enforced in tg_leave_prepare).
--   * Entitlements are granted to REGULAR (active) employees only.
-- Birthday Leave is is_paid=true, so report_payroll_summary counts it as a
-- paid-leave day automatically — no payroll-summary change.

-- ---------------------------------------------------------------------------
-- 1. Profile columns.
-- ---------------------------------------------------------------------------

alter table public.profiles add column if not exists date_hired date;
alter table public.profiles add column if not exists birthday date;

-- ---------------------------------------------------------------------------
-- 2. Leave-type flag + data (idempotent; scoped by name).
-- ---------------------------------------------------------------------------

alter table public.leave_types add column if not exists birthday_only boolean not null default false;

-- Consolidate to a single active paid "Leave" pool. Idempotent + safe on any
-- environment: on a fresh seed (Vacation/Sick/Unpaid, no "Leave") this renames
-- Vacation → "Leave" so its balances carry over; where a "Leave" type already
-- exists (production, hand-created), the redundant "Vacation" is deactivated
-- instead (its existing requests are preserved — deactivating never touches them).
do $$
begin
  update public.leave_types v set name = 'Leave'
   where v.name = 'Vacation'
     and not exists (
       select 1 from public.leave_types l
        where l.company_id = v.company_id and l.name = 'Leave'
     );
  update public.leave_types set is_active = false where name = 'Vacation';
  -- Fold Sick into the single pool: deactivate (kept for history, hidden from chips/grants).
  update public.leave_types set is_active = false where name = 'Sick';
end $$;

-- New birthday perk: paid, 1 day/year, birth-month only.
insert into public.leave_types (company_id, name, is_paid, default_days_per_year, is_active, birthday_only)
select id, 'Birthday Leave', true, 1, true, true from public.companies
on conflict (company_id, name) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Grant entitlements to REGULAR (active) employees only.
--    (Copy of the M6 body with the one gate line changed.)
-- ---------------------------------------------------------------------------

create or replace function public.grant_leave_entitlements(p_year int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_count int := 0;
begin
  if not app.is_company_admin() then
    raise exception 'only company admins can grant entitlements';
  end if;
  v_company := app.user_company_id();

  insert into public.leave_balances (company_id, employee_id, leave_type_id, year, entitled_days)
  select v_company, p.id, lt.id, p_year, lt.default_days_per_year
    from public.profiles p
    cross join public.leave_types lt
   where p.company_id = v_company
     and p.employment_status = 'active'
     and lt.company_id = v_company
     and lt.is_active
  on conflict (employee_id, leave_type_id, year) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.grant_leave_entitlements(int) from public;
grant execute on function public.grant_leave_entitlements(int) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Validate birthday leave in tg_leave_prepare (birth-month, single day,
--    birth date on file). Copy of the M6 body with the birthday block added.
-- ---------------------------------------------------------------------------

create or replace function app.tg_leave_prepare()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_birthday date;
  v_birthday_only boolean;
begin
  select company_id, birthday into v_company, v_birthday
    from public.profiles where id = new.employee_id;
  if v_company is null then
    raise exception 'employee not found';
  end if;
  new.company_id := v_company;
  if new.end_date < new.start_date then
    raise exception 'end date must be on or after start date';
  end if;
  if new.half_day and new.start_date <> new.end_date then
    raise exception 'half-day leave must be a single day';
  end if;

  select birthday_only into v_birthday_only
    from public.leave_types where id = new.leave_type_id;
  if coalesce(v_birthday_only, false) then
    if v_birthday is null then
      raise exception 'birthday leave requires your birth date on file — ask HR to add it';
    end if;
    if new.start_date <> new.end_date then
      raise exception 'birthday leave is a single day';
    end if;
    if extract(month from new.start_date) <> extract(month from v_birthday) then
      raise exception 'birthday leave can only be taken during your birth month';
    end if;
  end if;

  new.day_count := app.leave_day_count(new.employee_id, new.start_date, new.end_date, new.half_day);
  return new;
end;
$$;
