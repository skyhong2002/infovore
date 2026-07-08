# infovore

A personal media lifelog — aggregating what I play, watch, read, and listen
to, rendered as live status cards (and more to come).
**[See the cards live →](https://infovore.skyhong.tw)**

<table>
  <tr>
    <td width="50%" valign="top"><a href="https://infovore.skyhong.tw"><img width="100%" alt="Backloggd" src="https://infovore.skyhong.tw/card/backloggd.webp"></a></td>
    <td width="50%" valign="top"><a href="https://infovore.skyhong.tw"><img width="100%" alt="stats.fm" src="https://infovore.skyhong.tw/card/statsfm.webp"></a></td>
  </tr>
  <tr>
    <td width="50%" valign="top"><a href="https://infovore.skyhong.tw"><img width="100%" alt="Kitsu" src="https://infovore.skyhong.tw/card/kitsu.webp"></a></td>
    <td width="50%" valign="top"><a href="https://infovore.skyhong.tw"><img width="100%" alt="Simkl" src="https://infovore.skyhong.tw/card/simkl.webp"></a></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><a href="https://infovore.skyhong.tw"><img width="50%" alt="Goodreads" src="https://infovore.skyhong.tw/card/goodreads.webp"></a></td>
  </tr>
</table>

## Architecture

The data is the point — cards are just the first way to look at it. The code
is split into three layers so a new source or a new way of presenting the
data can be added independently:

```
sources/  ──fetch + normalize──▶  data/  ──read-only──▶  output/
(one file per platform)        (unified model, cache)    (one file per format)
```

- **`src/sources/`** — one module per platform. Each fetches/scrapes its
  source and normalizes the result into a `SourceSnapshot` (see below). All
  the platform-specific mess (HTML scraping, Anubis proof-of-work solving,
  OAuth, JSON:API quirks) is contained here and never leaks past this layer.
- **`src/data/`** — `types.ts` defines the unified model every source
  produces and every output consumes; `cache.ts` is the in-memory store
  (keyed by source/card name, refreshed on a timer, holds the last-good
  value on fetch errors).
- **`src/output/`** — one module per rendered format. Today that's Satori
  SVG/PNG/WebP cards; each card reads only `SourceSnapshot` fields, never a
  source's raw shape.

The unified model (`src/data/types.ts`):

- **`MediaEntry`** — one normalized activity item: `source`, `kind` (game /
  anime / manga / movie / show / book / music), `title`, `image`, `status`,
  `activityAt`, `rating`, and a small `extra` bag for the long tail that
  doesn't generalize (platform/playtime, episode counts, author, ...).
- **`SourceSnapshot<TExtra>`** — one refresh cycle's worth of data for a
  source: `profile`, headline `stats` counters, the normalized `entries`,
  and a typed `extra` for whatever genuinely doesn't fit `entries`/`stats`
  (e.g. stats.fm's weekly top-albums/top-artists leaderboard has no
  per-item date, so it isn't an "entry").

**Adding a source**: add `src/sources/<name>.ts` exporting a
`fetch<Name>(): Promise<SourceSnapshot<...>>`, register it in the
`fetchers` map in `src/index.ts`. No output module needs to change.

**Adding an output**: add a module under `src/output/` that reads
`SourceSnapshot` and register it (in `src/index.ts`'s `cards` map, or its
own registry for a non-card output like a feed). No source module needs to
change.

## Sources

| Service | Method |
|---|---|
| [Backloggd](https://backloggd.com/u/skychopath/) | HTML scrape (no public API) |
| [Kitsu](https://kitsu.app/users/skyhong2002) | Official JSON:API |
| [stats.fm](https://stats.fm/skyhong2002) | Public API |
| [Simkl](https://simkl.com) | Official API (client ID + OAuth token via PIN flow) |
| [Goodreads](https://www.goodreads.com/user/show/160195773-skychopath) | Shelf RSS feeds + profile scrape |

## Cards

Eleven cards in total — combined and single-medium variants:
`backloggd` (10 recent games), `kitsu` / `kitsu-anime` / `kitsu-manga`,
`statsfm` / `statsfm-albums` / `statsfm-artists`,
`simkl` / `simkl-shows` / `simkl-movies`, `goodreads`.

Each card is served as **svg** (vector), **png**, or **webp** — the previews
above use webp (≈10× smaller than the SVG), so this page loads fast.

## Endpoints

- `GET /` — card gallery (responsive HTML)
- `GET /status` — service status overview (JSON)
- `GET /card/{name}.{svg,png,webp}` — a card; `?scale=1..3` for raster (default 2)
- `GET /api/{source}.json` — a source's normalized `SourceSnapshot` (raw cached data)
- `GET /healthz` — health check

Embed a card anywhere with `<img src="…/card/kitsu.webp">`.

## Run it yourself (Docker)

```sh
git clone https://github.com/skyhong2002/infovore.git
cd infovore
cp .env.example .env      # then edit .env with YOUR accounts
docker compose up -d --build
```

Open <http://localhost:3000>. That's it — no other services required.

Set only the sources you use via `SOURCES` in `.env` (e.g. `SOURCES=kitsu,statsfm`);
the rest are hidden. Every account id/username is an env var — see the comments
in `.env.example`, including how to get a Simkl client id + OAuth token.

### Behind a reverse proxy

For TLS + a custom domain via [Traefik](https://traefik.io) (e.g. a
[Dokploy](https://dokploy.com) stack sharing a `dokploy-network`), set `DOMAIN`
in `.env` (and optionally `LEGACY_DOMAIN` for an old domain that now CNAMEs
here, to keep both working during a migration) and add the overlay:

```sh
docker compose -f docker-compose.yml -f docker-compose.traefik.yml up -d --build
```

## Development

```sh
npm install
npm run dev   # http://localhost:3000
```

## Roadmap

Planning, not a commitment — rough order:

1. **More sources.** Private sources (ones with no public API/profile) will
   go through a separate upload/ingest service that turns them into
   something this app can pull from, rather than baking private scraping
   into this repo.
2. **Public profile page and a `/now` page.**
3. **RSS / JSON feed** of the normalized activity log.
4. **MCP server** exposing the lifelog as queryable context for AI agents —
   "what has Sky played/watched/read recently."
5. **Annual cross-media Wrapped** — a yearly recap spanning every source.
