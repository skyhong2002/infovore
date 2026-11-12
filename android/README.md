# Infovore Health for Android

This private companion (current version 0.3.2) reads selected records from Android Health Connect and
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

## App layout (0.3.2)

The screen is split into a **開始使用** checklist (connection → Health Connect
permission → first sync, with a button for the next step) and three collapsible
sections: **連線設定**, **健康資料同步**, and **手機畫面記錄（進階・敏感）**, which
always starts collapsed. Each section header shows its current state.

- Fields are validated before saving, with the reason shown under the field:
  the endpoint must be `https://` (the private Tailscale address allowed in
  `network_security_config.xml` is the only HTTP exception, same as the
  network layer), tokens need at least 32
  characters without spaces, and **初始同步範圍** must be a number from 1 to
  3650; out-of-range values are rejected instead of silently clamped. Unsaved
  edits are flagged, and leaving the screen with unsaved edits asks first.
  Unsaved token edits survive rotation and dark-mode switches: they are kept
  only in the ViewModel's memory (never in the saved-instance-state bundle,
  preferences, or logs) and are cleared when saved or discarded.
- Changing the sync destination (the endpoint after normalising case, default
  ports and trailing slashes) clears the Health Connect change token and the
  first-sync flag, so the next **立即同步** re-imports the recent history
  window into the new server. It asks for confirmation first whenever anything
  is tied to the old destination: a previous sync, queued phone screen records
  (the dialog gives their count), or a saved `DAYFLOW_PHONE_TOKEN`, which is
  cleared and must be re-entered for the new destination. Changing only the
  token keeps everything. The destination cannot change while a sync or a
  phone screen upload is running: the change takes both locks or is refused
  with an explanation.
- Health Connect status follows `HealthConnectClient.getSdkStatus`: when an
  install or update is required the app offers to open the Play Store; when it
  is unsupported it says so and disables syncing. **只同步睡眠（優先）** needs
  only the sleep permission and **立即同步** needs all of them; a disabled
  button always shows why. If the permission dialog does not appear (after
  repeated denials), the app links to Health Connect's settings instead.
- Manual syncs run in a process-wide runner rather than the screen, so
  rotating the phone, switching dark mode, pressing back, or leaving the app
  does not cancel them (while the process lives; without the background-read
  permission Health Connect itself only allows reads while the screen is in
  the foreground, and the app says so while syncing). Manual and background
  syncs share one lock and never run at the same time: a background sync that
  finds a manual one running is retried later by WorkManager, and a manual
  request waits for a running background sync. Failures show a plain-language
  reason and **重試**.
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
   to `https://infovore.skyhong.tw`. For local testing it also allows plain
   HTTP to the single private Tailscale address listed in
   `app/src/main/res/xml/network_security_config.xml` (port 3001); that traffic
   is carried inside Tailscale's encrypted tunnel. Other endpoints must use
   HTTPS.
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

### Re-verifying deletions after a history scan

A history scan (first sync, a new destination, or an expired change token)
re-uploads everything still in Health Connect, but records deleted at the
source while no change token covered them would otherwise stay on the server.
So during such a scan, once every page of a data type in the scan window
`[start, end)` has been read successfully, the app also sends reconcile
windows: `{dataType, start, end, recordIds}` listing every record id that
starts in the window (long histories are split into windows of at most 2,000
ids, cut only between distinct start times; the server accepts at most 5,000).
In the same transaction the server deletes only rows that came from this
device (`deviceId`), have that data type, start in `[start, end)`, end no later
than `end`, and are not listed. It refuses the window (HTTP 409, nothing
deleted) when that would remove more than 20 rows and either more than 10% of
the device's stored rows in the window or more than 200 rows, and answers 400 to malformed or oversized
windows. Batches without `reconcile` behave exactly as before.

A type that could not be fully re-verified (the server refused or does not
support reconciling, or the read was out of order) is named in the sync
result as **未重新核實**; its rows are left as they were. Reconciling runs only
inside history scans and only with the read permissions a full sync already
requires; incremental syncs and **只同步睡眠** are unchanged. Server rows
uploaded before 0.3.2 are tied to a device only when every earlier sync came
from a single device; otherwise they are never reconciled until the app
uploads them again.

A history scan saves its progress after each data type (the change token it
started with, its fixed window, the destination, and the finished types). If
the system stops the app mid-scan, the next sync continues with the remaining
types instead of starting over; the change token becomes the sync cursor only
after every type is done, so changes made in between are still picked up. A
type interrupted halfway is read again from its start (uploads are
idempotent). Changing the destination or an expired token discards the saved
progress.

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

Each observation is filed under the sync destination saved when it was
captured. An upload run reads the endpoint, phone token and device id once at
its start and sends every batch of that run there, and it only sends records
filed under that destination. The phone token is stored with the destination
it was saved for and is never sent anywhere else. Records left from an earlier
destination (or queued by a version before 0.3.2, whose destination is
unknown) are never uploaded automatically and never migrated: the section
shows **N 筆待傳紀錄屬於舊目的地** with a **刪除這些紀錄** button that asks
before deleting them. Switching back to the earlier destination uploads them
there. Changing the destination never turns recording on, never changes the
exclusion list, and never triggers a capture.

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
