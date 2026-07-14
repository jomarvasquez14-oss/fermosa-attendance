-- M3: Verification layer — daily attendance records with approval workflow,
-- kiosk device registry, selfie storage, and internal ingest for the kiosk
-- Edge Function. Only APPROVED attendance ever becomes official/payroll data.

-- ---------------------------------------------------------------------------
-- Daily attendance records (skeleton — the M4 engine adds computed hours).
-- One row per employee per Manila work day, auto-created from punches.
-- ---------------------------------------------------------------------------

create type public.attendance_status as enum ('pending_review', 'approved', 'rejected', 'corrected');

create table public.attendance_records (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references public.companies (id),
  employee_id uuid not null references public.profiles (id),
  branch_id uuid references public.branches (id),
  work_date date not null,
  status public.attendance_status not null default 'pending_review',
  review_note text,
  reviewed_by uuid references public.profiles (id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (employee_id, work_date)
);

create index attendance_records_company_date_idx
  on public.attendance_records (company_id, work_date desc);
create index attendance_records_status_idx
  on public.attendance_records (company_id, status) where status = 'pending_review';

create trigger attendance_records_updated_at
  before update on public.attendance_records
  for each row execute function public.tg_set_updated_at();

-- Every punch guarantees the day's record exists (pending review).
create or replace function app.tg_upsert_attendance_record()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tz text;
  v_date date;
begin
  select coalesce(b.timezone, 'Asia/Manila') into v_tz
    from public.branches b where b.id = new.branch_id;
  v_date := (new.happened_at at time zone coalesce(v_tz, 'Asia/Manila'))::date;

  insert into public.attendance_records (company_id, employee_id, branch_id, work_date)
  values (new.company_id, new.employee_id, new.branch_id, v_date)
  on conflict (employee_id, work_date) do nothing;
  return new;
end;
$$;

create trigger attendance_events_upsert_record
  after insert on public.attendance_events
  for each row execute function app.tg_upsert_attendance_record();

alter table public.attendance_records enable row level security;

create policy attendance_records_select_own on public.attendance_records
  for select to authenticated
  using (employee_id = auth.uid());

create policy attendance_records_select_branch on public.attendance_records
  for select to authenticated
  using (
    app.user_role() = 'branch_manager'
    and branch_id = app.user_branch_id()
    and company_id = app.user_company_id()
  );

create policy attendance_records_select_company on public.attendance_records
  for select to authenticated
  using (company_id = app.user_company_id() and app.is_company_admin());

-- No direct writes: reviews go through review_attendance below.

-- Approval is restricted to HR / operations manager / super admin
-- (branch managers are view-only by product decision).
create or replace function public.review_attendance(
  p_record_id uuid,
  p_status public.attendance_status,
  p_note text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_record public.attendance_records%rowtype;
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

  update public.attendance_records
     set status = p_status,
         review_note = p_note,
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
    jsonb_build_object('status', p_status, 'note', p_note, 'employee_id', v_record.employee_id, 'work_date', v_record.work_date)
  );
end;
$$;

revoke all on function public.review_attendance(uuid, public.attendance_status, text) from public;
grant execute on function public.review_attendance(uuid, public.attendance_status, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Kiosk device registry. A tablet is registered once by an admin standing at
-- it; the plaintext device key is shown/stored only on that device.
-- ---------------------------------------------------------------------------

create table public.attendance_devices (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references public.companies (id),
  branch_id uuid not null references public.branches (id),
  name text not null,
  device_key_hash text not null,
  is_active boolean not null default true,
  registered_by uuid references public.profiles (id),
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.attendance_devices enable row level security;

create policy attendance_devices_select on public.attendance_devices
  for select to authenticated
  using (company_id = app.user_company_id() and app.is_company_admin());

create policy attendance_devices_update on public.attendance_devices
  for update to authenticated
  using (company_id = app.user_company_id() and app.is_company_admin())
  with check (company_id = app.user_company_id() and app.is_company_admin());

create or replace function public.register_kiosk_device(p_branch_id uuid, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text;
  v_id uuid;
begin
  if not app.is_company_admin() then
    raise exception 'only company admins can register kiosk devices';
  end if;
  if not exists (select 1 from public.branches where id = p_branch_id and company_id = app.user_company_id()) then
    raise exception 'branch not found in your company';
  end if;

  v_key := encode(extensions.gen_random_bytes(24), 'hex');

  insert into public.attendance_devices (company_id, branch_id, name, device_key_hash, registered_by)
  values (app.user_company_id(), p_branch_id, p_name,
          extensions.crypt(v_key, extensions.gen_salt('bf')), auth.uid())
  returning id into v_id;

  insert into public.audit_logs (company_id, actor_id, action, table_name, record_id, details)
  values (app.user_company_id(), auth.uid(), 'kiosk_registered', 'attendance_devices',
          v_id::text, jsonb_build_object('branch_id', p_branch_id, 'name', p_name));

  -- The only time the plaintext key ever leaves the database.
  return jsonb_build_object('device_id', v_id, 'device_key', v_key);
end;
$$;

revoke all on function public.register_kiosk_device(uuid, text) from public;
grant execute on function public.register_kiosk_device(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Internal ingest for trusted server callers (kiosk Edge Function).
-- Same logic as ingest_punch but the employee is passed explicitly.
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
  p_selfie_path text default null
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
    inside_geofence, distance_from_branch_m, device_info, selfie_path
  ) values (
    p_client_uuid, v_profile.company_id, v_profile.id, v_branch.id, p_type, p_source,
    p_happened_at, p_lat, p_lng, p_gps_accuracy_m,
    v_inside, v_distance_m, p_device_info, p_selfie_path
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

-- Only trusted server-side callers (Edge Functions using service_role).
revoke all on function public.ingest_punch_as(uuid, uuid, public.punch_type, timestamptz, uuid, double precision, double precision, real, public.punch_source, jsonb, text) from public;
grant execute on function public.ingest_punch_as(uuid, uuid, public.punch_type, timestamptz, uuid, double precision, double precision, real, public.punch_source, jsonb, text) to service_role;

-- Personal-mode ingest becomes a thin wrapper (adds selfie support).
drop function public.ingest_punch(uuid, public.punch_type, timestamptz, uuid, double precision, double precision, real, public.punch_source, jsonb);

create or replace function public.ingest_punch(
  p_client_uuid uuid,
  p_type public.punch_type,
  p_happened_at timestamptz,
  p_branch_id uuid default null,
  p_lat double precision default null,
  p_lng double precision default null,
  p_gps_accuracy_m real default null,
  p_source public.punch_source default 'mobile',
  p_device_info jsonb default null,
  p_selfie_path text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  return public.ingest_punch_as(
    auth.uid(), p_client_uuid, p_type, p_happened_at, p_branch_id,
    p_lat, p_lng, p_gps_accuracy_m, p_source, p_device_info, p_selfie_path
  );
end;
$$;

revoke all on function public.ingest_punch(uuid, public.punch_type, timestamptz, uuid, double precision, double precision, real, public.punch_source, jsonb, text) from public;
grant execute on function public.ingest_punch(uuid, public.punch_type, timestamptz, uuid, double precision, double precision, real, public.punch_source, jsonb, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Selfie storage: private bucket, path {company_id}/{employee_id}/{file}.
-- Employees write/read their own folder; company admins read company-wide
-- (the dashboard serves reviewers short-lived signed URLs).
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('selfies', 'selfies', false)
on conflict (id) do nothing;

create policy selfies_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'selfies'
    and (storage.foldername(name))[1] = (app.user_company_id())::text
    and (storage.foldername(name))[2] = auth.uid()::text
  );

create policy selfies_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'selfies'
    and (
      (storage.foldername(name))[2] = auth.uid()::text
      or (
        app.is_company_admin()
        and (storage.foldername(name))[1] = (app.user_company_id())::text
      )
    )
  );
