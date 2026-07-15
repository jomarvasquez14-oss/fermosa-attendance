-- M6: Leave Management (Phase 6).
-- User decisions (2026-07-15): single-step HR+ approval (branch managers
-- view-only, matching attendance); tracked balances (annual entitlement per
-- employee/type, used & remaining computed from approved requests so they
-- never drift; rest days and holidays inside a range don't count); half-day
-- support (0.5); minimal seeded types (Vacation/Sick paid + Unpaid).
-- An approved leave day is reclassified `on_leave` by the engine, not `absent`.

create type public.leave_status as enum ('pending', 'approved', 'rejected', 'cancelled');

-- ---------------------------------------------------------------------------
-- Leave types (HR maintains via the dashboard).
-- ---------------------------------------------------------------------------

create table public.leave_types (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null,
  is_paid boolean not null default true,
  default_days_per_year numeric(4,1) not null default 0 check (default_days_per_year >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, name)
);

alter table public.leave_types enable row level security;

create policy leave_types_select on public.leave_types
  for select to authenticated
  using (company_id = app.user_company_id());

create policy leave_types_write on public.leave_types
  for all to authenticated
  using (company_id = app.user_company_id() and app.is_company_admin())
  with check (company_id = app.user_company_id() and app.is_company_admin());

insert into public.leave_types (company_id, name, is_paid, default_days_per_year) values
  ('c0000000-0000-0000-0000-000000000001', 'Vacation', true, 5),
  ('c0000000-0000-0000-0000-000000000001', 'Sick', true, 5),
  ('c0000000-0000-0000-0000-000000000001', 'Unpaid', false, 0)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Balances: entitlement only. Used/remaining are computed (see the view).
-- ---------------------------------------------------------------------------

create table public.leave_balances (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references public.companies (id) on delete cascade,
  employee_id uuid not null references public.profiles (id) on delete cascade,
  leave_type_id uuid not null references public.leave_types (id) on delete cascade,
  year int not null,
  entitled_days numeric(5,1) not null default 0 check (entitled_days >= 0),
  unique (employee_id, leave_type_id, year)
);

create index leave_balances_employee_idx on public.leave_balances (employee_id, year);

alter table public.leave_balances enable row level security;

create policy leave_balances_select on public.leave_balances
  for select to authenticated
  using (
    employee_id = auth.uid()
    or (app.user_role() = 'branch_manager'
        and employee_id in (select id from public.profiles
                             where branch_id = app.user_branch_id() and company_id = app.user_company_id()))
    or (app.is_company_admin() and company_id = app.user_company_id())
  );

create policy leave_balances_write on public.leave_balances
  for all to authenticated
  using (app.is_company_admin() and company_id = app.user_company_id())
  with check (app.is_company_admin() and company_id = app.user_company_id());

-- ---------------------------------------------------------------------------
-- Requests.
-- ---------------------------------------------------------------------------

create table public.leave_requests (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references public.companies (id) on delete cascade,
  employee_id uuid not null references public.profiles (id) on delete cascade,
  leave_type_id uuid not null references public.leave_types (id),
  start_date date not null,
  end_date date not null,
  half_day boolean not null default false,
  day_count numeric(4,1) not null default 0,
  reason text,
  status public.leave_status not null default 'pending',
  reviewed_by uuid references auth.users (id),
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index leave_requests_employee_idx on public.leave_requests (employee_id, start_date);
create index leave_requests_company_status_idx on public.leave_requests (company_id, status);

create trigger leave_requests_set_updated_at
  before update on public.leave_requests
  for each row execute function public.tg_set_updated_at();

alter table public.leave_requests enable row level security;

create policy leave_requests_select on public.leave_requests
  for select to authenticated
  using (
    employee_id = auth.uid()
    or (app.user_role() = 'branch_manager'
        and employee_id in (select id from public.profiles
                             where branch_id = app.user_branch_id() and company_id = app.user_company_id()))
    or (app.is_company_admin() and company_id = app.user_company_id())
  );

-- Filing: employee for self, or an admin for any employee in their company.
-- New requests are always `pending`; approval happens through review_leave.
-- (No company_id in the check — a BEFORE trigger sets it, and RLS WITH CHECK
--  must not depend on trigger-assigned values.)
create policy leave_requests_insert on public.leave_requests
  for insert to authenticated
  with check (
    status = 'pending'
    and (
      employee_id = auth.uid()
      or (app.is_company_admin()
          and employee_id in (select id from public.profiles where company_id = app.user_company_id()))
    )
  );

-- Employees may cancel their own still-pending request; nothing else.
create policy leave_requests_cancel on public.leave_requests
  for update to authenticated
  using (employee_id = auth.uid() and status = 'pending')
  with check (employee_id = auth.uid() and status = 'cancelled');

-- ---------------------------------------------------------------------------
-- Working-day count for a leave range (skips rest days and holidays).
-- ---------------------------------------------------------------------------

create or replace function app.leave_day_count(
  p_employee_id uuid,
  p_start date,
  p_end date,
  p_half boolean
) returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_branch uuid;
  v_company uuid;
  v_work_days int[];
  v_count numeric := 0;
  d date;
begin
  if p_half then
    return 0.5;
  end if;
  select branch_id, company_id into v_branch, v_company
    from public.profiles where id = p_employee_id;
  select work_days into v_work_days from public.branches where id = v_branch;
  if v_work_days is null then
    v_work_days := '{1,2,3,4,5,6}';
  end if;
  d := p_start;
  while d <= p_end loop
    if (extract(isodow from d)::int = any (v_work_days))
       and not exists (
         select 1 from public.holidays h
          where h.company_id = v_company and h.holiday_date = d
       )
    then
      v_count := v_count + 1;
    end if;
    d := d + 1;
  end loop;
  return v_count;
end;
$$;

-- Fill company_id + day_count and validate the range before write.
create or replace function app.tg_leave_prepare()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
begin
  select company_id into v_company from public.profiles where id = new.employee_id;
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
  new.day_count := app.leave_day_count(new.employee_id, new.start_date, new.end_date, new.half_day);
  return new;
end;
$$;

create trigger leave_requests_prepare
  before insert or update on public.leave_requests
  for each row execute function app.tg_leave_prepare();

-- ---------------------------------------------------------------------------
-- Computed balances view. security_invoker so RLS applies as the caller
-- (Supabase runs PostgreSQL 15+).
-- ---------------------------------------------------------------------------

create view public.leave_balances_view with (security_invoker = true) as
  select b.id,
         b.company_id,
         b.employee_id,
         b.leave_type_id,
         b.year,
         b.entitled_days,
         coalesce(u.used, 0) as used_days,
         b.entitled_days - coalesce(u.used, 0) as remaining_days
    from public.leave_balances b
    left join lateral (
      select sum(r.day_count) as used
        from public.leave_requests r
       where r.employee_id = b.employee_id
         and r.leave_type_id = b.leave_type_id
         and r.status = 'approved'
         and extract(year from r.start_date)::int = b.year
    ) u on true;

grant select on public.leave_balances_view to authenticated;

-- ---------------------------------------------------------------------------
-- Approve / reject (admin only). Reflects onto existing attendance records.
-- ---------------------------------------------------------------------------

create or replace function public.review_leave(
  p_request_id uuid,
  p_status public.leave_status,
  p_note text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req public.leave_requests%rowtype;
  v_rec uuid;
begin
  if not app.is_company_admin() then
    raise exception 'only HR, operations manager, or super admin can review leave';
  end if;
  if p_status not in ('approved', 'rejected') then
    raise exception 'review must set approved or rejected';
  end if;
  if p_status = 'rejected' and coalesce(trim(p_note), '') = '' then
    raise exception 'a note is required to reject';
  end if;

  update public.leave_requests
     set status = p_status, review_note = p_note, reviewed_by = auth.uid(), reviewed_at = now()
   where id = p_request_id and company_id = app.user_company_id()
   returning * into v_req;
  if v_req.id is null then
    raise exception 'leave request not found in your company';
  end if;

  insert into public.audit_logs (company_id, actor_id, action, table_name, record_id, details)
  values (
    v_req.company_id, auth.uid(), 'leave_reviewed', 'leave_requests', v_req.id::text,
    jsonb_build_object('status', p_status, 'note', p_note, 'employee_id', v_req.employee_id,
                       'leave_type_id', v_req.leave_type_id, 'start_date', v_req.start_date,
                       'end_date', v_req.end_date, 'day_count', v_req.day_count)
  );

  -- Flip any already-created attendance records in range (absent <-> on_leave).
  for v_rec in
    select id from public.attendance_records
     where employee_id = v_req.employee_id
       and work_date between v_req.start_date and v_req.end_date
  loop
    perform app.compute_attendance_record(v_rec);
  end loop;
end;
$$;

revoke all on function public.review_leave(uuid, public.leave_status, text) from public;
grant execute on function public.review_leave(uuid, public.leave_status, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Grant entitlements to everyone active from each type's default (admin only).
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
     and p.employment_status in ('active', 'probationary')
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
-- Engine: an approved leave day is `on_leave`, not `absent`.
-- ---------------------------------------------------------------------------

alter table public.attendance_records
  add column leave_request_id uuid references public.leave_requests (id);

-- Re-declares the M5 compute function with a leave lookup. Only the no-punch
-- branch and the trailing update change; all M4/M5 math is identical.
create or replace function app.compute_attendance_record(p_record_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.attendance_records%rowtype;
  b public.branches%rowtype;
  s public.attendance_settings%rowtype;
  v_tz text;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_first_in timestamptz;
  v_last_out timestamptz;
  v_break_min int := 0;
  v_span_min int;
  v_worked int;
  v_late int := 0;
  v_under int := 0;
  v_ot int := 0;
  v_flags text[] := '{}';
  v_class public.day_class := 'regular';
  v_kind public.holiday_kind;
  v_shift_start timestamptz;
  v_shift_end timestamptz;
  v_cutoff time := '00:00';
  v_deduct int;
  ev record;
  v_open_break timestamptz;
  v_has_punches boolean := false;
  v_leave_id uuid;
begin
  select * into r from public.attendance_records where id = p_record_id;
  if r.id is null then return; end if;

  select * into b from public.branches where id = r.branch_id;
  select * into s from public.attendance_settings where company_id = r.company_id;
  if s.company_id is null then
    s.late_grace_min := 15; s.ot_threshold_min := 30; s.min_break_min := 60;
  end if;

  v_tz := coalesce(b.timezone, 'Asia/Manila');
  if b.id is not null then
    v_cutoff := app.work_day_cutoff(b.shift_start, b.shift_end);
  end if;
  v_day_start := (r.work_date + v_cutoff) at time zone v_tz;
  v_day_end := v_day_start + interval '1 day';

  -- Day classification: holiday > rest day > regular (keyed to the day the
  -- shift STARTS, also for overnight shifts).
  select kind into v_kind from public.holidays
   where company_id = r.company_id and holiday_date = r.work_date;
  if v_kind = 'regular' then
    v_class := 'regular_holiday';
  elsif v_kind = 'special' then
    v_class := 'special_holiday';
  elsif b.id is not null and not (extract(isodow from r.work_date)::int = any (b.work_days)) then
    v_class := 'rest_day';
  end if;

  -- Approved leave covering this work day (if any).
  select id into v_leave_id from public.leave_requests
   where employee_id = r.employee_id
     and status = 'approved'
     and r.work_date between start_date and end_date
   order by created_at
   limit 1;

  -- Walk the work day's punches in order.
  for ev in
    select type, happened_at from public.attendance_events
     where employee_id = r.employee_id
       and happened_at >= v_day_start and happened_at < v_day_end
     order by happened_at
  loop
    v_has_punches := true;
    if ev.type = 'clock_in' and v_first_in is null then
      v_first_in := ev.happened_at;
    elsif ev.type = 'clock_out' then
      v_last_out := ev.happened_at;
    elsif ev.type = 'break_start' then
      v_open_break := ev.happened_at;
    elsif ev.type = 'break_end' and v_open_break is not null then
      v_break_min := v_break_min + greatest(0, extract(epoch from ev.happened_at - v_open_break) / 60)::int;
      v_open_break := null;
    end if;
  end loop;

  if not v_has_punches then
    -- No punches: on approved leave -> on_leave; otherwise absent.
    update public.attendance_records
       set first_in = null, last_out = null, worked_minutes = 0, break_minutes = 0,
           late_minutes = 0, undertime_minutes = 0, overtime_minutes = 0,
           day_class = v_class,
           flags = case when v_leave_id is not null then array['on_leave'] else array['absent'] end,
           leave_request_id = v_leave_id,
           computed_at = now()
     where id = p_record_id;
    return;
  end if;

  if b.id is not null then
    v_shift_start := (r.work_date::timestamp + b.shift_start) at time zone v_tz;
    v_shift_end := (r.work_date::timestamp + b.shift_end) at time zone v_tz
                   + case when b.shift_end <= b.shift_start then interval '1 day' else interval '0' end;
  end if;

  if v_first_in is not null and v_last_out is not null and v_last_out > v_first_in then
    v_span_min := (extract(epoch from v_last_out - v_first_in) / 60)::int;
    v_deduct := case when v_span_min > 5 * 60 then greatest(v_break_min, s.min_break_min) else v_break_min end;
    v_worked := greatest(0, v_span_min - v_deduct);
    v_break_min := v_deduct;
  else
    v_worked := null;
  end if;

  if v_shift_start is not null and v_first_in is not null then
    v_late := greatest(0, (extract(epoch from v_first_in - v_shift_start) / 60)::int);
    if v_late <= s.late_grace_min then v_late := 0; end if;
  end if;

  if v_shift_end is not null and v_last_out is not null then
    v_under := greatest(0, (extract(epoch from v_shift_end - v_last_out) / 60)::int);
    v_ot := greatest(0, (extract(epoch from v_last_out - v_shift_end) / 60)::int);
    if v_ot <= s.ot_threshold_min then v_ot := 0; end if;
  end if;

  if v_first_in is not null and v_last_out is null then
    v_flags := array_append(v_flags, 'no_clock_out');
  end if;
  if v_late > 0 then
    v_flags := array_append(v_flags, 'late');
  elsif v_first_in is not null then
    v_flags := array_append(v_flags, 'on_time');
  end if;
  if v_under > 0 and v_last_out is not null then v_flags := array_append(v_flags, 'early_out'); end if;
  if v_ot > 0 then v_flags := array_append(v_flags, 'overtime'); end if;
  -- Worked a day that also carries approved (half-day) leave.
  if v_leave_id is not null then v_flags := array_append(v_flags, 'on_leave'); end if;

  update public.attendance_records
     set first_in = v_first_in,
         last_out = v_last_out,
         worked_minutes = v_worked,
         break_minutes = v_break_min,
         late_minutes = v_late,
         undertime_minutes = v_under,
         overtime_minutes = v_ot,
         day_class = v_class,
         flags = v_flags,
         leave_request_id = v_leave_id,
         computed_at = now()
   where id = p_record_id;
end;
$$;
