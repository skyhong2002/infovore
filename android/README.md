# Infovore Health for Android

This private companion (current version 0.4.1) reads selected records from Android Health Connect and
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

## App layout (0.4.1)

The screen is split into a **開始使用** checklist (connection → Health Connect
permission → first sync, with a button for the next step) and three collapsible
sections: **連線設定**, **健康資料同步**, and **手機畫面記錄（進階・敏感）**, which
always starts collapsed. Each section header shows its current state.

- Fields are validated before saving, with the reason shown under the field:
  the endpoint must be `https://` (the private Tailscale address allowed in
  `network_security_config.xml` is the only HTTP exception, same as the
  network layer; see "Private HTTP host" below), tokens need at least 32
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
- **同步失敗時通知我** (off by default): when turned on, the app asks for the
  Android notification permission (never at start-up; a denial is explained in
  place). After three consecutive background syncs that WorkManager gives up on
  (about 18 hours, well before the public page reports the data as stale after
  36 hours) it posts one notification on the **同步問題** channel that opens the
  health section. Retries within one six-hour period do not count. The text has
  only the failure count, never health values, error details or tokens. Any
  successful full sync resets the count and removes the notification.
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
   HTTPS. See "Private HTTP host" below to change that address.
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
support reconciling, the read was out of order, a Health Connect page failed to
read, or the read permission may not cover the whole window) is named in the
sync result as **未重新核實**; its rows are left as they were. Reconciling runs
only inside history scans and only with the read permissions a full sync
already requires; incremental syncs and **只同步睡眠** are unchanged.

Since 0.4.0 each such type is also saved as `{dataType, window, reason}` (no
health values, no record ids) and shown in the health section, separately from
the last sync result, as **歷史尚未完整核實：步數、心率…** with each reason and
the last attempt. It stays until a reconcile pass of that type completes over a
window covering it: a later successful incremental sync, a sleep-only sync or
restarting the app never clears it. **重新核實** re-reads only those windows and
sends only their reconcile windows (no record uploads), under the same server
limits; if the server refuses again (HTTP 409) the warning stays with the new
reason. A window older than 30 days is not re-verified without the history
permission. Network failures and HTTP 5xx (including the server's retryable
503) are not recorded as unverified: the sync fails, keeps its progress, and
reads and reconciles that type again on the next run. Changing the destination
discards the saved windows (the new destination gets a full rescan). Server rows
uploaded before 0.3.2 are tied to a device only when every earlier sync came
from a single device; otherwise they are never reconciled until the app
uploads them again.

### Deletions the server refused as too large (0.4.1)

A legitimate large deletion at the source (for example removing a duplicate
writer app from Health Connect) is refused by the server's automatic limits
every time, so since 0.4.1 the app keeps the counts of a refused (HTTP 409)
window with its gap: `{window, wouldDelete, checked, sentIds}` (counts and
times only). The box then says **伺服器偵測到要刪除 N 筆（窗內共 M 筆），因超過自動上限而保留資料**
and offers two choices:

- **我確認來源端已刪除，刪除這 N 筆**: two dialogs, the first naming the data
  type, the time range and the count, the second stating that it cannot be
  undone. Only then does the app re-read that window completely. If the
  re-read lists a different number of records than the refused request did,
  nothing is sent and the reminder asks the user to re-verify and confirm the
  new numbers. Otherwise it sends the window with
  `reconcile.confirmDelete: {"expected": N}`. The server deletes only when its
  own count is still exactly N and at most 2,000
  (`MAX_CONFIRMED_RECONCILE_DELETES`), and in the same transaction writes an
  audit row to `health_connect_confirmed_deletes` (migration 20: time, device
  id, data type, window, deleted and checked counts; no record ids or health
  values). Any other count gets a 409 with the new `wouldDelete`/`checked`
  (never record content), nothing is deleted, and the reminder shows the new
  number for a fresh confirmation. After a confirmed deletion the rest of the
  gap is re-verified under the normal limits. Above 2,000 rows the app offers
  no confirmation at all. A server older than 0.4.1 rejects the unknown field
  (HTTP 400) and deletes nothing.
- **保留伺服器資料並忽略此提醒**: deletes nothing and persists the gap as
  dismissed; **重新核實** skips it and the box hides it (a quiet note lists
  dismissed types, with **重新顯示已忽略的提醒**). It shows again only when a
  later pass reports something different (other counts, a wider window or
  another reason); a completed pass still clears it.

Requests without `confirmDelete` behave exactly as before.

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
acknowledges them; observation ids make retries idempotent. Network failures
and HTTP 5xx (including the server's retryable 503 for storage failures) keep
every record for the next run. When the server rejects a batch as invalid
(HTTP 400), the app splits it in halves and resends each half until it has
found the individual records the server rejects; only those are moved to a
local quarantine (`screen-queue/rejected/`), every valid record still uploads.
Quarantined records are never sent automatically and never deleted
automatically: the section shows **N 筆畫面紀錄被伺服器拒收** with
**刪除被拒收的紀錄**, which asks before deleting them. Since 0.4.1 each record
is quarantined under its destination (`rejected/d-<hash>/`), and
**放回佇列重送（N 筆）** puts, after confirmation, the records of the current
destination back into its upload queue, for when a server-side problem
rejected valid records. Records of another destination, records quarantined
before 0.4.1 (destination unknown) and records older than the queue's
seven-day limit cannot go back and can only be deleted. The quarantine holds
at most 500 records: at that size every upload stops (nothing is deleted, new
captures stay queued under the usual 40 MB / seven-day limits) and the section
says so until the user puts records back or deletes them. If every record of a
batch is rejected, the run stops after quarantining that batch so a
server-side problem cannot drain the queue.

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

The unit tests run on the JVM: the sync logic (`HealthSyncEngine`) is tested
through the narrow `HealthReader` / `HealthUploader` interfaces with fake
implementations, and `HealthReconcileContractTest` checks the app's reconcile
payload field by field against `tests/fixtures/health-reconcile-contract.json`,
which the server's `tests/health-reconcile-contract.test.ts` parses and ingests.

### Private HTTP host

The one host plain HTTP may reach is a build setting, `100.85.214.25` by
default. The form validator and the HTTP client read it from
`BuildConfig.TAILSCALE_HTTP_HOST`, set by the Gradle property
`infovore.tailscaleHttpHost`; Android's network layer allows it in
`app/src/main/res/xml/network_security_config.xml`. To use another private
host, change both, for example in `~/.gradle/gradle.properties` or on the
command line:

```sh
./gradlew -Pinfovore.tailscaleHttpHost=100.64.0.9 assembleDebug
```

together with the `<domain>` in `network_security_config.xml`.
`EndpointPolicyTest` fails when the two differ, so one cannot be changed
without the other. Every other endpoint must use HTTPS.

### Code layout

`MainActivity` only assembles the screen and handles the lifecycle. Each
section has its own controller in `main/` (`ConnectionController`,
`HealthController`, `ReconcileController`, `ScreenController`,
`SetupController`, sharing a `UiHost`), and every state → view decision lives
in the pure, unit-tested mappers in `ui/` (`HealthStatus`, `ReconcileStatus`,
`ScreenStatus`, `SetupProgress`, `FormState`, `MainPanels`).

The APK is written to `app/build/outputs/apk/debug/app-debug.apk`. GitHub Actions
also publishes it as the `infovore-health-debug` workflow artifact.
