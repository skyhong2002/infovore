# infovore delivery tracker

This is the authoritative implementation checklist. Items move to complete
only after tests pass and the production endpoint is verified.

## P1 — usable public lifelog

- [x] Public profile and `/now` page driven by persisted activities
- [x] Filterable, paginated JSON timeline
- [x] RSS feed with stable ids and public-only entries
- [x] Manual/private event ingestion with bearer authentication
- [x] Upcoming and recent events on `/now`
- [x] Public event-page metadata enrichment without ticket-wallet scraping

## P2 — query and recap

- [x] Production-compatible MCP Streamable HTTP endpoint
- [x] MCP tools for recent activity, search, current media, upcoming events,
      and annual summaries
- [x] Annual cross-media Wrapped JSON API
- [x] Human-readable yearly Wrapped page

## P3 — reliability and delivery

- [x] Migration and query tests for every new data path
- [x] Endpoint, authentication, RSS, MCP, and Wrapped tests
- [x] README configuration and API documentation
- [x] CI, Docker build, persistent-volume restart, and production smoke tests
- [x] Commit, push, deploy, and verify every public endpoint

## Deferred by design

These are not implementation gaps: they require owner credentials or an
external account connection and are represented by the authenticated ingest
boundary above.

- Gmail purchase-email connector authorization
- Google Calendar connector authorization
- Platform-specific OPENTIX/KKTIX account or ticket-wallet automation

Ticket QR codes, order numbers, seats, and payment data must never enter the
public activity store. Logged-in ticket-wallet scraping is intentionally out
of scope; public event pages are enrichment sources only.
