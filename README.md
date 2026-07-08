# status.skyhong.tw

Live SVG status cards for my media-tracking accounts — each themed after its
source site, refreshed every 30 minutes.

| | |
|---|---|
| ![Backloggd](https://status.skyhong.tw/card/backloggd.svg) | ![stats.fm](https://status.skyhong.tw/card/statsfm.svg) |
| ![Kitsu](https://status.skyhong.tw/card/kitsu.svg) | ![Simkl](https://status.skyhong.tw/card/simkl.svg) |
| ![Goodreads](https://status.skyhong.tw/card/goodreads.svg) | |

Eleven cards in total — combined and single-medium variants:
`backloggd` (10 recent games), `kitsu` / `kitsu-anime` / `kitsu-manga`,
`statsfm` / `statsfm-albums` / `statsfm-artists`,
`simkl` / `simkl-shows` / `simkl-movies`, `goodreads`.

A small [Hono](https://hono.dev) (Node.js) service that scrapes/fetches each
source on a schedule, caches results in memory, and serves SVG cards rendered
with [Satori](https://github.com/vercel/satori) — cover art and posters are
inlined as data URIs, so each card is a single self-contained image.

## Sources

| Service | Method |
|---|---|
| [Backloggd](https://backloggd.com/u/skychopath/) | HTML scrape (no public API) |
| [Kitsu](https://kitsu.app/users/skyhong2002) | Official JSON:API |
| [stats.fm](https://stats.fm/skyhong2002) | Public API |
| [Simkl](https://simkl.com) | Official API (client ID + OAuth token via PIN flow) |
| [Goodreads](https://www.goodreads.com/user/show/160195773-skychopath) | Shelf RSS feeds + profile scrape |

## Endpoints

- `GET /` — card gallery (responsive HTML)
- `GET /status` — service status overview (JSON)
- `GET /card/{name}.{svg,png,webp}` — a card; `?scale=1..3` for raster (default 2)
- `GET /api/{service}.json` — raw cached data
- `GET /healthz` — health check

Each card comes in three formats: **svg** (vector, sharpest), **png** (lossless
raster), and **webp** (smallest — ~10× smaller than the SVG, what the home page
uses). Embed anywhere with `<img src="…/card/kitsu.webp">`.

## Run it yourself (Docker)

```sh
git clone https://github.com/skyhong2002/status.skyhong.tw.git
cd status.skyhong.tw
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
in `.env` and add the overlay:

```sh
docker compose -f docker-compose.yml -f docker-compose.traefik.yml up -d --build
```

## Development

```sh
npm install
npm run dev   # http://localhost:3000
```
