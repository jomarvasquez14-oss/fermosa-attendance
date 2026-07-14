-- Local development seed. Runs on `supabase db reset` AFTER migrations.
-- NEVER run against production: creates users with a known password.
--
-- Branch coordinates are approximate mall/city-center locations in Cavite;
-- replace with surveyed coordinates per branch before rollout.

-- ---------------------------------------------------------------------------
-- Company
-- ---------------------------------------------------------------------------

insert into public.companies (id, name) values
  ('c0000000-0000-0000-0000-000000000001', 'Fermosa Skin Care Clinic');

-- ---------------------------------------------------------------------------
-- Branches (sample of the 22; more added via dashboard in M1)
-- ---------------------------------------------------------------------------

insert into public.branches (id, company_id, name, address, lat, lng, geofence_radius_m) values
  ('b0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
   'Fermosa Trece', 'Trece Martires, Cavite', 14.2818, 120.8656, 100),
  ('b0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001',
   'Fermosa Dasmariñas', 'Dasmariñas, Cavite', 14.3294, 120.9367, 100),
  ('b0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000001',
   'Fermosa Imus', 'Imus, Cavite', 14.4297, 120.9367, 100),
  ('b0000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000001',
   'Fermosa Tagaytay', 'Tagaytay, Cavite', 14.1153, 120.9621, 150);

-- ---------------------------------------------------------------------------
-- Departments & positions
-- ---------------------------------------------------------------------------

insert into public.departments (id, company_id, name) values
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'Clinical'),
  ('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001', 'Front Desk'),
  ('d0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000001', 'Administration');

insert into public.positions (id, company_id, name) values
  ('e0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'Receptionist'),
  ('e0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001', 'Aesthetician'),
  ('e0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000001', 'IV Therapist'),
  ('e0000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000001', 'Doctor'),
  ('e0000000-0000-0000-0000-000000000005', 'c0000000-0000-0000-0000-000000000001', 'Branch Manager'),
  ('e0000000-0000-0000-0000-000000000006', 'c0000000-0000-0000-0000-000000000001', 'HR Officer');

-- ---------------------------------------------------------------------------
-- Auth users + profiles (password for all: password123)
-- ---------------------------------------------------------------------------

create or replace function pg_temp.seed_user(
  p_id uuid,
  p_email text,
  p_full_name text,
  p_employee_code text,
  p_role public.user_role,
  p_branch_id uuid,
  p_department_id uuid,
  p_position_id uuid
) returns void
language plpgsql
as $$
begin
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change, email_change_token_new, email_change_token_current
  ) values (
    '00000000-0000-0000-0000-000000000000', p_id, 'authenticated', 'authenticated',
    p_email, extensions.crypt('password123', extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('full_name', p_full_name),
    now(), now(), '', '', '', '', ''
  );

  insert into auth.identities (
    id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
  ) values (
    uuid_generate_v4(), p_id, p_id::text,
    jsonb_build_object('sub', p_id::text, 'email', p_email, 'email_verified', true),
    'email', now(), now(), now()
  );

  insert into public.profiles (
    id, company_id, branch_id, employee_code, full_name, role,
    department_id, position_id, employment_status
  ) values (
    p_id, 'c0000000-0000-0000-0000-000000000001', p_branch_id, p_employee_code,
    p_full_name, p_role, p_department_id, p_position_id, 'active'
  );
end;
$$;

select pg_temp.seed_user(
  'a0000000-0000-0000-0000-000000000001', 'admin@fermosa.test', 'System Administrator',
  'FSC-0001', 'super_admin', null,
  'd0000000-0000-0000-0000-000000000003', null);

select pg_temp.seed_user(
  'a0000000-0000-0000-0000-000000000002', 'hr@fermosa.test', 'Helena Reyes',
  'FSC-0002', 'hr', null,
  'd0000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000006');

select pg_temp.seed_user(
  'a0000000-0000-0000-0000-000000000003', 'ops@fermosa.test', 'Oscar Perez',
  'FSC-0003', 'operations_manager', null,
  'd0000000-0000-0000-0000-000000000003', null);

select pg_temp.seed_user(
  'a0000000-0000-0000-0000-000000000004', 'manager.trece@fermosa.test', 'Marites Cruz',
  'FSC-0004', 'branch_manager', 'b0000000-0000-0000-0000-000000000001',
  'd0000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000005');

select pg_temp.seed_user(
  'a0000000-0000-0000-0000-000000000005', 'maria@fermosa.test', 'Maria Santos',
  'FSC-0005', 'employee', 'b0000000-0000-0000-0000-000000000001',
  'd0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000002');

select pg_temp.seed_user(
  'a0000000-0000-0000-0000-000000000006', 'ana@fermosa.test', 'Ana Dela Cruz',
  'FSC-0006', 'employee', 'b0000000-0000-0000-0000-000000000002',
  'd0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000001');
