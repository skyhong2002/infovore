#!/bin/sh
# Production rollout without an availability gap, on a Docker + Traefik host.
# Run on the host from the production checkout:
#   git pull --ff-only && scripts/deploy.sh [config]
#
# The optional config file (sourced; see scripts/deploy.sky-server.env) points
# the rollout at a stack other than this checkout's compose files:
#   INFOVORE_PRODUCTION         production web container   (default infovore)
#   INFOVORE_COMPOSE_PROJECT    its compose project        (default: compose's own)
#   INFOVORE_COMPOSE_FILES      its compose files as -f args
#   INFOVORE_CANDIDATE_OVERLAY  overlay that turns it into the candidate
#   INFOVORE_IMAGE              image tag both build and compose use (default infovore)
#   INFOVORE_DEPLOY_LOCK        lock file against concurrent deploys (default /tmp/infovore-deploy.lock)
#   INFOVORE_DEPLOY_LOG         also append the one-line deploy summary to this file (default: none)
#
# Availability probes (on by default): while the rollout runs, public pages are
# requested one at a time every PROBE_INTERVAL seconds with Accept: text/html,
# and once more each after it ends. The deploy output closes with
# "probes N, non-2xx M" and the first failures (time, path, status), so every
# deploy leaves a record of what visitors saw. Only public URLs; never secrets.
#   PROBE_ENABLED        0 turns the probes off (default 1)
#   PROBE_URLS           space-separated public URLs (default: /, /now and /status
#                        of PUBLIC_BASE_URL; without either the probes stay off)
#   PROBE_INTERVAL       seconds between probes (default 0.5)
#   PROBE_FAIL_ON_ERROR  1 makes any non-2xx probe fail the deploy (default 0:
#                        reported only)
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
if [ -n "${1:-}" ]; then
  [ -f "$1" ] || { echo "deploy config $1 not found" >&2; exit 1; }
  config=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
  # shellcheck disable=SC1090
  . "$config"
fi
cd "$(dirname "$0")/.."

PRODUCTION=${INFOVORE_PRODUCTION:-infovore}
PROJECT=${INFOVORE_COMPOSE_PROJECT:-}
FILES=${INFOVORE_COMPOSE_FILES:--f docker-compose.yml -f docker-compose.traefik.yml}
OVERLAY=${INFOVORE_CANDIDATE_OVERLAY:-docker-compose.candidate.yml}
IMAGE=${INFOVORE_IMAGE:-infovore}
# The candidate always gets its own project, never production's.
[ "$PROJECT" != infovore-candidate ] || { echo 'INFOVORE_COMPOSE_PROJECT must not be infovore-candidate' >&2; exit 1; }

# FILES is deliberately word-split into -f arguments (paths without spaces).
# shellcheck disable=SC2086
compose() { docker compose ${PROJECT:+-p "$PROJECT"} $FILES "$@"; }
# shellcheck disable=SC2086
candidate() { docker compose -p infovore-candidate $FILES -f "$OVERLAY" "$@"; }
compose_cmd="docker compose ${PROJECT:+-p $PROJECT }$FILES"
candidate_cmd="docker compose -p infovore-candidate $FILES -f $OVERLAY"
log() { echo "[deploy $(date -u +%H:%M:%S)] $*"; }

LOCK=${INFOVORE_DEPLOY_LOCK:-/tmp/infovore-deploy.lock}
exec 9>"$LOCK"
flock -w 600 9 || { log "another deploy holds $LOCK"; exit 1; }

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
  log "  INFOVORE_DATA_VOLUME=$INFOVORE_DATA_VOLUME $candidate_cmd down"
}

traefik_labels() {
  docker inspect -f '{{range $k, $v := .Config.Labels}}{{$k}}={{$v}}{{println}}{{end}}' "$1" | grep '^traefik\.' | sort
}

# The candidate is one extra web app (~0.4 GiB), not a second stack.
available=$(awk '/^MemAvailable/ { print int($2 / 1024) }' "${INFOVORE_MEMINFO:-/proc/meminfo}")
[ "$available" -ge 1200 ] || { log "only ${available} MiB available; not starting a candidate"; exit 1; }
[ "$(docker inspect -f '{{.State.Health.Status}}' "$PRODUCTION")" = healthy ] || { log 'production is not healthy; deploy the plain way'; exit 1; }

# Run as root (to read a root-only env_file), git would refuse a checkout owned
# by another user.
current=$(git -c safe.directory="$(pwd)" rev-parse --short HEAD)

