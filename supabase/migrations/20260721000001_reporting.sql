-- M8: Reporting (Phase 8).
-- Read-only reporting layer over the attendance engine. Two objects:
--   * attendance_effective — a SECURITY INVOKER view that surfaces the
--     *effective* (HR-corrected) minutes for each daily record, so every report
--     agrees on the numbers that actually reach payroll. RLS on
--     attendance_records applies as the caller (branch managers see their
--     branch, HR/ops the whole company).
--   * report_payroll_summary(from, to, branch) — a SECURITY INVOKER aggregation
--     returning one row per employee for a pay period. This is the single
--     dataset the dashboard exports (M8) and the Google Sheets sync pushes (M9).
-- No schema changes to existing tables.

-- ---------------------------------------------------------------------------
-- Effective daily record: corrections override computed minutes.
-- corrections is a jsonb of {worked_minutes,late_minutes,undertime_minutes,
-- overtime_minutes,break_minutes} written only on `corrected` records
-- (see review_attendance). coalesce falls back to the computed value.
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
  ar.first_in,
  ar.last_out,
  ar.leave_request_id,
  coalesce((ar.corrections->>'worked_minutes')::int,    ar.worked_minutes,    0) as worked_minutes,
  coalesce((ar.corrections->>'break_minutes')::int,     ar.break_minutes,     0) as break_minutes,
  coalesce((ar.corrections->>'late_minutes')::int,      ar.late_minutes,      0) as late_minutes,
  coalesce((ar.corrections->>'undertime_minutes')::int, ar.undertime_minutes, 0) as undertime_minutes,
  coalesce((ar.corrections->>'overtime_minutes')::int,  ar.overtime_minutes,  0) as overtime_minutes
from public.attendance_records ar;

grant select on public.attendance_effective to authenticated;

-- ---------------------------------------------------------------------------
-- Per-employee payroll summary for a period. Payable = approved + corrected.
-- Aggregates the effective view; leave-day counts come from the record's linked
-- leave request/type (½ for a half-day). Because the view is security-invoker
-- and this function is security-invoker (default for sql functions), RLS scopes
-- the result to the caller's company automatically.
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
  scheduled_days    int,   -- days that have a daily record in the period
  days_present      int,   -- worked at least partially (has first_in)
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
    count(*) filter (where eff.first_in is not null)::int         as days_present,
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
