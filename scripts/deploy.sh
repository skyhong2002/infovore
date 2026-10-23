#!/bin/sh
# Production rollout without an availability gap, on the existing Docker +
# Traefik setup. Run on the host from the production checkout:
#   git pull --ff-only && scripts/deploy.sh
#
# 1. Build the new image while production keeps serving.
# 2. Start one candidate container from it (docker-compose.candidate.yml): same
#    Traefik labels and data volume, reads only, no refreshes, no ingest. Its
#    healthcheck admits it to Traefik only after it is fully ready.
# 3. Only while the candidate serves alongside production, drain production
#    out of Traefik and recreate it; the new one is likewise admitted only when
#    ready.
# 4. Drain the candidate out of Traefik and remove it.
# Production is never stopped before a ready replacement is serving, and no
# container is stopped while Traefik still routes to it. If the
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
# scripts/container-health.sh); confirm it again with the same check.
ready() {
  for _ in $(seq 1 300); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null)" = healthy ] && break
    [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = true ] || { log "$1 is not running"; return 1; }
    sleep 2
  done
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$1")" = healthy ] || { log "$1 never became ready"; return 1; }
  for attempt in 1 2 3; do
    docker exec "$1" sh scripts/container-health.sh --ready && { log "$1 ready"; return 0; }
    sleep 5
  done
  log "$1 failed its readiness check"
  return 1
}

# Take a container out of Traefik before stopping it, so no request is cut. The
# drain file fails scripts/container-health.sh; replacing its ready marker with
# a directory also fails the first ready-once version (c83a93f), which predates
# the drain file. Docker then marks it unhealthy (3 failed probes) and Traefik
# drops it; wait out Traefik's provider throttle before the caller stops it.
# Fails closed: if the container cannot be shown to have left Traefik, the
# caller must not stop it.
drain() {
  docker exec "$1" sh -c 'touch /tmp/infovore-drain && rm -rf /tmp/infovore-ready && mkdir /tmp/infovore-ready' \
    || { log "$1: could not start draining it"; return 1; }
  for _ in $(seq 1 90); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$1")" = unhealthy ] && { sleep 5; log "$1 drained"; return 0; }
    sleep 2
  done
  log "$1 did not leave Traefik in 180 s"
  return 1
}

# Undo a (possibly partial) drain: the next probes re-qualify it as ready.
undrain_hint() {
  log "  docker exec $1 sh -c 'rm -f /tmp/infovore-drain; rmdir /tmp/infovore-ready 2>/dev/null; true'"
}
# Remove the candidate only once Traefik no longer routes to it.
candidate_removal_hint() {
  log "  docker exec infovore-candidate touch /tmp/infovore-drain, wait until 'docker inspect -f {{.State.Health.Status}} infovore-candidate' is unhealthy, then:"
  log "  INFOVORE_DATA_VOLUME=$INFOVORE_DATA_VOLUME docker compose -p infovore-candidate -f docker-compose.yml -f docker-compose.traefik.yml -f docker-compose.candidate.yml down"
}

traefik_labels() {
  docker inspect -f '{{range $k, $v := .Config.Labels}}{{$k}}={{$v}}{{println}}{{end}}' "$1" | grep '^traefik\.' | sort
}

# The candidate is one extra web app (~0.4 GiB), not a second stack.
available=$(awk '/^MemAvailable/ { print int($2 / 1024) }' "${INFOVORE_MEMINFO:-/proc/meminfo}")
[ "$available" -ge 1200 ] || { log "only ${available} MiB available; not starting a candidate"; exit 1; }
[ "$(docker inspect -f '{{.State.Health.Status}}' infovore)" = healthy ] || { log 'production is not healthy; deploy the plain way'; exit 1; }

current=$(git rev-parse --short HEAD)
rollback="infovore:rollback-$(date -u +%Y%m%d%H%M%S)"
docker tag "$(docker inspect -f '{{.Image}}' infovore)" "$rollback"
log "building $current; the running production image is kept as $rollback"
compose build

INFOVORE_DATA_VOLUME=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' infovore)
export INFOVORE_DATA_VOLUME
# Traefik merges identical router/service definitions from both containers but
# drops a router defined differently by two of them, which would take the site
# down. A change to the Traefik labels therefore cannot roll out this way.
# Failures from here on touch only the candidate project, or leave a ready
# candidate serving; nothing else on the host is stopped or removed.
if ! candidate up --no-start --no-build infovore; then
  candidate down || true
  log 'could not create the candidate; production untouched'
  exit 1
fi
production_labels=$(traefik_labels infovore || true)
if [ -z "$production_labels" ] || [ "$(traefik_labels infovore-candidate)" != "$production_labels" ]; then
  candidate down
  log 'Traefik labels changed; a candidate would conflict with production. Deploy the plain way.'
  exit 1
fi
if ! candidate up -d --no-build infovore || ! ready infovore-candidate; then
  candidate down || true
  log 'candidate removed; production untouched'
  exit 1
fi

if ! drain infovore; then
  log 'production could not be drained, so it was not stopped; production and the candidate both keep serving.'
  log 'Undo the drain on production, then remove the candidate:'
  undrain_hint infovore
  candidate_removal_hint
  exit 1
fi
# Recreate even if the image did not change: the drained container stays out
# of Traefik until it is replaced.
if ! compose up -d --no-build --force-recreate || ! ready infovore; then
  log 'new production container is not ready; the candidate keeps serving. To roll back:'
  log "  docker tag $rollback infovore:latest && git checkout ORIG_HEAD && docker compose -f docker-compose.yml -f docker-compose.traefik.yml up -d --no-build"
  log '  then, once infovore is healthy:'
  candidate_removal_hint
  exit 1
fi
if ! drain infovore-candidate; then
  log 'the candidate could not be drained, so it was not removed; it keeps serving alongside the new production container.'
  log 'Undo its drain, or retry the removal later:'
  undrain_hint infovore-candidate
  candidate_removal_hint
  exit 1
fi
candidate down
log "deployed $current"
