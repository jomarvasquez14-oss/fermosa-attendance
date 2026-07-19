# Correct the branch on an attendance day (Reviews → Correct)

**Date:** 2026-07-19
**Status:** Approved design — ready for implementation plan

## Problem

Roving and supervisor staff (`profiles.branch_id IS NULL`) pick their branch at
time-in. When they **misclick the wrong branch**, HR currently has no way to fix
it. The wrong branch is stored on the day's `attendance_records` row, which drives
three things:

1. **Payroll rollup** — `report_payroll_summary` groups each day under
   `attendance_records.branch_id`, so a misclicked day counts under the wrong
   branch.
2. **Review visibility (RLS)** — a branch manager only sees their own branch's
   records, so the wrong branch's manager reviews it and the right one can't.
3. **Late / OT computation** — the engine measures late/undertime/OT against the
   record's shift (`coalesce(record.shift_start, branch.shift_start)`), so a day
   pinned to the wrong branch is scored against the wrong hours.

The **Correct** panel on Reviews can already fix times and Late/Undertime/OT, and
**Manual time entry** already has a branch picker (for roving). The gap is exactly
what the owner asked for: let HR/super-admin **correct the branch** on the Correct
panel.

## Decisions

- **Scope (B):** the Branch selector shows on Correct for **any** employee's day,
  pre-filled with the day's current branch (zero extra clicks when only fixing a
  time).
- **Late/OT (A):** changing the branch **re-measures Late/OT against the new
  branch's hours**; if the new branch runs 2–3 shifts, a **Shift picker** appears
  (pre-filled to Shift 1) so HR sets which shift the person was on. The
  Late/Undertime/OT fields remain hand-editable afterward (existing grant/waive
  fields).
- **Punches stay as evidence:** only the **day record's** branch (+ shift) is
  changed. The raw `attendance_events` keep their original branch, GPS, and
  selfie — consistent with the system's rule that Void/Correct act on the day, not
  the raw punches.
- **Access:** HR / operations manager / super-admin only (same gate as every
  correction). Branch managers stay view-only. A **reason is required**.

## Behavior (UI — Reviews `CorrectionForm`)

- A **Branch** `<select>` at the top of the correction fields, pre-filled with the
  day's current branch, listing active company branches (RLS-scoped).
- On selecting a different branch:
  - Look up the branch's shifts via the shared `branchShifts(branch)` helper.
  - If the branch has **>1 shift**, render a **Shift** `<select>` (options labelled
    by `formatShift`), pre-filled to Shift 1. Single-shift branch → no picker,
    uses that shift.
  - Recompute the default Late/Undertime/OT via `computeDayMinutes` against the
    **selected** shift (replacing today's `record.shift_start ?? record.branch?.shift_start`).
  - HR can still hand-edit Late/Undertime/OT.
- **Save** marks the day **Corrected** and is **audit-logged** (both the branch
  change and the time/minute correction).

## Backend — new RPC

`public.correct_attendance_branch(p_record_id uuid, p_branch_id uuid, p_shift_start time default null, p_shift_end time default null, p_note text)`
— `security definer set search_path = public`:

1. Gate `app.is_company_admin()`; note required (raise if blank).
2. Load the record; must belong to the caller's company (raise otherwise).
3. `p_branch_id` must be an **active branch in the company** (raise otherwise).
4. If `p_shift_start` is not null, validate `(p_shift_start, p_shift_end)` matches
   one of the branch's shifts (shift1 / shift2 / shift3) — the same whitelist
   pattern as `ingest_punch_as` (raise `invalid shift for this branch` otherwise).
   Null shift → record falls back to the branch's Shift 1 at compute time.
5. `update attendance_records set branch_id = p_branch_id, shift_start =
   p_shift_start, shift_end = p_shift_end where id = p_record_id;` then
   `perform app.compute_attendance_record(p_record_id);` so base columns
   (day_class, computed late/OT) refresh against the new branch/shift.
6. Audit row: action **`attendance_branch_corrected`**, table
   `attendance_records`, `record_id = p_record_id`, details
   `{old_branch_id, new_branch_id, shift_start, shift_end, note}`.
7. `revoke all ... from public; grant execute ... to authenticated;` (self-gated).

Confirm at implementation that no existing `attendance_records` UPDATE trigger
conflicts with the branch/shift update.

## Data flow on Save

- If the selected branch **or** shift differs from the record's stored values →
  call `correct_attendance_branch(record.id, branchId, shiftStart, shiftEnd,
  note)` first, then the existing `review_attendance(record.id, 'corrected', note,
  corrections)` (corrections = the minutes computed against the selected shift).
- If unchanged → the existing `review_attendance('corrected', …)` path only (no
  behavior change for time-only corrections).

## Shared

- `AUDIT_ACTION_LABELS['attendance_branch_corrected'] = 'Attendance branch corrected'`
  ([packages/shared/src/constants.ts]).
- No new type: `Branch` already carries `shift2_*`/`shift3_*`; `branchShifts` +
  `formatShift` already exist.

## Reviews page plumbing

- Extend the record (`DayDetail`) query to also select the record's `branch_id`.
- Extend the Reviews branches load (currently `id, name`) to include
  `shift_start, shift_end, shift2_start, shift2_end, shift3_start, shift3_end`, and
  pass the list into `CorrectionForm` so the picker + recompute work.

## What does NOT change

- No mobile change (HR dashboard-only tool).
- No payroll/reports change — `report_payroll_summary` already groups by the
  record's branch, so the rollup follows automatically once the branch is updated.
- `review_attendance` is untouched (the branch change is its own RPC → lower blast
  radius + a distinct audit event).
- Raw `attendance_events` untouched.

## Edge cases / accepted behavior

- **Punches page shows the tapped branch.** Since events keep their branch, the
  raw punch feed still lists the branch the employee pressed; payroll, review, and
  Late/OT follow the corrected branch. Accepted (punches = immutable evidence).
- **Branch-manager punch visibility.** After moving a record to branch X, the
  events are still branch Y, so a **branch-X manager** opening the day detail may
  not see the raw punch tiles (event RLS is by event branch). HR/super-admin (who
  perform corrections) see everything, so this doesn't block the workflow.
  Accepted limitation.
- **Same-branch shift fix.** Picking a different shift within the same branch is
  also a valid correction and routes through the same RPC.

## Verification

1. `npm test` + both typechecks.
2. Gated prod `db push`. Scratchpad scenario script vs live DB (temp branch X
   single-shift 09:00–18:00, temp branch Y with Shift 1 08:00–17:00 + Shift 2
   12:00–21:00; temp roving employee; temp HR + temp branch managers for X and Y;
   full cleanup in `finally`):
   - Seed a day pinned to X (via `ingest_punch_as`). Call
     `correct_attendance_branch(record, Y, '12:00','21:00', 'misclick')` as HR →
     record `branch_id = Y`, shift 12:00–21:00, late measured vs 12:00;
     `report_payroll_summary` rolls the day under Y; audit row
     `attendance_branch_corrected` written.
   - Error paths: non-admin caller rejected; branch not in company rejected;
     invalid shift for Y rejected; blank note rejected.
   - RLS: branch-Y manager now sees the record; branch-X manager no longer does.
3. Browser as HR: Reviews → Correct → Branch dropdown pre-filled → change to the
   2-shift branch → Shift picker appears → Late recomputes → Save → row shows
   **Corrected** and moves under the new branch's filter; a plain time-only Correct
   (no branch change) still works unchanged.
4. One commit (migration + shared label + Reviews) → auto-push → Vercel deploy
   watch (bundle-grep for the new Branch/Shift labels).
