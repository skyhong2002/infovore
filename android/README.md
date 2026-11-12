# Infovore Health for Android

This private companion (current version 0.3.0) reads selected records from Android Health Connect and
uploads them to infovore's authenticated ingest service. Garmin Connect can
write its activity and wellness records to Health Connect on Android 14+; this
app then transports those records to infovore without handling Garmin or
Google account credentials.

## Data and privacy

The app requests read-only access to exercise sessions, steps, distance, total
calories, heart rate, sleep, weight, and body fat. Exercise routes are not
requested. The ingest token is encrypted with Android Keystore, Android backup
is disabled, and the server keeps raw Health Connect records outside the public
activity, feed, and MCP projections. Infovore's Health platform page uses only
safe aggregates and recent workout summaries.

## App layout (0.3.0)

The screen is split into a **開始使用** checklist (connection → Health Connect
permission → first sync, with a button for the next step) and three collapsible
sections: **連線設定**, **健康資料同步**, and **手機畫面記錄（進階・敏感）**, which
always starts collapsed. Each section header shows its current state.

- Fields are validated before saving, with the reason shown under the field:
  the endpoint must be `https://` (the private Tailscale HTTP address below is
  the only exception, same as the network layer), tokens need at least 32
  characters without spaces, and **初始同步範圍** must be a number from 1 to
  3650; out-of-range values are rejected instead of silently clamped. Unsaved
  edits are flagged, and leaving the screen with unsaved edits asks first.
- Health Connect status follows `HealthConnectClient.getSdkStatus`: when an
  install or update is required the app offers to open the Play Store; when it
  is unsupported it says so and disables syncing. **只同步睡眠（優先）** needs
  only the sleep permission and **立即同步** needs all of them; a disabled
  button always shows why. If the permission dialog does not appear (after
  repeated denials), the app links to Health Connect's settings instead.
- Manual syncs run in a ViewModel, so rotating the phone or switching dark mode
  does not cancel them; failures show a plain-language reason and **重試**.
- Times are shown as relative time plus the local date and time, following the
  phone's 12/24-hour setting.
- The UI supports TalkBack (section headings, expand/collapse state, field
  labels and errors), large fonts, 48 dp touch targets, dark mode, and
  edge-to-edge insets.

## Setup

Use **只同步睡眠（優先）** to upload sleep independently of the initial
all-types import and existing change tokens. Only sleep read permission is
required for this action. It reads newest sleep first and preserves the sleep
count or error separately from general sync progress. Full sync also refreshes
sleep first on every run. A zero count means no readable sleep was found in
the allowed history window; check sleep records and write permissions in Health
Connect and sync the Garmin device before retrying.

1. Set a random `HEALTH_CONNECT_TOKEN` of at least 32 characters on the
   infovore ingest service. If it is omitted, the server falls back to
   `INGEST_TOKEN` for backward compatibility.
2. Make the ingest service reachable from the phone. The bundled build defaults
   to `https://infovore.skyhong.tw`. For local testing it also allows
   `http://100.85.214.25:3001`; that private address is transported inside
   Tailscale's encrypted tunnel. Other endpoints must use HTTPS.
3. In Garmin Connect, enable writing data to Health Connect.
4. Install the APK, enter the endpoint and token, save, and grant Health Connect
   permissions.
5. Tap **立即同步** for the first import. The app displays progress and uploads
   each Health Connect page as it is read. During a manual import it keeps the
   display awake and retries transient connection failures up to four times.
   WorkManager checks for changes every six hours while a network is available.

The initial import and each sleep refresh read only the number of recent days
set in **初始同步範圍** (default 7). Without the optional Health Connect history
permission the window is capped at 30 days; with it, up to ten years. Keep the
window small on a fresh install so the first sync finishes quickly; later syncs
only process incremental changes.
Historical data is uploaded in sleep, exercise, and steps order before the
remaining record types, so sleep summaries become available without waiting
for the much larger granular step history.
Subsequent imports use Health Connect change tokens and apply both upserts and
deletions. Change tokens expire after 30 days, so an expired token safely falls
back to another historical scan.

## 手機 Dayflow

Version 0.2.0 adds a passive phone activity recorder, the Android counterpart of
Dayflow on macOS. An accessibility service (**Infovore 手機 Dayflow**) records
what is on screen and queues "observations" that infovore summarizes into
timeline cards with a vision model on the server. The phone makes no AI calls
and holds no model keys.

### Setup

1. Set a random `DAYFLOW_PHONE_TOKEN` of at least 32 characters on the infovore
   ingest service. It is separate from `HEALTH_CONNECT_TOKEN`; without it the
   server answers 503.
2. In the app's **手機畫面記錄（進階・敏感）** section, enter the token, tap
   **儲存畫面記錄設定**, and use **測試連線** (calls `GET /api/ingest/dayflow-phone/status`).
   The endpoint and device id are shared with the Health Connect section.
3. Sideloaded APKs must first allow restricted settings: Android Settings →
   Apps → Infovore → ⋮ → **允許受限制的設定** (Allow restricted settings).
4. Tap **開啟無障礙設定**, enable **Infovore 手機 Dayflow**, then turn on
   **啟用記錄** in the app and confirm the dialog. The app never enables
   recording or the accessibility service by itself.

### What is captured

Each observation holds the capture time, the foreground app's package and
label, up to 4,000 characters of visible UI text (text and content
descriptions; password fields are skipped), and optionally a JPEG thumbnail
(long edge ≤ 720 px, quality 60). A thumbnail is attached only when the
visible text changed since that app's last thumbnail or five minutes have
passed. Secure windows (`FLAG_SECURE`), mostly black frames, built-in sensitive
apps (password managers, authenticators), and packages listed under
**排除的 App 套件** are recorded as `blocked` with only the package and label.
The app's own screen and the lock screen are never captured.

### Cadence

Capture runs only while recording is enabled and not paused (**暫停 1 小時**),
and only while the screen is on and unlocked: once a minute, plus on a
foreground-app change (at most one capture per five seconds). Observations are
queued as JSON files in the app's no-backup storage (capped at about 40 MB;
items older than seven days are dropped) and uploaded in batches of at most 40
items and 6 MB to `POST /api/ingest/dayflow-phone/observations`: every five
minutes from the service while online, every 15 minutes via WorkManager as a
fallback, and on **立即上傳**. Files are deleted only after the server
acknowledges a batch; observation ids make retries idempotent.

### Privacy

Screen text and thumbnails go only to your own infovore server, which deletes
the raw observations after summarizing them. The token is encrypted with a
dedicated Android Keystore key, and the queue is excluded from backup.

## Build

Install JDK 17 and Android SDK platform 36, then run:

```sh
cd android
./gradlew assembleDebug lintDebug testDebugUnitTest
```

The APK is written to `app/build/outputs/apk/debug/app-debug.apk`. GitHub Actions
also publishes it as the `infovore-health-debug` workflow artifact.
