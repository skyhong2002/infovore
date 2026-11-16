# Infovore Health for Android

This private companion (current version 0.7.0) reads selected records from Android Health Connect,
records the phone's location when asked, and uploads them to infovore's authenticated ingest service. Garmin Connect can
write its activity and wellness records to Health Connect on Android 14+; this
app then transports those records to infovore without handling Garmin or
Google account credentials.

## Location history (0.7.0)

Settings has a **位置紀錄** section:

- **持續記錄位置** (off by default) asks for precise location and starts a
  foreground service (`LocationTrackingService`, type `location`) with an
  ongoing **正在記錄位置** notification. It asks the platform fused provider
  (GPS/network as a fallback) for a fix about once a minute and at most every
  15 m of movement, at balanced accuracy (Wi-Fi/cell) unless **高精確度** is on.
  Fixes queue in `noBackupFilesDir/location-queue.csv` (at most 50,000) and are
  removed only after the server stored them. `LocationUploadWorker` uploads
  every 15 minutes with a network connection, sooner after 120 queued fixes,
  and on **立即上傳**; transient failures retry up to three times, a refused
  token stops until the next run.
- Android only lets the service start while Infovore is on screen. It resumes
  whenever the app opens; with **一律允許** location (offered, never required)
  it also resumes after a reboot or app update (`LocationBootReceiver`).
- **匯入 Google 地圖時間軸** opens the system file picker. The file is parsed as a
  stream (`TimelineParser`: the on-device export's `semanticSegments` and
  `rawSignals`, the iOS array export, Takeout `Records.json` and
  `timelineObjects`) and uploaded in batches of at most 1,000 points or 500
  visits and trips while it is read, so large exports do not need memory. The
  import keeps running when the screen closes; cancelling keeps what was sent.
  Records with no time or position are skipped and counted.
- Uploads use the saved endpoint and `HEALTH_CONNECT_TOKEN` (the server accepts
  a separate `LOCATION_TOKEN` when set). **在網頁上查看位置足跡** opens
  `<endpoint>/location`, which asks for the same token.

Location is private: it is not shown on public pages, feeds or cards.

## Phone activity moved to PocketLog (0.6.0)

