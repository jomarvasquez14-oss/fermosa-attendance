-- M0/M1 — Employee Identity: companies, branches, departments, positions,
-- profiles, RBAC helper functions, RLS baseline, audit log.

create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type public.user_role as enum (
  'employee',
  'branch_manager',
  'hr',
  'operations_manager',
  'super_admin'
);

create type public.employment_status as enum (
  'active',
  'probationary',
  'on_leave',
  'resigned',
  'terminated'
);

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.companies (
  id uuid primary key default uuid_generate_v4(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table public.branches (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null,
  address text,
  lat double precision not null,
  lng double precision not null,
  geofence_radius_m integer not null default 100 check (geofence_radius_m between 10 and 5000),
  timezone text not null default 'Asia/Manila',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, name)
);

create table public.departments (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null,
  unique (company_id, name)
);

create table public.positions (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null,
  unique (company_id, name)
);

-- One row per auth user. Role here is the single source of truth for RBAC.
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  company_id uuid not null references public.companies (id),
  branch_id uuid references public.branches (id),
  employee_code text not null,
  full_name text not null,
  role public.user_role not null default 'employee',
  department_id uuid references public.departments (id),
  position_id uuid references public.positions (id),
  employment_status public.employment_status not null default 'active',
  phone text,
  photo_path text,
  -- bcrypt hash of the kiosk PIN; never the PIN itself
  pin_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, employee_code)
);

create index profiles_branch_idx on public.profiles (branch_id);
create index profiles_company_role_idx on public.profiles (company_id, role);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies (id),
  actor_id uuid references auth.users (id),
  action text not null,
  table_name text not null,
  record_id text,
  details jsonb,
  created_at timestamptz not null default now()
);

create index audit_logs_company_created_idx on public.audit_logs (company_id, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

create or replace function public.tg_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- RBAC helper functions
-- security definer so they can read profiles without tripping RLS recursion.
-- ---------------------------------------------------------------------------

create schema if not exists app;
grant usage on schema app to authenticated, anon;

create or replace function app.current_profile()
returns public.profiles
language sql
security definer
set search_path = public
stable
as $$
  select * from public.profiles where id = auth.uid();
$$;

create or replace function app.user_company_id()
returns uuid
language sql
security definer
set search_path = public
stable
as $$
  select company_id from public.profiles where id = auth.uid();
$$;

create or replace function app.user_branch_id()
returns uuid
language sql
security definer
set search_path = public
stable
as $$
  select branch_id from public.profiles where id = auth.uid();
$$;

create or replace function app.user_role()
returns public.user_role
language sql
security definer
set search_path = public
stable
as $$
  select role from public.profiles where id = auth.uid();
$$;

-- HR / operations / super admin: company-wide visibility and admin writes.
create or replace function app.is_company_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(
    (select role in ('hr', 'operations_manager', 'super_admin')
       from public.profiles where id = auth.uid()),
    false
  );
$$;

-- Anyone who can review attendance (branch managers + company admins).
create or replace function app.is_reviewer()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(
    (select role in ('branch_manager', 'hr', 'operations_manager', 'super_admin')
       from public.profiles where id = auth.uid()),
    false
  );
$$;

revoke all on function app.current_profile() from anon;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.companies   enable row level security;
alter table public.branches    enable row level security;
alter table public.departments enable row level security;
alter table public.positions   enable row level security;
alter table public.profiles    enable row level security;
alter table public.audit_logs  enable row level security;

-- companies: members can read their own company; only super_admin writes.
create policy companies_select on public.companies
  for select to authenticated
  using (id = app.user_company_id());

create policy companies_write on public.companies
  for all to authenticated
  using (id = app.user_company_id() and app.user_role() = 'super_admin')
  with check (id = app.user_company_id() and app.user_role() = 'super_admin');

-- branches / departments / positions: company members read, admins write.
create policy branches_select on public.branches
  for select to authenticated
  using (company_id = app.user_company_id());

create policy branches_write on public.branches
  for all to authenticated
  using (company_id = app.user_company_id() and app.is_company_admin())
  with check (company_id = app.user_company_id() and app.is_company_admin());

create policy departments_select on public.departments
  for select to authenticated
  using (company_id = app.user_company_id());

create policy departments_write on public.departments
  for all to authenticated
  using (company_id = app.user_company_id() and app.is_company_admin())
  with check (company_id = app.user_company_id() and app.is_company_admin());

create policy positions_select on public.positions
  for select to authenticated
  using (company_id = app.user_company_id());

create policy positions_write on public.positions
  for all to authenticated
  using (company_id = app.user_company_id() and app.is_company_admin())
  with check (company_id = app.user_company_id() and app.is_company_admin());

-- profiles:
--   read: own profile; branch managers see their branch; admins see company.
--   write: company admins only (employees must not edit their own role/branch).
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = auth.uid());

create policy profiles_select_branch on public.profiles
  for select to authenticated
  using (
    app.user_role() = 'branch_manager'
    and branch_id = app.user_branch_id()
    and company_id = app.user_company_id()
  );

create policy profiles_select_company on public.profiles
  for select to authenticated
  using (company_id = app.user_company_id() and app.is_company_admin());

create policy profiles_write_admin on public.profiles
  for all to authenticated
  using (company_id = app.user_company_id() and app.is_company_admin())
  with check (company_id = app.user_company_id() and app.is_company_admin());

-- audit_logs: admins read; nobody writes directly (triggers only).
create policy audit_logs_select on public.audit_logs
  for select to authenticated
  using (company_id = app.user_company_id() and app.is_company_admin());

-- ---------------------------------------------------------------------------
-- Audit trigger: record profile role/branch/status changes.
-- security definer lets it insert despite the no-direct-write policy.
-- ---------------------------------------------------------------------------

create or replace function app.tg_audit_profile_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and (
       new.role is distinct from old.role
    or new.branch_id is distinct from old.branch_id
    or new.employment_status is distinct from old.employment_status
  ) then
    insert into public.audit_logs (company_id, actor_id, action, table_name, record_id, details)
    values (
      new.company_id,
      auth.uid(),
      'profile_updated',
      'profiles',
      new.id::text,
      jsonb_build_object(
        'old', jsonb_build_object('role', old.role, 'branch_id', old.branch_id, 'employment_status', old.employment_status),
        'new', jsonb_build_object('role', new.role, 'branch_id', new.branch_id, 'employment_status', new.employment_status)
      )
    );
  end if;
  return new;
end;
$$;

create trigger profiles_audit
  after update on public.profiles
  for each row execute function app.tg_audit_profile_changes();
