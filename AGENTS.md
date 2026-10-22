# infovore — project defaults

## Workflow default (Sky's standing preference)

After completing any implementation task: run `npm run check`, then **commit,
push to `main`, and deploy to production — without asking first**. Report the
verification results (tests + a spot-check of the live site) when done.

- Stage files explicitly; never commit `.DS_Store` or scratch files.
- Commit messages: short imperative subject matching the existing history.

## Deploy

Pushing to `main` does **not** auto-deploy (CI only runs checks). Production
is a docker-compose stack on the Dokploy box behind the `skyhong.tw` SSH
alias, serving https://infovore.skyhong.tw:

```sh
ssh skyhong.tw 'cd /home/ubuntu/apps/status.skyhong.tw && git pull --ff-only && docker compose -f docker-compose.yml -f docker-compose.traefik.yml up -d --build'
```

Verify after deploying: `curl https://infovore.skyhong.tw/healthz` should be
`healthy`, and spot-check whatever pages the change touched. The SQLite data
volume survives rebuilds; schema migrations run automatically on boot.
