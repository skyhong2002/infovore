# Dayflow sync for macOS

The companion reads Dayflow's bundled **stdio MCP** (schema v1), then pushes one
complete day at a time to infovore. It never modifies the Dayflow database and
does not require exposing an MCP port or granting the server SSH access to a Mac.

## Server

Set a dedicated `DAYFLOW_TOKEN` (at least 32 random characters) in the shared
app/ingest environment. Include `dayflow` in `SOURCES` when using an explicit
source list. Redeploy both services. Endpoints:

- `GET /api/ingest/dayflow/status` — dedicated bearer token required.
- `POST /api/ingest/dayflow/days` — same token; one schema-v1 day, at most 2 MiB.
- `GET /api/dayflow.json` — public normalized snapshot and daily aggregates.
- `/platforms/dayflow`, `/card/dayflow.{svg,png,webp}` and `/cards`.
- `get_dayflow_summary` on the existing `/mcp` endpoint.

## Mac

Requires Dayflow with its bundled MCP helper and Node 22.13+ (or newer).

1. Create `~/Library/Application Support/infovore-dayflow` with mode 700.
2. Copy `dayflow-sync.mjs` and `dayflow-sync.example.json` there, renaming the
   example to `config.json`. Set the origin, dedicated token, stable device ID,
   and earliest Dayflow date. Protect `config.json` with mode 600.
3. In that directory run `npm init -y` then
   `npm install --save-exact @modelcontextprotocol/sdk@1.30.0`.
4. Run `node dayflow-sync.mjs config.json --backfill` once. Interrupted imports
   resume from `state.json`; it advances only after server acknowledgement.
5. Copy `dayflow-launchagent.plist` to `~/Library/LaunchAgents/tw.skyhong.infovore.dayflow.plist`,
   replacing every `/Users/YOUR_USER` and the Node executable with actual absolute
   paths. Load with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/tw.skyhong.infovore.dayflow.plist`.

The agent runs every 15 minutes while the user is logged in. Each run refreshes
seven recent dates and rotates through fourteen older dates. Historical edits
and deletions are therefore eventually reconciled, including days that become
empty. `--backfill` processes all remaining older dates in one run. A failed
request retains the cursor; network/server failures retry with bounded backoff.
A PID lock prevents overlapping runs. A 12-minute deadline leaves the next
scheduled run able to resume. Logs contain counts and errors, not raw activity
text or tokens. Use `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/tw.skyhong.infovore.dayflow.plist`
to stop syncing; this retains both archives.

## Data semantics

Raw titles, abbreviated MCP summaries, app names and record/device identifiers
remain in the dedicated `dayflow_days` SQLite table. They never enter generic
activities, feeds, search, public snapshots or cards. Detail write-ups,
screenshots and recordings are not imported. Public output contains category
names, colors and durations plus daily summaries on Home and Now. The platform,
card, JSON and MCP also publish recognized keywords from titles and abbreviated
summaries: tools, projects and topics matched by the local bilingual vocabulary
in `src/dayflow/keywords.ts`. The legacy weekly/daily lists only use the vocabulary. The recent pools also
discover repeated narrative terms (see below). Full sentences, URLs, email
addresses, paths and raw app lists are not published. No external AI service is called.

Each keyword counts at most once per device/record, ignoring idle, error,
zero-duration and future records. Weekly keywords follow the same Monday 4am
Taipei boundary as category totals. The legacy JSON list retains up to 36 weekly
keywords; recorded-day rows show up to 10 each. The page and keywords card use
the two rolling recent pools described below. Counts
are activity mentions, not time spent. Existing history is re-derived immediately;
no new import is required. New vocabulary can be added without changing storage.

Days start at **04:00 Asia/Taipei**, including weekly Monday boundaries.
Durations use clipped start/end intervals, merge overlapping records/devices,
and prefer analyzed active intervals over idle/error intervals. Error intervals
are reported separately and excluded from tracked time. Active means non-idle,
not Dayflow's focus score. Missing dates are not zero usage. The server replaces
each device/day atomically, ignores older or repeated observations, and keeps
last-good data when the Mac sleeps or disconnects. The source freshness status
measures the last successful sync, not the last screen capture.

Computer time can overlap music/video/game time, so it is not added to the
cross-platform time ledger or Wrapped activity counts. Category statistics on
the card are for the current Dayflow week; bars show seven most recent recorded
days. Dayflow has three separate cards: `dayflow` for time, `dayflow-keywords` for
narrative keywords, and `dayflow-categories` for category time and shares.
The platform shows 30 recorded days and JSON retains the full daily series.

## Recent keyword pools

`extra.keywordPools` exposes two independent rankings, separate from the legacy
current-week `extra.keywords` and daily keyword lists:

- `all`: up to 48 recent terms ordered by activity mentions, with no historical
  suppression. Habitual tools such as Discord and YouTube remain eligible.
- `distinctive`: up to 24 terms that are unusual compared with the previous
  90 calendar days. The keyword card shows 12 distinctive and 24 general terms.

Recent means the current Dayflow day plus the previous six (04:00 Taipei
boundaries). The comparison period excludes those seven days. Coverage dates,
recorded days and activity counts accompany both pools. Empty/missing days do
not inflate coverage; idle, error, future and zero-duration records are ignored.
Overlapping day imports deduplicate by device/record before splitting periods.

Candidates combine the bilingual tool aliases with dynamic word segmentation
and adjacent title phrases. Common narration, URLs, email addresses, paths,
code blocks and token-like identifiers are removed. A discovered term needs
at least two recent activities and a title occurrence. Full prose and raw app
lists remain private; repeated narrative terms themselves are public. Extraction
is statistical and may still produce imperfect phrases; it uses no external AI.

Distinctiveness requires at least 14 recorded historical days and 50 historical
activities. Otherwise status is `insufficient_history`, the distinctive pool is
empty, and the general pool still works. Eligible distinctive terms occur in
at least two recent activities, appear on fewer than 35% of historical days,
and have at least twice their historical activity mention rate. The historical
rate is smoothed as `(mentions + 0.5) / (activities + 1)`. Ranking uses
`log(1 + recent mentions) * log2(1 + rate lift) * (1 - historical day share)`.
This is relative to the observed baseline, not a claim of first-ever occurrence.
Both rankings are calculated before their independent display limits.
