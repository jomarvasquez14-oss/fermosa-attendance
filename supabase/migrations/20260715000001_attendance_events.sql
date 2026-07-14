-- M2: Time Clock — raw punch events + idempotent ingest.
-- Attendance is its own module: nothing here touches profiles beyond FKs.
-- attendance_events is APPEND-ONLY: no updates/deletes; corrections happen on
-- daily attendance_records (M4), never by rewriting history.

create type public.punch_type as enum ('clock_in', 'break_start', 'break_end', 'clock_out');
create type public.punch_source as enum ('mobile', 'web', 'kiosk');

create table public.attendance_events (
  id uuid primary key default uuid_generate_v4(),
  client_uuid uuid not null unique, -- generated on-device; idempotency key for offline sync
  company_id uuid not null references public.companies (id),
  employee_id uuid not null references public.profiles (id),
  branch_id uuid references public.branches (id),
  type public.punch_type not null,
  source public.punch_source not null default 'mobile',
  happened_at timestamptz not null,          -- device time = the official punch time
  received_at timestamptz not null default now(), -- server time; big gaps flagged in M4
  lat double precision,
  lng double precision,
  gps_accuracy_m real,
  inside_geofence boolean,          -- server-computed; null when no GPS or no branch coords
  distance_from_branch_m real,
  selfie_path text,                 -- filled by M3 verification layer
  device_info jsonb
);

create index attendance_events_emp_time_idx
  on public.attendance_events (company_id, employee_id, happened_at desc);
create index attendance_events_branch_time_idx
  on public.attendance_events (branch_id, happened_at desc);

alter table public.attendance_events enable row level security;

-- Reads: own punches; branch managers their branch; admins the company.
create policy attendance_events_select_own on public.attendance_events
  for select to authenticated
  using (employee_id = auth.uid());

create policy attendance_events_select_branch on public.attendance_events
  for select to authenticated
  using (
    app.user_role() = 'branch_manager'
    and branch_id = app.user_branch_id()
    and company_id = app.user_company_id()
  );

create policy attendance_events_select_company on public.attendance_events
  for select to authenticated
  using (company_id = app.user_company_id() and app.is_company_admin());

-- No insert/update/delete policies on purpose: all writes go through
-- ingest_punch below (SECURITY DEFINER), and history is immutable.

-- ---------------------------------------------------------------------------
-- Idempotent punch ingest. The client supplies only punch facts; identity
-- comes from auth.uid() and the geofence verdict is recomputed here — the
-- client is never trusted for either.
-- ---------------------------------------------------------------------------

create or replace function public.ingest_punch(
  p_client_uuid uuid,
  p_type public.punch_type,
  p_happened_at timestamptz,
  p_branch_id uuid default null,
  p_lat double precision default null,
  p_lng double precision default null,
  p_gps_accuracy_m real default null,
  p_source public.punch_source default 'mobile',
  p_device_info jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_branch public.branches%rowtype;
  v_distance_m real;
  v_inside boolean;
  v_id uuid;
  v_existing uuid;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if v_profile.id is null then
    raise exception 'no employee profile for this account';
  end if;

  -- Punch against the given branch, defaulting to the employee's own branch.
  select * into v_branch
    from public.branches
   where id = coalesce(p_branch_id, v_profile.branch_id)
     and company_id = v_profile.company_id;

  -- Server-side geofence: haversine distance to the branch center.
  if v_branch.id is not null and p_lat is not null and p_lng is not null then
    v_distance_m := (
      2 * 6371000 * asin(sqrt(
        power(sin(radians(p_lat - v_branch.lat) / 2), 2)
        + cos(radians(v_branch.lat)) * cos(radians(p_lat))
          * power(sin(radians(p_lng - v_branch.lng) / 2), 2)
      ))
    )::real;
    v_inside := v_distance_m <= v_branch.geofence_radius_m;
  end if;

  insert into public.attendance_events (
    client_uuid, company_id, employee_id, branch_id, type, source,
    happened_at, lat, lng, gps_accuracy_m,
    inside_geofence, distance_from_branch_m, device_info
  ) values (
    p_client_uuid, v_profile.company_id, v_profile.id, v_branch.id, p_type, p_source,
    p_happened_at, p_lat, p_lng, p_gps_accuracy_m,
    v_inside, v_distance_m, p_device_info
  )
  on conflict (client_uuid) do nothing
  returning id into v_id;

  if v_id is null then
    -- Retry of an already-synced punch: report success, change nothing.
    select id into v_existing from public.attendance_events where client_uuid = p_client_uuid;
    return jsonb_build_object('id', v_existing, 'duplicate', true);
  end if;

  return jsonb_build_object(
    'id', v_id,
    'duplicate', false,
    'inside_geofence', v_inside,
    'distance_m', v_distance_m
  );
end;
$$;

revoke all on function public.ingest_punch(uuid, public.punch_type, timestamptz, uuid, double precision, double precision, real, public.punch_source, jsonb) from public;
grant execute on function public.ingest_punch(uuid, public.punch_type, timestamptz, uuid, double precision, double precision, real, public.punch_source, jsonb) to authenticated;
