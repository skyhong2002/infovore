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
`compose-calculate-online-port-oqidr1`. It is *not* on the `skyhong.tw` box
any more; the checkout and volume left there are stale.

- Compose: `/etc/dokploy/compose/compose-calculate-online-port-oqidr1/code/docker-compose.yml`
  (services `infovore` + `ingest`, prebuilt image `blog-svc-infovore:<YYYYMMDD>`).
- Env/secrets: `…/oqidr1/service.env` (root; use `sudo -n`). Never print values.
- Data: `/srv/infovore/data/infovore.sqlite` (bind mount). Back up before a
  migration with `VACUUM INTO '/data/infovore-pre-<change>-<UTC ts>.sqlite'`
  run inside the container (`node:sqlite`).
- Build source: `~/Projects/infovore` on sky-server (git checkout of this repo).

```sh
ssh sky@sky-server.tailf76d1d.ts.net '
  cd ~/Projects/infovore && git pull --ff-only &&
  docker build -q -t blog-svc-infovore:YYYYMMDD . &&
  D=/etc/dokploy/compose/compose-calculate-online-port-oqidr1/code &&
  sudo -n sed -i "s/blog-svc-infovore:[0-9]*/blog-svc-infovore:YYYYMMDD/g" $D/docker-compose.yml &&
  cd $D && sudo -n docker compose -p compose-calculate-online-port-oqidr1 -f docker-compose.yml up -d'
```

Dokploy stores its own copy of this compose file and env. A redeploy from the
Dokploy UI rewrites both files, so keep the image tag and env in the Dokploy UI
in step with any manual edits. Restarts have a cold warm-up of ~1 min;
`scripts/deploy.sh`'s gapless rollout targets the old layout and is not wired
up here.

Verify after deploying: `curl https://infovore.skyhong.tw/healthz` should be
`healthy`, and spot-check whatever pages the change touched. Schema migrations
run automatically on boot.
