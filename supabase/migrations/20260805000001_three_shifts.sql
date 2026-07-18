-- Three shifts per branch (pilot follow-up 2026-07-18). Some branches run THREE
-- shifts — opening, mid, and closing (e.g. 08:00-17:00, 12:00-21:00,
-- 14:00-23:00). This widens the two-shift model (20260804000001_two_shifts.sql)
-- with an optional Shift 3; the employee PICKS which shift they are timing in
-- for and late/undertime/OT are measured against it.
--
-- Mechanical extension: the engine (app.compute_attendance_record) and the
-- record-pin trigger (app.tg_upsert_attendance_record) are already
-- shift-agnostic — they use coalesce(record.shift, branch.shift) on the shift
-- the punch carried, so NEITHER changes here. Only the branch columns and the
-- ingest_punch shift-validation whitelist need to grow. Backward compatible:
-- shift3 null = branch has no 3rd shift, no change in behavior.
--
-- Day attribution (app.punch_work_date) still uses the branch Shift-1 cutoff —
-- same day-shift MVP scope as two-shift; overnight 3rd shift stays deferred.

-- ---------------------------------------------------------------------------
-- Columns — Shift 3 on the branch (nullable = branch has no 3rd shift).
-- No new columns on attendance_events/records: the punch/record already store
-- the CHOSEN shift_start/shift_end, whichever slot it came from.
-- ---------------------------------------------------------------------------
alter table public.branches
  add column if not exists shift3_start time,
  add column if not exists shift3_end time;

-- ---------------------------------------------------------------------------
-- ingest_punch_as — full copy from 20260804000001_two_shifts.sql with the
-- shift-validation whitelist extended to accept Shift 3. The 12-arg signature
-- is unchanged, so this is a plain create-or-replace (no drop/recreate, and
-- ingest_punch — the auth.uid() wrapper — is left untouched).
-- ---------------------------------------------------------------------------
create or replace function public.ingest_punch_as(
  p_employee_id uuid,
  p_client_uuid uuid,
  p_type public.punch_type,
  p_happened_at timestamptz,
  p_branch_id uuid default null,
  p_lat double precision default null,
  p_lng double precision default null,
  p_gps_accuracy_m real default null,
  p_source public.punch_source default 'mobile',
  p_device_info jsonb default null,
  p_selfie_path text default null,
  p_shift_start time default null,
  p_shift_end time default null
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
  select * into v_profile from public.profiles where id = p_employee_id;
  if v_profile.id is null then
    raise exception 'no employee profile for id %', p_employee_id;
  end if;

  select * into v_branch
    from public.branches
   where id = coalesce(p_branch_id, v_profile.branch_id)
     and company_id = v_profile.company_id;

  if v_branch.id is null then
    if p_branch_id is not null then
      raise exception 'branch not found: % is not a branch of this company', p_branch_id;
    end if;
    raise exception 'no branch for this punch: your account has no home branch — select the branch you are working at and punch again';
  end if;

  -- A chosen shift must be one the branch actually defines (Shift 1, 2, or 3).
  if p_shift_start is not null then
    if not (
      (p_shift_start = v_branch.shift_start and p_shift_end = v_branch.shift_end)
      or (v_branch.shift2_start is not null
          and p_shift_start = v_branch.shift2_start and p_shift_end = v_branch.shift2_end)
      or (v_branch.shift3_start is not null
          and p_shift_start = v_branch.shift3_start and p_shift_end = v_branch.shift3_end)
    ) then
      raise exception 'invalid shift for this branch';
    end if;
  end if;

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
    inside_geofence, distance_from_branch_m, device_info, selfie_path,
    shift_start, shift_end
  ) values (
    p_client_uuid, v_profile.company_id, v_profile.id, v_branch.id, p_type, p_source,
    p_happened_at, p_lat, p_lng, p_gps_accuracy_m,
    v_inside, v_distance_m, p_device_info, p_selfie_path,
    p_shift_start, p_shift_end
  )
  on conflict (client_uuid) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_existing from public.attendance_events where client_uuid = p_client_uuid;
    return jsonb_build_object('id', v_existing, 'duplicate', true);
  end if;

  return jsonb_build_object(
    'id', v_id, 'duplicate', false,
    'inside_geofence', v_inside, 'distance_m', v_distance_m
  );
end;
$$;

revoke all on function public.ingest_punch_as(uuid, uuid, public.punch_type, timestamptz, uuid, double precision, double precision, real, public.punch_source, jsonb, text, time, time) from public;
grant execute on function public.ingest_punch_as(uuid, uuid, public.punch_type, timestamptz, uuid, double precision, double precision, real, public.punch_source, jsonb, text, time, time) to service_role;
