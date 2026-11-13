# Android in-app update (self-update)

The staff POS app is a Capacitor APK with the web bundle baked in. API-only changes reach
phones instantly; any change to the screens or the native shell needs a new APK. This
flow lets a phone fetch the new APK itself, without being plugged in.

## How it works

1. The app sends `X-App-Version: <versionCode>` on every API call (native only).
2. `GET /api/app/manifest` (staff-authenticated) returns the published build plus a
   short-lived signed `apkUrl` (HMAC of `versionCode.exp`, 10 min, key derived from
   `PIN_PEPPER`).
3. If `versionCode < minSupported` the API answers **426** to app calls and the app shows
   an undismissable "update now" screen. If only a newer build exists the app shows a
   dismissible banner.
4. The native `ApkInstaller` plugin downloads `GET /api/app/apk`, checks its SHA-256
   against the manifest and hands it to the system installer. **Android always asks the
   user to tap "Install"**, and the user must allow "install unknown apps" for the app
   once. (Silent install needs a device-owner/MDM setup — not done.)
5. Fail-open: if the manifest cannot be read (R2 error, missing, invalid), nobody is
   gated. A network error or 5xx is never treated as "update required".

## Publishing a build

```bash
cd web
# 1. bump versionCode/versionName in web/android/app/build.gradle (versionCode must rise)
npm run cap:sync
cd android && ./gradlew assembleRelease      # signed with ~/.android-keys/rice-pos.properties
cd ../..
# 2. dev first, prod when happy
node tools/publish-apk.mjs web/android/app/build/outputs/apk/release/app-release.apk \
  --version-code 8 --version-name 1.2.0 --env dev
node tools/publish-apk.mjs ... --env prod
```

- **Force (default)**: `minSupported = versionCode` — older phones are blocked until updated.
- **Soft** (`--soft`): keeps the previous `minSupported`; older phones just see a banner.
- The APK is uploaded first and the manifest last, so a failed run never points phones at
  a missing file. Re-running with the same versionCode after a failure is safe.

## Rules that must hold

- The keystore must be the same one the installed apps were signed with, or Android will
  refuse the update. Keep it outside the repo and backed up.
- `versionCode` only moves up. **Rollback** = rebuild the old code with a *higher*
  versionCode and publish that.
- Deploy the API (which knows the endpoints) **before** publishing the first manifest.
- A phone on a build older than this feature has no updater: it needs one manual install.
