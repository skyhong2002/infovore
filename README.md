# status.skyhong.tw

Live, self-refreshing status cards for my media-tracking accounts — each themed
after its source site. **[See them live →](https://status.skyhong.tw)**

<table>
  <tr>
    <td width="50%" valign="top"><a href="https://status.skyhong.tw"><img width="100%" alt="Backloggd" src="https://status.skyhong.tw/card/backloggd.webp"></a></td>
    <td width="50%" valign="top"><a href="https://status.skyhong.tw"><img width="100%" alt="stats.fm" src="https://status.skyhong.tw/card/statsfm.webp"></a></td>
  </tr>
  <tr>
    <td width="50%" valign="top"><a href="https://status.skyhong.tw"><img width="100%" alt="Kitsu" src="https://status.skyhong.tw/card/kitsu.webp"></a></td>
    <td width="50%" valign="top"><a href="https://status.skyhong.tw"><img width="100%" alt="Simkl" src="https://status.skyhong.tw/card/simkl.webp"></a></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><a href="https://status.skyhong.tw"><img width="50%" alt="Goodreads" src="https://status.skyhong.tw/card/goodreads.webp"></a></td>
  </tr>
</table>

Eleven cards in total — combined and single-medium variants:
`backloggd` (10 recent games), `kitsu` / `kitsu-anime` / `kitsu-manga`,
`statsfm` / `statsfm-albums` / `statsfm-artists`,
`simkl` / `simkl-shows` / `simkl-movies`, `goodreads`.

A small [Hono](https://hono.dev) (Node.js) service that scrapes/fetches each
source on a schedule, caches results in memory, and renders each card with
[Satori](https://github.com/vercel/satori). Every card is served as **svg**
(vector), **png**, or **webp** — the previews above use webp (≈10× smaller than
the SVG), so this page loads fast.

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
