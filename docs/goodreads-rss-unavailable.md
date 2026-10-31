# Goodreads RSS unavailable — issue #6

## Verified upstream evidence (2026-10-31)

Read-only, anonymous GETs from the SM development host at 04:31:04–04:31:10 UTC
(12:31 Asia/Taipei), using the adapter's exact committed default identifier
and User-Agent. No cookies, credentials, proxy rotation or challenge bypass.
Full response bodies were read, not just headers.

| Target | HTTP / effective response | Body evidence |
| --- | --- | --- |
| Configured `/user/show/<id>` | 200, `text/html; charset=utf-8` | Profile title, 83,372 decoded characters; no shelf RSS href; only `/opensearch.xml` matched RSS/XML links |
| Configured `/review/list_rss/<id>?shelf=read` | 404, `text/html; charset=utf-8` | `Page not found`, 57,137 decoded characters |
| Same, `currently-reading` | 404, same content type | `Page not found`, 57,298 decoded characters |
| Same, `to-read` | 404, same content type | `Page not found`, 57,435 decoded characters |
| Configured `/review/list/<id>?shelf=read` | Redirect followed to `/user/sign_in?returnurl=…`; final 200 HTML | `Sign in`, 12,975 decoded characters; not shelf data |
| Control `/review/list_rss/1?shelf=read` | 404 HTML | `Page not found`, 56,285 decoded characters |
| Legacy `/review/list/<id>.xml?shelf=read` | 401 HTML | Not an anonymous alternative; stopped here |

These samples alone do not prove permanent or site-wide withdrawal. However,
the Goodreads-owned announcement at
<https://www.goodreads.com/blog/show/20-more-rss-feeds> was independently fetched
from SM as HTTP 200, with its complete HTML body. Its visible update says:

> As of October 2026, RSS feeds have been discontinued.

It points users to My Books Import & Export. This is primary upstream evidence
of RSS withdrawal, not an inference from two users' 404s. No supported working
anonymous shelf feed was found. The profile's OpenSearch XML is a search
interface, not a replacement reading-history feed.

**Correction to earlier issue comments:** the public profile still contains
parseable counts. A separate full-body GET at this investigation returned
`read (6)`, `currently-reading (1)`, and `to-read (9)` in shelf links. The earlier
claim that profile counts were absent is not supported by the current body.
A profile response cannot replace the three feeds: the existing contract needs
book IDs, statuses, dates and ratings, not just totals or recent snippets.

## Minimal safe code repair

HTTP 404 already throws before persistence. Existing `refreshSource`,
`Repository.failSync` and `setCacheError` preserve the last-good snapshot,
publication timestamp, cards and activities while retaining the source error.
Do not duplicate that mechanism or clear the health error.

Two gaps in the adapter could still falsely publish an empty/zero snapshot if
an error or login page arrived with HTTP 200:

- `parseGoodreadsRss` treated any body without `<item>` as an empty shelf.
- Missing profile shelf counts silently became `0`.

The patch requires an RSS/channel envelope before accepting an empty shelf,
and rejects missing profile counts (explicit zero remains valid). This is a
response-shape guard, not a new general XML validator. The existing failure
path then retains stale data and reports unavailability. URLs, identifier,
retry behavior, scheduling, persistence and health thresholds are unchanged.

## Verification

- New parser test first failed with `Missing expected exception` on HTML/empty
  bodies; passed after the RSS guard.
- New missing-count test first failed with `Missing expected rejection`; passed
  after rejecting unknown counts.
- A third regression first failed when an undated shelf link borrowed the
  next link's count; count extraction is now bounded to that link's text.
- Focused coverage: 13 tests including subtests, all passed in the final full
  suite. They cover all three shelf URLs, exact identifier
  preservation, explicit zero, each missing count, genuine empty RSS, and the
  real adapter → refresh → SQLite/cache → `/healthz` path for HTTP 404, HTTP 200
  HTML, and missing profile counts. Last-good data and publication times stay
  unchanged; source errors remain visible and health remains degraded.
- `npm run check`: typecheck passed, 195/195 tests passed, exit 0 on Node
  v22.23.1. The suite emits SQLite/MockTimers/font warnings; the earlier full
  run also emitted `ERR_IPC_CHANNEL_CLOSED` from health-peer fixture shutdown
  without failing a test. No test fixture output represents a live Goodreads success.
- No environment, source enablement, platform replacement, deployment or
  production database changes. #6's live-refresh acceptance remains unmet.

## Remaining decision, not implemented

Restoring automatic RSS refresh is blocked by upstream withdrawal; this branch
cannot make it succeed. Do not merge/deploy under fix-only policy. Keep #6 open
until the original acceptance is satisfied or Sky explicitly revises it.
If Sky wants the upstream's export route, the smallest separate proposal is a
manual Goodreads CSV importer reusing the current persistence model with a
sample/export schema and explicit duplicate/status/date mapping tests. This
requires its own selection and authorization; “please fix all” does not select
CSV. No CSV importer, credentialed scraping or replacement platform is added.

## Development host limitation

The existing T3 thread was verified idle/settled and its project matched the
checkout, but dispatch failed with `SQLITE_FULL`. `df` showed the SM `/home`
partition at 100% (0 available). No user files were removed, no T3 restart and
no disk-reserve changes were attempted. Work and tests therefore ran in a
separate controller scratch clone of the exact `origin/main` commit `cc4428e`;
the original checkout/worktree and their existing untracked work were preserved.
