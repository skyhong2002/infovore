#!/bin/sh
# Production rollout without an availability gap, on the existing Docker +
# Traefik setup. Run on the host from the production checkout:
#   git pull --ff-only && scripts/deploy.sh
#
# 1. Build the new image while production keeps serving.
# 2. Start one candidate container from it (docker-compose.candidate.yml): same
#    Traefik labels and data volume, reads only, no refreshes, no ingest. Its
#    healthcheck admits it to Traefik only after it is fully ready.
# 3. Only while the candidate serves alongside production, recreate the
#    production containers; the new one is likewise admitted only when ready.
# 4. Remove the candidate.
# Production is never stopped before a ready replacement is serving. If the
# candidate never gets ready it is removed and production is untouched; if the
# new production container does not get ready the candidate keeps serving and
# the rollback commands are printed.
set -eu
cd "$(dirname "$0")/.."

compose() { docker compose -f docker-compose.yml -f docker-compose.traefik.yml "$@"; }
candidate() { docker compose -p infovore-candidate -f docker-compose.yml -f docker-compose.traefik.yml -f docker-compose.candidate.yml "$@"; }
log() { echo "[deploy $(date -u +%H:%M:%S)] $*"; }

exec 9>/tmp/infovore-deploy.lock
flock -w 600 9 || { log 'another deploy holds /tmp/infovore-deploy.lock'; exit 1; }

# Healthy means the container has once been fully ready (see
# scripts/container-health.sh); confirm the same pages through it directly.
ready() {
  for _ in $(seq 1 300); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null)" = healthy ] && break
    [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = true ] || { log "$1 is not running"; return 1; }
    sleep 2
  done
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$1")" = healthy ] || { log "$1 never became ready"; return 1; }
  for path in /healthz / /now /stats; do
    for attempt in 1 2 3; do
      docker exec "$1" wget -qO /dev/null -T 10 "http://127.0.0.1:3000$path" && break
      [ "$attempt" = 3 ] && { log "$1: $path failed"; return 1; }
      sleep 5
    done
  done
  log "$1 ready"
}

# The candidate is one extra web app (~0.4 GiB), not a second stack.
available=$(awk '/^MemAvailable/ { print int($2 / 1024) }' /proc/meminfo)
[ "$available" -ge 1200 ] || { log "only ${available} MiB available; not starting a candidate"; exit 1; }
[ "$(docker inspect -f '{{.State.Health.Status}}' infovore)" = healthy ] || { log 'production is not healthy; deploy the plain way'; exit 1; }

current=$(git rev-parse --short HEAD)
rollback="infovore:rollback-$(date -u +%Y%m%d%H%M%S)"
docker tag "$(docker inspect -f '{{.Image}}' infovore)" "$rollback"
log "building $current; the running production image is kept as $rollback"
compose build

INFOVORE_DATA_VOLUME=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' infovore)
export INFOVORE_DATA_VOLUME
candidate up -d --no-build infovore
if ! ready infovore-candidate; then
  candidate down
  log 'candidate removed; production untouched'
  exit 1
fi

compose up -d --no-build
if ! ready infovore; then
  log 'new production container is not ready; the candidate keeps serving. To roll back:'
  log "  docker tag $rollback infovore:latest && git checkout ORIG_HEAD && docker compose -f docker-compose.yml -f docker-compose.traefik.yml up -d --no-build"
  log "  then, once infovore is healthy: INFOVORE_DATA_VOLUME=$INFOVORE_DATA_VOLUME docker compose -p infovore-candidate -f docker-compose.yml -f docker-compose.traefik.yml -f docker-compose.candidate.yml down"
  exit 1
fi
candidate down
log "deployed $current"
