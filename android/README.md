# Infovore Health for Android

This private companion (current version 0.5.0) reads selected records from Android Health Connect and
uploads them to infovore's authenticated ingest service. Garmin Connect can
write its activity and wellness records to Health Connect on Android 14+; this
app then transports those records to infovore without handling Garmin or
Google account credentials.

## Daily app (0.5.0)

Layout references NYCU LIFE Super App's native grouped content, icon navigation,
20dp insets, 24dp card corners, and unfilled section headings with trailing
named actions. Infovore keeps its own brand palette and assets.

The launcher opens a reading home with four bottom destinations: **首頁**, **瀏覽**,
**手機足跡**, and **設定**. Browse shows a native list of recent public
activities, with music/video/reading/event filters and links to platform details
inside the app; links
outside its HTTPS origin open in the browser. No ingest tokens enter the WebView.
Settings remain in a separate screen, reachable from the bottom navigation and status cards;
notification and Health Connect permission intents still open the relevant settings.

手機足跡 is an owner-only activity timeline: select a date to see activity titles,
summaries, app names, category totals and pending/retrying server observations.
It uses the saved phone token bound to the current ingest destination and filters
to this installation's device id. Reading never enables recording. Cards live only
in memory and are cleared when the app stops; refresh or returning to the app
reloads them. The home shows the latest two cards for the current 4am-based day.

The web equivalent is `/phone`, linked in the site's navigation and Dayflow page.
Unlock it with `DAYFLOW_PHONE_TOKEN` to browse all of the owner's phone devices;
the token and cards stay in tab memory, never local/session storage or URLs.
The authenticated read endpoints are `/api/phone/activity` (web service) and
`/api/ingest/dayflow-phone/activity` (ingest service), with optional `day=YYYY-MM-DD`
and `deviceId`. Responses are `no-store`, `noindex` and vary on Authorization.
Days run from 04:00 Asia/Taipei; cross-boundary cards are clipped, newest first,
with an explicit truncation flag above 1,000 cards. Raw captures are never returned.

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
  worker retries with WorkManager's backoff, at most four times a period. The
  screen-record upload follows the same rules; after a long `Retry-After` the
  worker and the recording service send nothing until that time, while
  **立即上傳** always tries.
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
  successful full sync resets the count and removes the notification. The same
  switch also covers the screen recorder's quarantine (see 手機 Dayflow).
  Since 0.4.4 a warning that already applies when notifications are turned on
  (the switch, or the permission granted) is shown at once, once: three or more
  failed background syncs, or a quarantine at 80% or full. A warning counts as
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
items older than seven days are dropped, except while a full quarantine stops
uploads, see below) and uploaded in batches of at most 40
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
at most 500 records: at that size every upload stops and the section says so
(also on its collapsed header, **上傳已停止**) until the user puts records back
or deletes them. Quarantined records are never deleted automatically. Since
0.4.3 the time uploads stay stopped does not count toward the current
destination's seven-day limit (the queue persists the stop period in
`screen-queue/age-hold`), so records waiting only because of the stop are not
dropped for their age, and after the user deals with the quarantine they get
the rest of their seven days to upload. The 40 MB cap still applies throughout
and drops the oldest records first, so a stop lasting long enough still loses
records; records of other destinations keep the plain seven-day rule.
Since 0.4.5 the queue keeps a lasting count of what it dropped before upload,
in `screen-queue/drop-log` (counts and times only, never content, app names or
destinations): how many records were dropped for being older than seven days,
how many by the 40 MB cap, and when each last happened. The section shows
**已因過期淘汰 N 筆、因容量淘汰 M 筆（最近：…）** (and **已淘汰 N 筆** on the
collapsed header) until the user presses **重設淘汰計數** and confirms; a
successful upload, an app restart or the user's own deletions never clear or
add to it. If more records are dropped between showing the counts and the
confirmation, nothing is reset and the new counts are shown first. The
quarantine warns once at 80% (400 records, **被拒收 N 筆** on the collapsed
header) and once when full: with **同步失敗時通知我** on and the permission
granted, a notification on the **同步問題** channel (counts only: rejected and
pending records, never screen content or app names) opens this section, and is
removed once the user brings the quarantine back down. With notifications off,
the section shows the state and suggests turning them on; turning them on then
delivers the current warning once (0.4.4). If the opt-in is on but Infovore's
notifications or the channel are off in system settings, the section says so
instead, and the warning is delivered once they are back on (0.4.5). If every record of a
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
  steps, connection, health, the reconcile reminder, the screen recorder):
  visible texts, which sections start collapsed, TalkBack headings, state
  descriptions and field errors, that every visible control is at least 48 dp,
  field validation, the unsaved-changes dialog on back, the stale-sync warning,
  the notification tap's section, the drop-log box and its reset; and that the
  screen renders at font scale 1.3 in dark mode.
- `NotificationsTest` checks what reaches Android's NotificationManager:
  channel, text without secrets, the tap's target and extra, private
  visibility, and that a warning blocked by the permission, Infovore's
  notifications or the channel is not counted and is delivered once allowed.
- `BackgroundWorkTest` uses WorkManager's test driver: both periodic works are
  scheduled at start-up with a network constraint, `SyncWorker` retries while a
  manual sync holds the lock, and a failure that needs the user counts toward
  the warning at once.
- `BackgroundRetryTest` runs the real `SyncWorker` and `ScreenUploadWorker`
  against `FakeIngestServer`: 400/401/403, a 503 marked not retryable, a refused
  endpoint and missing permissions end the run without a retry; a retryable 503
  retries with backoff and counts only the last attempt; `Retry-After` in
  seconds or as an HTTP date is waited out inside the run, left to WorkManager's
  backoff, or turned into a follow-up run at the server's time (capped at six
  hours, never chained, cancelled by a later success); screen uploads wait for
  it except on 「立即上傳」. `RetryPolicyTest` covers the parsing (injected
  clock, invalid values) and every plan.
- `SyncFlowUiTest` runs the two main flows end to end in the app: pressing
  「立即同步」 on a first run (real `SyncRunner`, `HealthSyncEngine`,
  `HealthConnectReader` and `InfovoreApi`, synthetic records in the fake Health
  Connect) until the screen shows the finished sync and completed setup; and a
  reconcile window the server refuses (HTTP 409 with counts, source apps and a
  confirm token) shown as a reminder with its sources, deleted only after both
  dialogs, with the token sent back, after which the reminder disappears.
- `ScreenUploadHttpTest` sends queued screen observations through the real
  `ScreenUploader`: endpoint, phone token, body, a rejected observation
  quarantined while the rest uploads, and a refused token keeping the queue.

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
`HealthController`, `ReconcileController`, `ScreenController`,
`SetupController`, sharing a `UiHost`), and every state → view decision lives
in the pure, unit-tested mappers in `ui/` (`HealthStatus`, `ReconcileStatus`,
`ScreenStatus`, `SetupProgress`, `FormState`, `MainPanels`).

The APK is written to `app/build/outputs/apk/debug/app-debug.apk`. GitHub Actions
also publishes it as the `infovore-health-debug` workflow artifact.
