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
- `GET /card/{name}.svg` — SVG card (see card list above)
- `GET /api/{service}.json` — raw cached data
- `GET /healthz` — health check

## Development

```sh
npm install
npm run dev   # http://localhost:3000
```

Configuration via env vars — see `.env.example`. Everything has a working
default except `SIMKL_CLIENT_ID` (create an app at
https://simkl.com/settings/developer/) and `SIMKL_ACCESS_TOKEN` (device PIN
flow: `GET https://api.simkl.com/oauth/pin?client_id=...`, enter the code at
https://simkl.com/pin, then poll `GET /oauth/pin/{user_code}?client_id=...`).

## Deployment

Runs on my Oracle Cloud VM alongside a [Dokploy](https://dokploy.com) stack,
sharing its Traefik ingress via labels in `compose.yaml`:

```sh
git clone https://github.com/skyhong2002/status.skyhong.tw.git
cd status.skyhong.tw
echo "SIMKL_CLIENT_ID=..." > .env
docker compose up -d --build
```

TLS certificates are issued automatically by Traefik (Let's Encrypt).
