# status.skyhong.tw

Live status cards for my media-tracking accounts — Backloggd, Kitsu, stats.fm, Simkl.

A small Hono (Node.js) service that scrapes/fetches each source every 30 minutes,
caches the results in memory, and serves pre-rendered SVG cards.

## Endpoints

- `GET /` — service status overview (JSON)
- `GET /card/{backloggd|kitsu|statsfm|simkl}.svg` — SVG card
- `GET /api/{service}.json` — raw cached data
- `GET /healthz` — health check

## Development

```sh
npm install
npm run dev   # http://localhost:3000
```

Configuration via env vars — see `.env.example`. Everything has a working
default except `SIMKL_CLIENT_ID` (create an app at
https://simkl.com/settings/developer/).

## Deployment

Built for Dokploy: connect this repo, build with the `Dockerfile`, expose port
3000, set `SIMKL_CLIENT_ID`, and point `status.skyhong.tw` at it.