# --- Availability probes -----------------------------------------------------
probe_dir=
probe_pid=
if [ "${PROBE_ENABLED:-1}" != 0 ]; then
  if [ -z "${PROBE_URLS:-}" ] && [ -n "${PUBLIC_BASE_URL:-}" ]; then
    base=${PUBLIC_BASE_URL%/}
    PROBE_URLS="$base/ $base/now $base/status"
  fi
  if [ -z "${PROBE_URLS:-}" ]; then
    log 'availability probes off: set PROBE_URLS (or PUBLIC_BASE_URL) in the deploy config'
  fi
fi
# One probe: "<UTC time> <path> <status>" (000 when no HTTP answer came back).
probe_once() {
  status=$(curl -s -o /dev/null -w '%{http_code}' -H 'Accept: text/html' --max-time 5 "$1" 2>/dev/null) || true
  path=/${1#*://*/}
  [ "$path" != "/$1" ] || path=/
  echo "$(date -u +%H:%M:%S) $path ${status:-000}" >> "$probe_dir/results"
}
# Round-robin over PROBE_URLS until the stop file appears, then one last probe
# of each URL: the state the rollout left behind.
probe_loop() {
  while [ ! -e "$probe_dir/stop" ]; do
    for url in $PROBE_URLS; do
      [ -e "$probe_dir/stop" ] && break
      probe_once "$url"
      sleep "${PROBE_INTERVAL:-0.5}"
    done
  done
  for url in $PROBE_URLS; do probe_once "$url"; done
}
# Stops the probes and prints (and optionally logs) the summary; runs on every
# exit once the probes started, so a failed rollout reports them too.
finish() {
  code=$?
  if [ -n "$probe_pid" ]; then
    touch "$probe_dir/stop"
    wait "$probe_pid" 2>/dev/null || true
    probe_pid=
    total=$(wc -l < "$probe_dir/results" | tr -d ' ')
    failures=$(awk '$3 !~ /^2[0-9][0-9]$/' "$probe_dir/results")
    failed=$(printf '%s' "$failures" | grep -c . || true)
    summary="probes $total, non-2xx $failed"
    log "availability: $summary"
    [ "$failed" = 0 ] || printf '%s\n' "$failures" | head -n 10 | while read -r at path status; do
      log "  $at $path $status"
    done
    [ "$failed" -le 10 ] || log "  … and $((failed - 10)) more"
    if [ -n "${INFOVORE_DEPLOY_LOG:-}" ]; then
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $current exit=$code $summary" >> "$INFOVORE_DEPLOY_LOG" \
        || log "could not append to $INFOVORE_DEPLOY_LOG"
    fi
    rm -rf "$probe_dir"
    if [ "$code" = 0 ] && [ "$failed" != 0 ] && [ "${PROBE_FAIL_ON_ERROR:-0}" = 1 ]; then
      log 'PROBE_FAIL_ON_ERROR=1 and a probe failed: reporting the deploy as failed'
      code=1
    fi
  fi
  exit "$code"
}
if [ "${PROBE_ENABLED:-1}" != 0 ] && [ -n "${PROBE_URLS:-}" ]; then
  probe_dir=$(mktemp -d "${TMPDIR:-/tmp}/infovore-probes.XXXXXX")
  : > "$probe_dir/results"
  trap finish EXIT
  trap 'exit 130' INT TERM
  # The probes must not keep holding the deploy lock (fd 9).
  probe_loop 9>&- &
  probe_pid=$!
  log "probing $PROBE_URLS every ${PROBE_INTERVAL:-0.5} s"
fi
rollback="${IMAGE%%:*}:rollback-$(date -u +%Y%m%d%H%M%S)"
docker tag "$(docker inspect -f '{{.Image}}' "$PRODUCTION")" "$rollback"
log "building $current as $IMAGE; the running production image is kept as $rollback"
# Running containers keep the image they were created from, so retagging only
# affects the candidate and the recreated production container.
docker build -q -t "$IMAGE" .

# Named-volume stacks pass the volume to the candidate overlay; bind-mount
# stacks leave this empty and their overlay does not use it.
INFOVORE_DATA_VOLUME=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$PRODUCTION")
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
production_labels=$(traefik_labels "$PRODUCTION" || true)
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

if ! drain "$PRODUCTION"; then
  log 'production could not be drained, so it was not stopped; production and the candidate both keep serving.'
  log 'Undo the drain on production, then remove the candidate:'
  undrain_hint "$PRODUCTION"
  candidate_removal_hint
  exit 1
fi
# Recreate even if the image did not change: the drained container stays out
# of Traefik until it is replaced.
if ! compose up -d --no-build --force-recreate || ! ready "$PRODUCTION"; then
  log 'new production container is not ready; the candidate keeps serving. To roll back:'
  log "  docker tag $rollback $IMAGE && git checkout ORIG_HEAD && $compose_cmd up -d --no-build"
  log "  then, once $PRODUCTION is healthy:"
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
