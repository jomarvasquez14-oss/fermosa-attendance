-- Correct the branch on an attendance day (pilot feedback 2026-07-19). Roving /
-- supervisor staff pick their branch at time-in and sometimes MISCLICK. The
-- wrong branch on the day's attendance_records row drives payroll rollup, which
-- manager can review it (RLS), and which shift late/OT is measured against.
-- This lets HR/super-admin re-attribute the DAY to the correct branch (+ the
-- shift the person was on), audit-logged. Raw punches (attendance_events) stay
-- untouched as evidence — same principle as Void/Correct acting on the day, not
-- the punches. Recompute runs against coalesce(record.shift, branch.shift), so
-- updating branch_id + shift_start/shift_end and calling compute is sufficient.

create or replace function public.correct_attendance_branch(
  p_record_id uuid,
  p_branch_id uuid,
  p_shift_start time default null,
  p_shift_end time default null,
  p_note text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.attendance_records%rowtype;
  b public.branches%rowtype;
  v_old_branch uuid;
begin
  if not app.is_company_admin() then
    raise exception 'only HR, operations manager, or super admin can correct the branch';
  end if;
  if p_note is null or btrim(p_note) = '' then
    raise exception 'a reason is required to correct the branch';
  end if;

  select * into r from public.attendance_records
   where id = p_record_id and company_id = app.user_company_id();
  if r.id is null then
    raise exception 'attendance day not found in your company';
  end if;

  select * into b from public.branches
   where id = p_branch_id and company_id = r.company_id and is_active = true;
  if b.id is null then
    raise exception 'branch not found (or inactive) in your company';
  end if;

  -- A chosen shift must be one the branch actually defines (Shift 1/2/3).
  if p_shift_start is not null then
    if not (
      (p_shift_start = b.shift_start and p_shift_end = b.shift_end)
      or (b.shift2_start is not null and p_shift_start = b.shift2_start and p_shift_end = b.shift2_end)
      or (b.shift3_start is not null and p_shift_start = b.shift3_start and p_shift_end = b.shift3_end)
    ) then
      raise exception 'invalid shift for this branch';
    end if;
  end if;

  v_old_branch := r.branch_id;

  update public.attendance_records
     set branch_id = p_branch_id,
         shift_start = p_shift_start,
         shift_end = p_shift_end
   where id = p_record_id;

  -- Refresh base columns (day_class, computed late/OT) against the new branch/
  -- shift. HR's minute overrides are applied afterward via review_attendance.
  perform app.compute_attendance_record(p_record_id);

  insert into public.audit_logs (company_id, actor_id, action, table_name, record_id, details)
  values (
    r.company_id, auth.uid(), 'attendance_branch_corrected', 'attendance_records',
    p_record_id::text,
    jsonb_build_object(
      'old_branch_id', v_old_branch, 'new_branch_id', p_branch_id,
      'shift_start', p_shift_start, 'shift_end', p_shift_end, 'note', p_note
    )
  );
end;
$$;

revoke all on function public.correct_attendance_branch(uuid, uuid, time, time, text) from public;
grant execute on function public.correct_attendance_branch(uuid, uuid, time, time, text) to authenticated;
