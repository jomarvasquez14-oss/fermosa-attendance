# Kiosk tablet provisioning (M10)

A kiosk is a **shared Android tablet** mounted at a branch. Staff clock in/out on
it with their employee code + PIN + selfie; the tablet is locked to that branch.
Unlike personal mode, a kiosk validates everything server-side (device key + PIN,
both bcrypt-checked by the `kiosk-punch` Edge Function) and needs branch Wi-Fi —
there is no offline kiosk queue.

## Hardware

- Any modern Android tablet (Android 10+). A cheap 8–10" tablet is fine.
- Front camera (for the selfie), Wi-Fi, and a wall/counter mount.
- Reliable branch Wi-Fi reaching the mount location.

## One-time setup per tablet

1. **Install the app.** Sideload the `preview` APK (see
   [BUILD-MOBILE.md](BUILD-MOBILE.md)) — open the EAS build link on the tablet
   and tap the `.apk`, or `adb install app.apk`. Allow installs from this source.
2. **Sign in as an admin** (hr / operations / super_admin) on the tablet.
3. **Kiosk setup** → choose this tablet's **branch** and give the device a name
   (e.g. "Makati front desk"). This calls `register_kiosk_device`, which returns
   a device key stored on the tablet. The device now shows under dashboard →
   **Kiosks**.
4. **Lock into kiosk mode.** The app switches to the locked kiosk UI (PIN pad).
   Exiting kiosk mode requires an admin sign-in.
5. **Pin the app at the OS level** so staff can't leave it:
   - Android Settings → Security → **App pinning / Screen pinning** → On.
   - Open the app, then pin it (Recents → the app's icon → Pin). Unpin needs the
     device PIN/pattern — set one only admins know.
   - Optional hardening: a dedicated kiosk launcher/MDM, disable the status bar,
     and disable Play Store. For a single pilot branch, screen pinning is enough.

## Enrolling staff for kiosk use

Each employee needs a **PIN** (separate from their dashboard/app password):

- Dashboard → Employees → open the person → **Kiosk PIN** → set a 4–6 digit PIN.
- Give the PIN to the employee privately. PINs are stored bcrypt-hashed; five
  wrong attempts in 15 minutes locks that code out temporarily (auto-audited).

## Daily use (staff)

1. Tap **Clock in** / **Clock out** on the kiosk.
2. Enter employee code + PIN.
3. Take the selfie when prompted.
4. Confirmation screen → done. The punch appears in the dashboard, geofenced to
   the branch and flagged if anything's off (out of fence, no selfie).

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Device credentials required" / punches rejected | Re-run Kiosk setup (device key missing or app reinstalled). |
| PIN rejected repeatedly then "locked" | 5-attempt lockout — wait 15 min, or confirm the PIN on the dashboard. |
| No selfie saved | Camera permission denied — grant it in Android Settings; a punch still records, flagged "no selfie". |
| Kiosk won't reach the server | Branch Wi-Fi down — kiosk needs connectivity (no offline queue). Staff can use personal mode on their phone meanwhile. |
| Need to move the tablet to another branch | Admin sign-in → exit kiosk → Kiosk setup → pick the new branch. |

## Recovery / decommissioning

- **Retire a tablet:** dashboard → Kiosks → deactivate the device. Its key stops
  working immediately.
- **Lost/stolen tablet:** deactivate the device on the dashboard; its stored key
  is useless once deactivated, and it can't punch without server validation.
