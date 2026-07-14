# Fermosa Attendance System — Requirements Spec

Source: project owner, 2026-07-14. Full plan with architecture decisions: see `docs/PLAN.md`.

## Goal

Employee attendance for Fermosa Skin Care Clinic (22 branches, Philippines):

- Works on Android & iPhone; employees clock in/out themselves
- GPS location verification with per-branch geofence
- Selfie verification on clock in/out (proof, human-reviewed in v1)
- Branch-specific attendance; kiosk tablet mode with PIN for shared devices
- Offline-first: punches saved locally and synced with original timestamp
- HR/Branch Manager approval before attendance becomes official
- Payroll reports exported to Excel/CSV and synced to Google Sheets (approved records only)
- Web dashboard for HR/Admin; no expensive biometric hardware

## Phases

1. **Employee Identity** — registration, profile, employee ID, branch/department/position, roles & permissions, schedule, employment status, multi-company ready.
2. **Time Clock** — clock in / break start / break end / clock out via mobile, web, or kiosk; offline queue → pending sync → auto upload.
3. **Verification Layer** — GPS + geofence (e.g., Fermosa Trece, 100 m radius), selfie with timestamp/GPS/device info, kiosk PIN flow, attendance statuses (pending sync / pending review / approved / rejected / corrected), HR/manager review.
4. **Attendance Engine** — working hours, late, early out, OT, break duration, holiday, rest day, absent; flags: on time / late / early out / no clock out / overtime.
5. **Scheduling** — morning/mid/night/custom shifts, rotating schedules, assign by employee/team/branch.
6. **Leave Management** — vacation/sick/emergency/unpaid; employee → manager → HR approval; automatic balances.
7. **Manager Dashboard** — live clocked-in, late, absent, pending reviews, leave requests, daily summary.
8. **Reporting** — daily/weekly/monthly, per employee/branch, OT, leave, payroll; Excel/CSV export (PDF later).
9. **Payroll Integration** — approved attendance → Google Sheets as the official payroll dataset; future payroll API / accounting / ERP.
10. **Enterprise** — multi-company (Suteki Japanese Restaurant, dental supply, fish farm), unlimited branches, RBAC, audit logs, 2FA for privileged roles, API access for Fermosa AI Platform.

**Future (post-launch):** AI attendance assistant — suspicious-pattern flags, approval suggestions, natural-language queries ("Who was late this week?").

## Permission roles vs positions

Permission roles: `employee`, `branch_manager`, `hr`, `operations_manager`, `super_admin`.
Job positions (data, not permissions): receptionist, aesthetician, IV therapist, doctor, etc.

## Core flow

Employee → clock in/out → GPS + geofence → selfie → (offline queue if needed) → upload →
pending review → HR/manager approve/reject/correct → official attendance → attendance engine →
Google Sheets → payroll → reports/analytics/AI.
