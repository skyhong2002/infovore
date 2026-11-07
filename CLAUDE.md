# infovore — project defaults

## Workflow default (Sky's standing preference)

After completing any implementation task: run `npm run check`, then **commit,
push to `main`, and deploy to production — without asking first**. Report the
verification results (tests + a spot-check of the live site) when done.

- Stage files explicitly; never commit `.DS_Store` or scratch files.
- Commit messages: short imperative subject matching the existing history.

## Deploy

Pushing to `main` does **not** auto-deploy (CI only runs checks). Production
(https://infovore.skyhong.tw) runs on **sky-server**
(`sky@sky-server.tailf76d1d.ts.net`, Tailscale), as Dokploy compose project
`compose-calculate-online-port-oqidr1`. Nothing of infovore remains on the
`skyhong.tw` box.

- Compose: `/etc/dokploy/compose/compose-calculate-online-port-oqidr1/code/docker-compose.yml`
  (services `infovore` + `ingest`, image `blog-svc-infovore:production`; Dokploy's
  stored copy in its Postgres uses the same fixed tag).
- Env/secrets: `/srv/infovore/service.env` (root, mode 600; use `sudo -n`).
  Dokploy's `/etc/dokploy/compose/compose-calculate-online-port-oqidr1/service.env`
  is a symlink to this canonical file. Never print values or commit credentials.
  It lives outside `code/`, so a Dokploy redeploy does not overwrite it.
- Dayflow semantic topics use the dedicated `infovore` client key managed on
  sky-mini by `~/Projects/ai-gateway/apply.py`. Set `DAYFLOW_AI_BASE_URL` to
  `http://172.17.0.1:8317/v1` and `DAYFLOW_AI_MODEL=sky-quality`. sky-server
  runs HA ingress only; never add a gateway engine there.
- Data: `/srv/infovore/data/infovore.sqlite` (bind mount). Back up before a
  migration with `VACUUM INTO '/data/infovore-pre-<change>-<UTC ts>.sqlite'`
  run inside the container (`node:sqlite`).
- Build source: `~/Projects/infovore` on sky-server (git checkout of this repo).

Deploy with the gapless rollout (builds `:production`, keeps the old image as
`blog-svc-infovore:rollback-<ts>`, serves from a ready candidate while
production is recreated; see README, "Production rollout without a gap"):

```sh
ssh sky@sky-server.tailf76d1d.ts.net 'cd ~/Projects/infovore && git pull --ff-only && sudo -n scripts/deploy.sh scripts/deploy.sky-server.env'
```

If it refuses (production unhealthy, low memory, Traefik labels changed), fall
back to the plain recreate, which has a ~1 min cold warm-up gap:
`docker build -t blog-svc-infovore:production .` then
`sudo -n docker compose -p compose-calculate-online-port-oqidr1 -f <compose above> up -d`.
Prune old `rollback-*` tags once a deploy has proven stable.

Verify after deploying: `curl https://infovore.skyhong.tw/healthz` should be
`healthy`, and spot-check whatever pages the change touched. Schema migrations
run automatically on boot.
