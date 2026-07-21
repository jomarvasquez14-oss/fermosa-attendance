-- Dedicated kiosk login (2026-07-21).
--
-- A shared branch tablet should not run on an HR/supervisor's personal account
-- (a full-access session left on a device staff can touch). This adds a
-- low-privilege `kiosk` role: an account that can ONLY register + run a kiosk,
-- locked to one branch. RLS is default-deny, so a kiosk account sees nothing
-- but its own profile and the branch list — no employees, attendance, or payroll.
--
-- Enum gotcha: a newly added enum value can't be used as an enum literal in the
-- same transaction it's added. Everything below compares the role AS TEXT
-- (role::text = 'kiosk'), never 'kiosk'::user_role, so a single migration is
-- safe. (If db push ever reports "unsafe use of new value", split the ALTER TYPE
-- into its own migration ordered before this one.)

alter type public.user_role add value if not exists 'kiosk';

-- ---------------------------------------------------------------------------
-- Who may register a kiosk device: company admins OR a kiosk-role login.
-- ---------------------------------------------------------------------------

create or replace function app.can_manage_kiosk()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select app.is_company_admin() or coalesce(
    (select role::text = 'kiosk' from public.profiles where id = auth.uid()),
    false
  );
$$;

-- ---------------------------------------------------------------------------
-- register_kiosk_device — full copy from 20260716000001_verification.sql with
-- two surgical changes: gate on can_manage_kiosk(), and lock a kiosk-role
-- caller to its own branch (the client-supplied branch is ignored for them).
-- ---------------------------------------------------------------------------

