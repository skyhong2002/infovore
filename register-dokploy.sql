begin;

insert into project ("projectId", name, description, "createdAt", env, "organizationId")
values (
  'kBXwKYfFI77Hjd6E',
  'status.skyhong.tw',
  'Live SVG status cards (Backloggd, Kitsu, stats.fm, Simkl, Goodreads)',
  '2026-07-08T00:00:00.000Z',
  '',
  'e5tHYty-_Hlq8XMTQxyhR'
)
on conflict ("projectId") do nothing;

insert into environment ("environmentId", name, description, "createdAt", "projectId", env, "isDefault")
values (
  'EI414BYqKK0zvStW',
  'production',
  null,
  '2026-07-08T00:00:00.000Z',
  'kBXwKYfFI77Hjd6E',
  '',
  true
)
on conflict ("environmentId") do nothing;

insert into compose (
  "composeId",
  name,
  "appName",
  description,
  env,
  "composeFile",
  "sourceType",
  "composeType",
  command,
  "composePath",
  "composeStatus",
  "createdAt",
  suffix,
  randomize,
  "isolatedDeployment",
  "environmentId",
  "enableSubmodules",
  "isolatedDeploymentsVolume"
)
values (
  'cXCF85GXlgyXoLXS',
  'status.skyhong.tw',
  'status-skyhong-dokploy',
  'Live SVG status cards (Backloggd, Kitsu, stats.fm, Simkl, Goodreads)',
  '',
  $compose$
services:
  status:
    build: .
    restart: unless-stopped
    env_file: .env
    networks:
      - dokploy-network
    labels:
      - traefik.enable=true
      - traefik.http.routers.status-skyhong.rule=Host(`status.skyhong.tw`)
      - traefik.http.routers.status-skyhong.entrypoints=websecure
      - traefik.http.routers.status-skyhong.tls.certresolver=letsencrypt
      - traefik.http.routers.status-skyhong-web.rule=Host(`status.skyhong.tw`)
      - traefik.http.routers.status-skyhong-web.entrypoints=web
      - traefik.http.routers.status-skyhong-web.middlewares=redirect-to-https@file
      - traefik.http.services.status-skyhong.loadbalancer.server.port=3000

networks:
  dokploy-network:
    external: true
$compose$,
  'raw',
  'docker-compose',
  '',
  './compose.yaml',
  'done',
  '2026-07-08T00:00:00.000Z',
  '',
  false,
  false,
  'EI414BYqKK0zvStW',
  false,
  false
)
on conflict ("composeId") do update set
  name = excluded.name,
  "appName" = excluded."appName",
  description = excluded.description,
  env = excluded.env,
  "composeFile" = excluded."composeFile",
  "sourceType" = excluded."sourceType",
  "composeType" = excluded."composeType",
  command = excluded.command,
  "composePath" = excluded."composePath",
  "composeStatus" = excluded."composeStatus",
  "environmentId" = excluded."environmentId";

insert into domain (
  "domainId",
  host,
  https,
  port,
  path,
  "createdAt",
  "certificateType",
  "serviceName",
  "domainType",
  "composeId",
  "internalPath",
  "stripPath",
  middlewares
)
values (
  '5QctUaOCheE71wa4',
  'status.skyhong.tw',
  true,
  3000,
  '/',
  '2026-07-08T00:00:00.000Z',
  'letsencrypt',
  'status',
  'compose',
  'cXCF85GXlgyXoLXS',
  '/',
  false,
  array[]::text[]
)
on conflict ("domainId") do update set
  host = excluded.host,
  https = excluded.https,
  port = excluded.port,
  "certificateType" = excluded."certificateType",
  "serviceName" = excluded."serviceName",
  "domainType" = excluded."domainType",
  "composeId" = excluded."composeId";

commit;
