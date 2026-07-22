-- No-punch days: HR classifies Absent vs Day off (2026-07-22).
--
-- When an employee doesn't punch on a scheduled work day, the nightly sweep
-- creates a pending_review record flagged 'absent'. But many of these are
-- legitimate day-offs (Fermosa has day-offs, just not on a fixed schedule —
-- staff swap ad-hoc), so HR needs to classify a no-punch day as either an
-- Absence or a Day off instead of Approve/Void.
--
-- A day counts as absent ONLY if its flags[] contains 'absent'
-- (report_payroll_summary.days_absent), and days_present is 0 with no time-in.
-- So "Day off" = finalize the record with the 'absent' flag replaced by a
-- neutral 'day_off' flag → 0 present, 0 absent, 0 pay (Fermosa is daily-rate /
-- no-work-no-pay, so a day off is simply not a present day). flags is text[],
-- so no enum change. The payroll summary gains a 'day_off' count column.

-- ---------------------------------------------------------------------------
-- Classify a no-punch day. Symmetric + reversible: HR can flip a day between
-- 'absent' and 'day_off'. Only no-punch days (first_in is null) — a day with
-- punches must use Void/Correct so a worked day can never be silently zeroed.
-- ---------------------------------------------------------------------------
create or replace function public.classify_attendance_day(
  p_record_id uuid,
  p_outcome   text,
  p_note      text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.attendance_records%rowtype;
begin
  if not app.is_company_admin() then
    raise exception 'only HR, operations manager, or super admin can classify a day';
  end if;
  if p_outcome not in ('absent', 'day_off') then
    raise exception 'invalid outcome: % (expected absent or day_off)', p_outcome;
  end if;

  select * into r from public.attendance_records
   where id = p_record_id and company_id = app.user_company_id();
  if r.id is null then
    raise exception 'attendance day not found in your company';
  end if;
  if r.first_in is not null
     or (r.corrections is not null and r.corrections ? 'first_in') then
    raise exception 'this day has punches — use Void or Correct instead';
  end if;

  update public.attendance_records
     set status            = 'approved',
         flags             = array[p_outcome],
         worked_minutes    = 0,
         break_minutes     = 0,
         late_minutes      = 0,
         undertime_minutes = 0,
         overtime_minutes  = 0,
         corrections       = null,
         reviewed_by       = auth.uid(),
         reviewed_at       = now(),
         review_note       = p_note,
         computed_at       = now()
   where id = p_record_id;

  insert into public.audit_logs (company_id, actor_id, action, table_name, record_id, details)
  values (
    r.company_id, auth.uid(), 'attendance_reviewed', 'attendance_records',
    p_record_id::text,
    jsonb_build_object('outcome', p_outcome, 'note', p_note)
  );
end;
$$;

revoke all on function public.classify_attendance_day(uuid, text, text) from public;
grant execute on function public.classify_attendance_day(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Rebuild report_payroll_summary to add a 'day_off' count column. Body copied
-- verbatim from 20260731000001_overtime_pay.sql with days_off added next to
-- days_absent. Return type changes → drop + recreate. my_payslip() selects
-- named columns from this function (not *), so appending a column is safe.
-- ---------------------------------------------------------------------------
drop function public.report_payroll_summary(date, date, uuid);

create function public.report_payroll_summary(
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
  days_off          int,
  worked_minutes    int,
  late_minutes      int,
  undertime_minutes int,
  overtime_minutes  int,
  paid_leave_days   double precision,
  unpaid_leave_days double precision,
  rest_days_worked  int,
  holidays_worked   int,
  full_days         int,
  daily_rate        numeric,
  daily_allowance   numeric,
  late_charge       numeric,
  ot_paid_hours     int,
  ot_pay            numeric
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
    count(*) filter (where 'day_off' = any (eff.flags))::int      as days_off,
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
                       and eff.first_in is not null)::int         as holidays_worked,
    count(*) filter (where eff.first_in is not null
                       and not (coalesce(st.half_day_late_min, 60) > 0
                                and eff.late_minutes >= greatest(coalesce(st.half_day_late_min, 60) - coalesce(st.late_grace_min, 15), 1)))::int as full_days,
    ec.daily_rate,
    ec.daily_allowance,
    round((coalesce(sum(eff.late_minutes), 0) + coalesce(sum(eff.undertime_minutes), 0))
          * ec.daily_rate / 480.0, 2)                             as late_charge,
    coalesce(sum(floor(eff.overtime_minutes / 60.0)), 0)::int     as ot_paid_hours,
    round(coalesce(sum(floor(eff.overtime_minutes / 60.0)), 0) * ec.daily_rate * 1.25 / 8.0, 2) as ot_pay
  from public.attendance_effective eff
  join public.profiles p on p.id = eff.employee_id
  join public.branches b on b.id = eff.branch_id
  left join public.attendance_settings st on st.company_id = eff.company_id
  left join public.leave_requests lr on lr.id = eff.leave_request_id
  left join public.leave_types   lt on lt.id = lr.leave_type_id
  left join public.employee_compensation ec on ec.employee_id = p.id
  where eff.work_date between p_from and p_to
    and eff.status in ('approved', 'corrected')
    and (p_branch_id is null or eff.branch_id = p_branch_id)
  group by p.id, p.employee_code, p.full_name, b.id, b.name, ec.daily_rate, ec.daily_allowance
  order by b.name, p.full_name;
$$;

revoke all on function public.report_payroll_summary(date, date, uuid) from public;
grant execute on function public.report_payroll_summary(date, date, uuid) to authenticated;
