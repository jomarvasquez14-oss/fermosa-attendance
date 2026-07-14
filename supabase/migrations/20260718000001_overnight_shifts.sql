-- M5: Overnight shift support (user decision 2026-07-14: schedules stay
-- branch-level and HR-set; the new capability is shifts that cross midnight,
-- e.g. 22:00-06:00). A punch now belongs to the work day whose duty window
-- contains it, not the calendar day it lands on.
--
-- Work-day cutoff rule (uniform for day and overnight shifts):
--   cutoff = shift_end + (24h - shift_length) / 2   (midpoint of the off-duty gap)
--   punch belongs to work date D when its branch-local time is in [D+cutoff, D+1+cutoff)
-- Examples: 10:00-19:00 -> cutoff 02:30 (a 1 AM clock-out attaches to yesterday);
--           22:00-06:00 -> cutoff 14:00 (the whole night shift maps to its start day).

-- ---------------------------------------------------------------------------
-- Cutoff + work-date helpers.
-- ---------------------------------------------------------------------------

create or replace function app.work_day_cutoff(p_shift_start time, p_shift_end time)
returns time
language sql
immutable
as $$
  select '00:00'::time + (
    (
      extract(epoch from p_shift_end)::int / 60
      + (
          1440 - case when p_shift_end > p_shift_start
                      then extract(epoch from p_shift_end - p_shift_start)::int / 60
                      else 1440 - extract(epoch from p_shift_start - p_shift_end)::int / 60
                 end
        ) / 2
    ) * interval '1 minute'
  );
$$;

create or replace function app.punch_work_date(p_branch_id uuid, p_happened_at timestamptz)
returns date
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  b public.branches%rowtype;
  v_local timestamp;
  v_cutoff time;
begin
  if p_branch_id is not null then
    select * into b from public.branches where id = p_branch_id;
  end if;
  v_local := p_happened_at at time zone coalesce(b.timezone, 'Asia/Manila');
  if b.id is null then
    return v_local::date;
  end if;
  v_cutoff := app.work_day_cutoff(b.shift_start, b.shift_end);
  return case when v_local::time >= v_cutoff then v_local::date else v_local::date - 1 end;
end;
$$;

-- ---------------------------------------------------------------------------
-- Punch trigger: attribute the punch to its shift's work day.
-- ---------------------------------------------------------------------------

create or replace function app.tg_upsert_attendance_record()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_date date;
  v_record_id uuid;
begin
  v_date := app.punch_work_date(new.branch_id, new.happened_at);

  insert into public.attendance_records (company_id, employee_id, branch_id, work_date)
  values (new.company_id, new.employee_id, new.branch_id, v_date)
  on conflict (employee_id, work_date) do nothing;

  select id into v_record_id from public.attendance_records
   where employee_id = new.employee_id and work_date = v_date;
  if v_record_id is not null then
    perform app.compute_attendance_record(v_record_id);
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Engine: punch window follows the cutoff; overnight shift_end rolls to D+1.
-- Only the window and shift-boundary lines change from M4 — break pairing,
-- grace, OT threshold, flags, and corrections handling are untouched.
-- ---------------------------------------------------------------------------

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
begin
  select * into r from public.attendance_records where id = p_record_id;
  if r.id is null then return; end if;

  select * into b from public.branches where id = r.branch_id;
  select * into s from public.attendance_settings where company_id = r.company_id;
  if s.company_id is null then
    -- engine defaults when a company has no settings row
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
      v_last_out := ev.happened_at; -- last one wins
    elsif ev.type = 'break_start' then
      v_open_break := ev.happened_at;
    elsif ev.type = 'break_end' and v_open_break is not null then
      v_break_min := v_break_min + greatest(0, extract(epoch from ev.happened_at - v_open_break) / 60)::int;
      v_open_break := null;
    end if;
  end loop;

  if not v_has_punches then
    -- Absent day (created by the sweep): zeroed numbers, absent flag.
    update public.attendance_records
       set first_in = null, last_out = null, worked_minutes = 0, break_minutes = 0,
           late_minutes = 0, undertime_minutes = 0, overtime_minutes = 0,
           day_class = v_class, flags = array['absent'], computed_at = now()
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
    -- Break rule: on days spanning > 5 h, deduct at least the minimum break.
    v_deduct := case when v_span_min > 5 * 60 then greatest(v_break_min, s.min_break_min) else v_break_min end;
    v_worked := greatest(0, v_span_min - v_deduct);
    v_break_min := v_deduct;
  else
    v_worked := null; -- incomplete day: HR corrects or the flag stands
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

  -- Flags: system verdicts, independent of approval status.
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
         computed_at = now()
   where id = p_record_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Bulk recompute for a branch after HR edits its schedule. Pending days only:
-- approved/corrected numbers are payroll-frozen and never touched.
-- ---------------------------------------------------------------------------

create or replace function public.recompute_branch_attendance(
  p_branch_id uuid,
  p_from date,
  p_to date
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int := 0;
  rec record;
begin
  if not app.is_company_admin() then
    raise exception 'only HR, operations manager, or super admin can recompute attendance';
  end if;
  if not exists (
    select 1 from public.branches
     where id = p_branch_id and company_id = app.user_company_id()
  ) then
    raise exception 'branch not found in your company';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then
    raise exception 'date range must run oldest to newest and span at most 62 days';
  end if;

  for rec in
    select id from public.attendance_records
     where branch_id = p_branch_id
       and work_date between p_from and p_to
       and status = 'pending_review'
  loop
    perform app.compute_attendance_record(rec.id);
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.recompute_branch_attendance(uuid, date, date) from public;
grant execute on function public.recompute_branch_attendance(uuid, date, date) to authenticated;
