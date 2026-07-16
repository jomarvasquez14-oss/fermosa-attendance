-- Pilot feedback round 2 (2026-07-16):
--   * Late minutes no longer include the grace period: grace 15 and arriving
--     16 min after shift start counts 1 late minute (was 16). Half-day keeps
--     meaning "arrived >= half_day_late_min after shift start", which with the
--     new math is counted-late >= (half_day_late_min - late_grace_min).
--   * Time-based corrections: HR fixes the actual Time in / Time out (e.g. a
--     forgotten morning time-in) instead of raw minutes. review_attendance
--     accepts first_in/last_out ISO timestamps in the corrections jsonb (the
--     dashboard computes the minute overrides from them with the shared
--     dayMath helper, which mirrors the engine rules).
--   * attendance_effective surfaces the corrected times, so Reviews and every
--     report show the fixed 9:06 AM, not the wrong raw punch.

-- ---------------------------------------------------------------------------
-- Engine: late = minutes beyond the grace period. Everything else identical
-- to the half-day migration (20260726000001).
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
  v_leave_id uuid;
  v_time_gap boolean := false;
begin
  select * into r from public.attendance_records where id = p_record_id;
  if r.id is null then return; end if;

  select * into b from public.branches where id = r.branch_id;
  select * into s from public.attendance_settings where company_id = r.company_id;
  if s.company_id is null then
    s.late_grace_min := 15; s.ot_threshold_min := 30; s.min_break_min := 60;
    s.half_day_late_min := 60;
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
    select type, happened_at, received_at from public.attendance_events
     where employee_id = r.employee_id
       and happened_at >= v_day_start and happened_at < v_day_end
     order by happened_at
  loop
    v_has_punches := true;
    -- Device clock vs server clock: a clock in/out that arrived >10 min away
    -- from its stated time is an offline sync or a changed device clock.
    if ev.type in ('clock_in', 'clock_out')
       and abs(extract(epoch from ev.received_at - ev.happened_at)) > 600 then
      v_time_gap := true;
    end if;
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

  -- Late = minutes beyond the grace period (grace 15, in at +16 -> late 1).
  if v_shift_start is not null and v_first_in is not null then
    v_late := greatest(0, (extract(epoch from v_first_in - v_shift_start) / 60)::int - s.late_grace_min);
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
  -- Arrived >= half_day_late_min after shift start (in grace-deducted terms):
  -- the day only counts as half a day in payroll.
  if s.half_day_late_min > 0
     and v_late >= greatest(s.half_day_late_min - s.late_grace_min, 1) then
    v_flags := array_append(v_flags, 'half_day');
  end if;
  if v_under > 0 and v_last_out is not null then v_flags := array_append(v_flags, 'early_out'); end if;
  if v_ot > 0 then v_flags := array_append(v_flags, 'overtime'); end if;
  -- Worked a day that also carries approved (half-day) leave.
  if v_leave_id is not null then v_flags := array_append(v_flags, 'on_leave'); end if;
  if v_time_gap then v_flags := array_append(v_flags, 'time_mismatch'); end if;

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

-- ---------------------------------------------------------------------------
-- Effective view: corrected times override the raw punches, exactly like the
-- corrected minutes. Same columns/positions, so create-or-replace is safe.
-- ---------------------------------------------------------------------------
create or replace view public.attendance_effective
with (security_invoker = true) as
select
  ar.id,
  ar.company_id,
  ar.employee_id,
  ar.branch_id,
  ar.work_date,
  ar.status,
  ar.day_class,
  ar.flags,
  coalesce((ar.corrections->>'first_in')::timestamptz, ar.first_in) as first_in,
  coalesce((ar.corrections->>'last_out')::timestamptz, ar.last_out) as last_out,
  ar.leave_request_id,
  coalesce((ar.corrections->>'worked_minutes')::int,    ar.worked_minutes,    0) as worked_minutes,
  coalesce((ar.corrections->>'break_minutes')::int,     ar.break_minutes,     0) as break_minutes,
  coalesce((ar.corrections->>'late_minutes')::int,      ar.late_minutes,      0) as late_minutes,
  coalesce((ar.corrections->>'undertime_minutes')::int, ar.undertime_minutes, 0) as undertime_minutes,
  coalesce((ar.corrections->>'overtime_minutes')::int,  ar.overtime_minutes,  0) as overtime_minutes
from public.attendance_records ar;

grant select on public.attendance_effective to authenticated;

