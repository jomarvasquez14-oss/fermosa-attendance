-- Late charges (user decisions, 2026-07-17):
--   * The salary basis is the DAILY rate — the compensation column shipped
--     hours earlier as monthly_rate is renamed to daily_rate (values entered
--     in between, if any, must be re-entered as daily amounts).
--   * Late charge per minute = daily_rate / 8 hrs (fixed) / 60 min = rate/480
--     (₱600/day → ₱1.25/min).
--   * Charged minutes = late + undertime, on ALL days including half-days
--     (the half-day rule still halves days_present separately — owner's call).
--   * Surfaced on the payroll report + Sheets sync only (HR/admin eyes; RLS
--     nulls the rate — and therefore the charge — for branch managers).

alter table public.employee_compensation rename column monthly_rate to daily_rate;

-- Audit trigger: log the renamed field.
create or replace function app.tg_audit_compensation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT'
     or new.daily_rate is distinct from old.daily_rate
     or new.daily_allowance is distinct from old.daily_allowance then
    insert into public.audit_logs (company_id, actor_id, action, table_name, record_id, details)
    values (
      new.company_id,
      auth.uid(),
      'compensation_set',
      'employee_compensation',
      new.employee_id::text,
      jsonb_build_object(
        'old', case when tg_op = 'UPDATE'
          then jsonb_build_object('daily_rate', old.daily_rate, 'daily_allowance', old.daily_allowance)
          else null end,
        'new', jsonb_build_object('daily_rate', new.daily_rate, 'daily_allowance', new.daily_allowance)
      )
    );
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Payroll summary: monthly_rate → daily_rate, plus computed late_charge =
-- (Σ late + Σ undertime) × daily_rate / 480. Return type changes, so drop +
-- recreate; body copied verbatim from 20260729000001_compensation.sql with
-- the rename and the appended column.
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
  late_charge       numeric
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
                       and eff.first_in is not null)::int         as holidays_worked,
    count(*) filter (where eff.first_in is not null
                       and not (coalesce(st.half_day_late_min, 60) > 0
                                and eff.late_minutes >= greatest(coalesce(st.half_day_late_min, 60) - coalesce(st.late_grace_min, 15), 1)))::int as full_days,
    ec.daily_rate,
    ec.daily_allowance,
    round((coalesce(sum(eff.late_minutes), 0) + coalesce(sum(eff.undertime_minutes), 0))
          * ec.daily_rate / 480.0, 2)                             as late_charge
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