The phone screen recorder (**手機足跡** / 手機 Dayflow: accessibility capture,
upload queue, quarantine, private timeline) was removed in 0.6.0; phone activity
is now recorded by [PocketLog](https://github.com/skyhong2002/PocketLog). The
server no longer accepts `/api/ingest/dayflow-phone/*`. On first start after the
upgrade, the app cancels the old periodic upload work, deletes queued screen
captures (`noBackupFilesDir/screen-queue`), the recorder's settings, its
Keystore key and any quarantine notification (`RetiredScreenRecorder`). If the
accessibility service was enabled, Android drops it with the service itself.

## Activity overview

The launch screen follows `/platforms/dayflow`: a tinted source header, four
outlined stat tiles, distinctive recent keywords, all recent keywords, weekly
category chips and stacked bars for recent recorded days, read from the same
public `/api/dayflow.json` as the site (no credentials are sent). Light/dark
surfaces, compact outlined chips and 16dp/11dp corners match the website. No
data is replaced by demonstration content.

Bottom navigation has **總覽**, **瀏覽**, **設定**. Browse keeps the native recent
public content list with category filters; details open the public site inside
the app, and external links open in the browser. Health Connect setup remains in
the separate settings screen.

## Data and privacy

The app requests read-only access to exercise sessions, steps, distance, total
calories, heart rate, sleep, weight, and body fat. Exercise routes are not
requested; location comes only from the opt-in recorder and imported Timeline
files (see "Location history"). The ingest token is encrypted with Android Keystore, Android backup
is disabled, and the server keeps raw Health Connect records outside the public
activity, feed, and MCP projections. Infovore's Health platform page uses only
safe aggregates and recent workout summaries.

## App layout (0.4.1)

The screen is split into a **開始使用** checklist (connection → Health Connect
permission → first sync, with a button for the next step) and two collapsible
sections: **連線設定** and **健康資料同步**. Each section header shows its current
state.

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
  window into the new server. It asks for confirmation first when a previous
  sync is tied to the old destination. Changing only the token keeps
  everything. The destination cannot change while a sync is running: the
  change takes the sync lock or is refused with an explanation.
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
- Background failures (0.4.7) are split by what can fix them. One only the
  user (or the server's owner) can fix ends the run at once without retrying:
  HTTP 400/401/403/404/413, a 503 the server marks `"retryable": false` (the
  feature is not configured), an endpoint the policy refuses, missing settings
  or Health Connect permissions. The status reads **背景同步失敗，需要處理：…**
  with the reason, and the next try is the next six-hourly run (or 「立即同步」).
  Transient failures (network, HTTP 408/429/5xx) follow the server's
  `Retry-After` (seconds or an HTTP date): the HTTP client waits it out between
  its own attempts when it is at most 30 s, and otherwise stops at once and
  hands it to the worker, which lets WorkManager's backoff (30 s, doubling)
  retry when that is at least as long, or schedules one follow-up run for when
  the server asked (at most six hours; the status reads **背景同步延後：…約 N
  分鐘後自動重試**). Without a hint the client backs off 1, 2, 4 s and the
  worker retries with WorkManager's backoff, at most four times a period.
- Times are shown as relative time plus the local date and time, following the
  phone's 12/24-hour setting.
- **同步失敗時通知我** (off by default): when turned on, the app asks for the
  Android notification permission (never at start-up; a denial is explained in
  place). After three consecutive background syncs that WorkManager gives up on
  (about 18 hours, well before the public page reports the data as stale after
  36 hours) it posts one notification on the **同步問題** channel that opens the
  health section. Retries within one six-hour period do not count; a failure
  that needs the user counts at once. The text has
  only the failure count, never health values, error details or tokens. Any
  successful full sync resets the count and removes the notification.
  Since 0.4.4 a warning that already applies when notifications are turned on
  (the switch, or the permission granted) is shown at once, once: three or more
  failed background syncs. A warning counts as
  shown only when both the switch and the permission allowed it.
  Since 0.4.5 it also counts as shown only when the system would display it:
  the permission, Infovore's notifications and the **同步問題** channel must
  all be on in system settings. If the user turned off Infovore's
  notifications or only that channel, nothing is recorded as notified, the
  switch's note says notifications are blocked and offers **開啟通知設定**
  (the channel's or the app's notification settings), and the warnings that
  still apply are delivered once, the next time the app comes back to the
  foreground with them allowed again. A warning that was shown and then hidden
  by the system is delivered again the same way. Each still shows once: one the
  user swiped away is not repeated.
- A background sync that never runs (the system restricted the app, or it was
  force-stopped) cannot notify anyone. So since 0.4.4, when the app is opened
  more than 24 hours after the last successful full sync, the top of the health
  section says so (and the collapsed header shows **超過 24 小時未同步**), with
  **立即同步** and, when notifications are off, **開啟通知** (only on that tap;
  notifications are never turned on automatically). The server's `/status`
  page marks Health delayed after the same 24 hours.
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
starts in the window (long histories are split into windows of about 2,000
ids; the server accepts at most 5,000). Since 0.4.4 a window is cut only at a
time no record read so far lies across: where the records before the cut end
(at least just after the last of their starts), and no later than the next
record starts. A record deleted at the source between two windows then starts
inside the later window and is deleted by it; before 0.4.4 the cut was the next
record's start, so a deleted record ending there belonged to no window and
stayed on the server. When long, overlapping records leave no such time within
5,000 ids, the type is reported unverified (**紀錄彼此重疊過多，無法安全分段核實**)
rather than cut across a record. Descending reads (sleep) can only avoid the
record just before the cut, which is enough for non-overlapping sessions.
In the same transaction the server deletes only rows that came from this
device (`deviceId`), have that data type, start in `[start, end)`, end before
`end`, and are not listed. A row that reaches the window end or beyond is never
deleted by that window (since 0.4.3; before, a row ending exactly at `end` could
be): Health Connect may leave such records out of a complete read (the official
`FakeHealthConnectClient` only returns interval records ending before the range
end), so their absence proves nothing. The cost is the other way round: such a
record deleted at the source stays on the server until a later reconcile window
contains it entirely, typically the next history scan, which ends at that
scan's "now" (internal cuts no longer leave such records behind, see above); a re-verified gap that ends at a past time does not remove a
sleep session crossing that time. It refuses the window (HTTP 409, nothing
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
times only). Since 0.4.3 the server's 409 also carries
`byOrigin: [{origin, count}]`, how many of the rows it would delete came from
each source app (`data_origin`, a package name; at most 10 apps, largest first,
the rest merged as `other`; never record ids or values), and the app keeps it
with the gap. The box then says **伺服器偵測到要刪除 N 筆（窗內共 M 筆），因超過自動上限而保留資料**
(plus **來自：X 筆 com.example.app、…** when the server reported origins)
and offers two choices:

- **我確認來源端已刪除，刪除這 N 筆**: two dialogs, the first naming the data
  type, the time range, the count and (when reported) the source apps, the second stating that it cannot be
  undone. Only then does the app re-read that window completely. If the
  re-read lists a different set of records than the refused request did (the
  app keeps a SHA-256 digest of the ids it sent, not the ids, so the same
  number of different records counts as different too), nothing is sent and
  the reminder asks the user to re-verify and confirm the new numbers.
  Otherwise it sends the window with
  `reconcile.confirmDelete: {"expected": N, "token": "<confirmToken>"}`, where
  `confirmToken` (since 0.4.4) is what the server's 409 named exactly the rows
  it would delete with: SHA-256 over the device, data type, window and the
  sorted ids of those rows (no id can be read back from it). The server deletes
  only when the rows it would now delete still give the same token (so the
  very same rows, not only as many), there are exactly N and at most 2,000
  (`MAX_CONFIRMED_RECONCILE_DELETES`), and in the same transaction writes an
  audit row to `health_connect_confirmed_deletes` (migration 20: time, device
  id, data type, window, deleted and checked counts; no record ids or health
  values). The confirmed response also carries `reconciled.byOrigin`. Any other
  count or set of rows, and a confirmation without a token (as 0.4.3 sends
  it), gets a 409 with the new `wouldDelete`/`checked`/`byOrigin`/`confirmToken`
  (never record content), nothing is deleted, and the reminder shows the new
  numbers and source apps for a fresh confirmation. A refusal saved by 0.4.3
  has no token: the app offers no confirmation for it until **重新核實** fetches
  a fresh one. After a confirmed deletion the rest of the
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
`HealthConnectReaderTest` runs the real `HealthConnectReader` over the official
`FakeHealthConnectClient` (`androidx.health.connect:connect-testing`) into the
real engine: paging (including records sharing one start time across a page
boundary), window edges, read order, permissions and change tokens.
The fake keeps insertion order, ignores `ascendingOrder`, only matches interval
records that lie fully inside the time range (ending before its end), and its
`nextChangesToken` misses later changes; the test's comments say where each of
these matters. A record the fake leaves out because it reaches the window end
is not deleted by the server, which only deletes rows ending before the window
end (`tests/health-reconcile.test.ts` covers that case).

The tests in `src/test/.../robo/` run the real app on Robolectric 4.16.1 (SDK 34,
the minSdk; SDK 35+ would need JDK 21), still inside `testDebugUnitTest`:

- `MainActivityUiTest` starts `MainActivity` and checks each section (first-run
  steps, connection, health, the reconcile reminder):
  visible texts, which sections start collapsed, TalkBack headings, state
  descriptions and field errors, that every visible control is at least 48 dp,
  field validation, the unsaved-changes dialog on back, the stale-sync warning,
  and the notification tap's section; and that the screen renders at font scale 1.3 in dark mode.
- `NotificationsTest` checks what reaches Android's NotificationManager:
  channel, text without secrets, the tap's target and extra, private
  visibility, and that a warning blocked by the permission, Infovore's
  notifications or the channel is not counted and is delivered once allowed.
- `BackgroundWorkTest` uses WorkManager's test driver: the periodic sync is
  scheduled at start-up with a network constraint, an upgrade from 0.5.x removes
  the retired screen recorder's work, files and settings, `SyncWorker` retries while a
  manual sync holds the lock, and a failure that needs the user counts toward
  the warning at once.
- `BackgroundRetryTest` runs the real `SyncWorker`
  against `FakeIngestServer`: 400/401/403, a 503 marked not retryable, a refused
  endpoint and missing permissions end the run without a retry; a retryable 503
  retries with backoff and counts only the last attempt; `Retry-After` in
  seconds or as an HTTP date is waited out inside the run, left to WorkManager's
  backoff, or turned into a follow-up run at the server's time (capped at six
  hours, never chained, cancelled by a later success). `RetryPolicyTest` covers the parsing (injected
  clock, invalid values) and every plan.
- `SyncFlowUiTest` runs the two main flows end to end in the app: pressing
  「立即同步」 on a first run (real `SyncRunner`, `HealthSyncEngine`,
  `HealthConnectReader` and `InfovoreApi`, synthetic records in the fake Health
  Connect) until the screen shows the finished sync and completed setup; and a
  reconcile window the server refuses (HTTP 409 with counts, source apps and a
  confirm token) shown as a reminder with its sources, deleted only after both
  dialogs, with the token sent back, after which the reminder disappears.

Health Connect does not exist on Robolectric: the tests give
`HealthConnectAccess` a `FakeHealthConnectClient`, and a stand-in
`AndroidKeyStore` provider lets the unchanged `KeystoreCipher` save tokens.
The only network they reach is `FakeIngestServer`, a small HTTP server the
tests start on 127.0.0.1 (plain HTTP to it is allowed through the test-only
`EndpointPolicy.testHttpHost`, which the app never sets); everything else uses
`.example` names. `InfovoreApiHttpTest` drives the real `InfovoreApi` against
the same server on the plain JVM: method, path, `Authorization`, JSON body, 201
and reconcile answers, no retry on 400/401/409, the 409 refusal (counts,
`byOrigin`, `confirmToken`) taken from the shared contract fixture, retries
with backoff on 408/429/5xx including the server's `"retryable": true` 503,
`Retry-After` waited out up to 30 s and handed to the caller beyond that, an
immediate stop on a 503 marked `"retryable": false` (feature not configured),
and how a timeout or a refused connection is explained to the user.

The first-sync flow is also half of a cross-language chain test. It writes
every request the app sent, with the answer it was given, to
`tests/fixtures/android-sync-golden.json` (canonical JSON: sorted keys) and
fails when they differ from the committed file; `SyncEnvironment` fixes the
clock and batch ids so the run is byte-for-byte repeatable. The server's
`tests/android-chain.test.ts` replays the same requests into the real ingest
service, checks its answers against the recorded ones, and checks the public
pages (`/platforms/health`, `/`, `/status.json`, `/api/health.json`) for the
public summary and for any raw field (record ids, source package, device id,
notes, samples). After an intended change of what the app sends, regenerate
the file and commit it with a passing server test:

```sh
INFOVORE_UPDATE_GOLDEN=1 ./gradlew testDebugUnitTest --tests '*SyncFlowUiTest*'
``` They do not replace a
check on a real phone: system notification rendering, OEM background limits,
real Health Connect and TalkBack itself are not exercised.

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
`HealthController`, `ReconcileController`,
`SetupController`, sharing a `UiHost`), and every state → view decision lives
in the pure, unit-tested mappers in `ui/` (`HealthStatus`, `ReconcileStatus`,
`SetupProgress`, `FormState`, `MainPanels`).

The APK is written to `app/build/outputs/apk/debug/app-debug.apk`. GitHub Actions
also publishes it as the `infovore-health-debug` workflow artifact.