-- ---------------------------------------------------------------------------
-- Payroll summary: half-day condition follows the new late math
-- (counted late >= half_day_late_min - late_grace_min).
-- ---------------------------------------------------------------------------
create or replace function public.report_payroll_summary(
  p_from date,
  p_to date,
  p_branch_id uuid default null
)
returns table (
  employee_id       uuid,
  employee_code     text,
  full_name         text,
  branch_id         uuid,
  branch_name       text,
  scheduled_days    int,
  days_present      double precision,
  days_absent       int,
  worked_minutes    int,
  late_minutes      int,
  undertime_minutes int,
  overtime_minutes  int,
  paid_leave_days   double precision,
  unpaid_leave_days double precision,
  rest_days_worked  int,
  holidays_worked   int
)
language sql
stable
set search_path = public
as $$
  select
    p.id            as employee_id,
    p.employee_code,
    p.full_name,
    b.id            as branch_id,
    b.name          as branch_name,
    count(*)::int   as scheduled_days,
    coalesce(sum(case
      when eff.first_in is null then 0
      when coalesce(st.half_day_late_min, 60) > 0
           and eff.late_minutes >= greatest(coalesce(st.half_day_late_min, 60) - coalesce(st.late_grace_min, 15), 1)
        then 0.5
      else 1
    end), 0)::double precision                                    as days_present,
    count(*) filter (where 'absent' = any (eff.flags))::int       as days_absent,
    coalesce(sum(eff.worked_minutes), 0)::int                     as worked_minutes,
    coalesce(sum(eff.late_minutes), 0)::int                       as late_minutes,
    coalesce(sum(eff.undertime_minutes), 0)::int                  as undertime_minutes,
    coalesce(sum(eff.overtime_minutes), 0)::int                   as overtime_minutes,
    coalesce(sum(case when 'on_leave' = any (eff.flags) and lt.is_paid
                      then case when lr.half_day then 0.5 else 1 end else 0 end), 0)::double precision as paid_leave_days,
    coalesce(sum(case when 'on_leave' = any (eff.flags) and not lt.is_paid
                      then case when lr.half_day then 0.5 else 1 end else 0 end), 0)::double precision as unpaid_leave_days,
    count(*) filter (where eff.day_class = 'rest_day' and eff.first_in is not null)::int as rest_days_worked,
    count(*) filter (where eff.day_class in ('regular_holiday', 'special_holiday')
                       and eff.first_in is not null)::int         as holidays_worked
  from public.attendance_effective eff
  join public.profiles p on p.id = eff.employee_id
  join public.branches b on b.id = eff.branch_id
  left join public.attendance_settings st on st.company_id = eff.company_id
  left join public.leave_requests lr on lr.id = eff.leave_request_id
  left join public.leave_types   lt on lt.id = lr.leave_type_id
  where eff.work_date between p_from and p_to
    and eff.status in ('approved', 'corrected')
    and (p_branch_id is null or eff.branch_id = p_branch_id)
  group by p.id, p.employee_code, p.full_name, b.id, b.name
  order by b.name, p.full_name;
$$;

revoke all on function public.report_payroll_summary(date, date, uuid) from public;
grant execute on function public.report_payroll_summary(date, date, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- review_attendance: corrections may now carry the fixed times as ISO strings
-- (first_in / last_out) alongside the numeric minute overrides.
-- ---------------------------------------------------------------------------
create or replace function public.review_attendance(
  p_record_id uuid,
  p_status public.attendance_status,
  p_note text default null,
  p_corrections jsonb default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_record public.attendance_records%rowtype;
  v_minute_keys text[] := array['worked_minutes', 'late_minutes', 'undertime_minutes', 'overtime_minutes', 'break_minutes'];
  v_time_keys text[] := array['first_in', 'last_out'];
  k text;
begin
  if not app.is_company_admin() then
    raise exception 'only HR, operations manager, or super admin can review attendance';
  end if;
  if p_status = 'pending_review' then
    raise exception 'cannot set a record back to pending review';
  end if;
  if p_status in ('rejected', 'corrected') and coalesce(trim(p_note), '') = '' then
    raise exception 'a note is required when rejecting or correcting';
  end if;
  if p_corrections is not null then
    for k in select jsonb_object_keys(p_corrections) loop
      if k = any (v_minute_keys) then
        if jsonb_typeof(p_corrections->k) <> 'number' then
          raise exception 'correction % must be a number of minutes', k;
        end if;
      elsif k = any (v_time_keys) then
        if jsonb_typeof(p_corrections->k) <> 'string' then
          raise exception 'correction % must be a timestamp string', k;
        end if;
        begin
          perform (p_corrections->>k)::timestamptz;
        exception when others then
          raise exception 'correction % is not a valid timestamp', k;
        end;
      else
        raise exception 'invalid correction field: %', k;
      end if;
    end loop;
  end if;

  update public.attendance_records
     set status = p_status,
         review_note = p_note,
         corrections = case when p_status = 'corrected' then p_corrections else corrections end,
         reviewed_by = auth.uid(),
         reviewed_at = now()
   where id = p_record_id
     and company_id = app.user_company_id()
   returning * into v_record;

  if v_record.id is null then
    raise exception 'attendance record not found in your company';
  end if;

  insert into public.audit_logs (company_id, actor_id, action, table_name, record_id, details)
  values (
    v_record.company_id, auth.uid(), 'attendance_reviewed', 'attendance_records',
    v_record.id::text,
    jsonb_build_object('status', p_status, 'note', p_note, 'corrections', p_corrections,
                       'work_date', v_record.work_date, 'employee_id', v_record.employee_id)
  );
end;
$$;
