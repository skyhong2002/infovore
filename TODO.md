# infovore delivery tracker

This is the authoritative implementation checklist. Items move to complete
only after tests pass and the production endpoint is verified.

## P1 — usable public lifelog

- [ ] Public profile and `/now` page driven by persisted activities
- [ ] Filterable, paginated JSON timeline
- [ ] RSS feed with stable ids and public-only entries
- [ ] Manual/private event ingestion with bearer authentication
- [ ] Upcoming and recent events on `/now`
- [ ] Public event-page metadata enrichment without ticket-wallet scraping

## P2 — query and recap

- [ ] Production-compatible MCP Streamable HTTP endpoint
- [ ] MCP tools for recent activity, search, current media, upcoming events,
      and annual summaries
- [ ] Annual cross-media Wrapped JSON API
- [ ] Human-readable yearly Wrapped page

## P3 — reliability and delivery

- [ ] Migration and query tests for every new data path
- [ ] Endpoint, authentication, RSS, MCP, and Wrapped tests
- [ ] README configuration and API documentation
- [ ] CI, Docker build, persistent-volume restart, and production smoke tests
- [ ] Commit, push, deploy, and verify every public endpoint

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