create or replace function public.register_kiosk_device(p_branch_id uuid, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text;
  v_id uuid;
  v_branch_id uuid;
  v_is_kiosk boolean;
begin
  if not app.can_manage_kiosk() then
    raise exception 'only company admins or a kiosk login can register kiosk devices';
  end if;

  -- A kiosk-role login is locked to its assigned branch; admins pass the branch.
  select role::text = 'kiosk' into v_is_kiosk from public.profiles where id = auth.uid();
  if v_is_kiosk then
    select branch_id into v_branch_id from public.profiles where id = auth.uid();
    if v_branch_id is null then
      raise exception 'this kiosk login has no branch assigned — ask an admin to set its branch';
    end if;
  else
    v_branch_id := p_branch_id;
  end if;

  if not exists (select 1 from public.branches where id = v_branch_id and company_id = app.user_company_id()) then
    raise exception 'branch not found in your company';
  end if;

  v_key := encode(extensions.gen_random_bytes(24), 'hex');

  insert into public.attendance_devices (company_id, branch_id, name, device_key_hash, registered_by)
  values (app.user_company_id(), v_branch_id, p_name,
          extensions.crypt(v_key, extensions.gen_salt('bf')), auth.uid())
  returning id into v_id;

  insert into public.audit_logs (company_id, actor_id, action, table_name, record_id, details)
  values (app.user_company_id(), auth.uid(), 'kiosk_registered', 'attendance_devices',
          v_id::text, jsonb_build_object('branch_id', v_branch_id, 'name', p_name));

  -- The only time the plaintext key ever leaves the database.
  return jsonb_build_object('device_id', v_id, 'device_key', v_key);
end;
$$;

revoke all on function public.register_kiosk_device(uuid, text) from public;
grant execute on function public.register_kiosk_device(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- dashboard_live — full copy from 20260728000001_roving_branch.sql with one
-- surgical addition: exclude kiosk-role logins (p.role::text <> 'kiosk') from
-- both the reg and rov CTEs, so a kiosk account never appears as a phantom
-- "not in yet" row on the live ops board.
-- ---------------------------------------------------------------------------

create or replace function public.dashboard_live()
returns table (
  employee_id uuid,
  full_name text,
  employee_code text,
  branch_id uuid,
  branch_name text,
  status text,          -- working | on_break | clocked_out | not_in
  scheduled boolean,    -- branch works this weekday and it isn't a holiday
  on_leave boolean,     -- approved leave covers the current work day
  overdue boolean,      -- scheduled, no punch, not on leave, past shift start + grace
  late_minutes int,
  first_in timestamptz,
  last_punch_at timestamptz,
  work_date date
)
language sql
stable
set search_path = public
as $$
  with reg as (
    select p.id as employee_id, p.full_name, p.employee_code,
           p.branch_id, b.name as branch_name, p.company_id,
           b.timezone, b.shift_start, b.work_days,
           app.punch_work_date(p.branch_id, now()) as wd,
           coalesce(s.late_grace_min, 15) as grace,
           (app.punch_work_date(p.branch_id, now())
             + app.work_day_cutoff(b.shift_start, b.shift_end)) at time zone b.timezone as day_start,
           true as has_home_branch
      from public.profiles p
      join public.branches b on b.id = p.branch_id and b.is_active
      left join public.attendance_settings s on s.company_id = p.company_id
     where p.employment_status in ('active', 'probationary')
       and p.role::text <> 'kiosk'
  ),
  rov as (
    -- Roving employees (profiles.branch_id is null): today's branch is the
    -- branch of their latest punch in the last 20 hours. No punch yet ->
    -- null branch, not_in, never overdue (nowhere they are expected to be).
    select p.id as employee_id, p.full_name, p.employee_code,
           b.id as branch_id, b.name as branch_name, p.company_id,
           b.timezone, b.shift_start, b.work_days,
           app.punch_work_date(b.id, now()) as wd,  -- null branch -> Manila calendar today
           coalesce(s.late_grace_min, 15) as grace,
           case when b.id is not null then
             (app.punch_work_date(b.id, now())
               + app.work_day_cutoff(b.shift_start, b.shift_end)) at time zone b.timezone
           end as day_start,
           false as has_home_branch
      from public.profiles p
      left join lateral (
        select ev.branch_id
          from public.attendance_events ev
         where ev.employee_id = p.id
           and ev.branch_id is not null
           and ev.happened_at >= now() - interval '20 hours'
         order by ev.happened_at desc
         limit 1
      ) le on true
      left join public.branches b on b.id = le.branch_id
      left join public.attendance_settings s on s.company_id = p.company_id
     where p.branch_id is null
       and p.employment_status in ('active', 'probationary')
       and p.role::text <> 'kiosk'
  ),
  base as (
    select * from reg
    union all
    select * from rov
  )
  select
    l.employee_id,
    l.full_name,
    l.employee_code,
    l.branch_id,
    l.branch_name,
    case lp.last_type
      when 'clock_in' then 'working'
      when 'break_end' then 'working'
      when 'break_start' then 'on_break'
      when 'clock_out' then 'clocked_out'
      else 'not_in'
    end as status,
    coalesce(sched.scheduled, false) as scheduled,
    lv.on_leave,
    (
      l.has_home_branch
      and lp.last_type is null
      and coalesce(sched.scheduled, false)
      and not lv.on_leave
      and now() > ((l.wd::timestamp + l.shift_start) at time zone l.timezone + make_interval(mins => l.grace))
    ) as overdue,
    coalesce(ar.late_minutes, 0) as late_minutes,
    ar.first_in,
    lp.last_at as last_punch_at,
    l.wd as work_date
  from base l
  cross join lateral (
    select (extract(isodow from l.wd)::int = any (l.work_days)
            and not exists (
              select 1 from public.holidays h
               where h.company_id = l.company_id and h.holiday_date = l.wd
            )) as scheduled
  ) sched
  cross join lateral (
    select exists (
      select 1 from public.leave_requests lr
       where lr.employee_id = l.employee_id and lr.status = 'approved'
         and l.wd between lr.start_date and lr.end_date
    ) as on_leave
  ) lv
  left join lateral (
    select ev.type as last_type, ev.happened_at as last_at
      from public.attendance_events ev
     where ev.employee_id = l.employee_id
       and ev.happened_at >= l.day_start
       and ev.happened_at < l.day_start + interval '1 day'
     order by ev.happened_at desc
     limit 1
  ) lp on true
  left join public.attendance_records ar
    on ar.employee_id = l.employee_id and ar.work_date = l.wd;
$$;

revoke all on function public.dashboard_live() from public;
grant execute on function public.dashboard_live() to authenticated;
