# Building the mobile app with EAS (M10)

The app is configured for **EAS Build**. `apps/mobile/eas.json` defines three
profiles; `apps/mobile/app.json` carries the identifiers
(`ph.fermosa.attendance` for both Android and iOS).

You run these commands on your own machine, signed in to your Expo account —
nothing here triggers a build automatically.

## One-time setup

```bash
npm i -g eas-cli            # or use: npx eas-cli@latest <cmd>
cd apps/mobile
eas login                   # your Expo account
eas init                    # creates the EAS project, writes owner + extra.eas.projectId into app.json
```

Point the build at the right backend by setting the Supabase URL/anon key the
app reads (prod for a real build, dev for testing) before building.

## Build profiles (`eas.json`)

| Profile | Output | Use |
|---|---|---|
| `development` | Dev-client APK | Local development with the Expo dev client |
| `preview` | **APK**, internal distribution | Sideload onto kiosk tablets + staff phones |
| `production` | **AAB** (auto-incrementing) | Upload to Google Play |

## Android — the pilot path

```bash
# Kiosk / internal APK (downloadable link when it finishes):
eas build --profile preview --platform android

# Play Store bundle:
eas build --profile production --platform android
# optional: submit to Play internal track (needs a Play service account)
eas submit --profile production --platform android
```

Install the `preview` APK on a device by opening the EAS build link on the
device and tapping the `.apk`, or `adb install <file>.apk`. Android will ask to
allow installs from this source.

## iOS — deferred

`eas.json`/`app.json` already carry the iOS bundle identifier. When an **Apple
Developer account** ($99/yr) is available:

```bash
eas build --profile production --platform ios
eas submit --profile production --platform ios   # TestFlight
```

Until then, skip iOS — the pilot runs on Android (kiosks are Android tablets).

## Updating the app later

Bump `expo.version` in `app.json` (the `runtimeVersion` policy is `appVersion`),
rebuild the relevant profile, and redistribute. Punches are offline-queued, so
updating the app never loses attendance already captured on a device.
