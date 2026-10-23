#!/bin/sh
# Container healthcheck for the web app. Traefik routes only to healthy
# containers, so this decides when a container receives traffic.
#
# Until the container has once been fully ready (gateway /healthz healthy or
# degraded, a real homepage snapshot, and backend-rendered pages through the
# gateway: every path in ready_paths) it reports unhealthy: a new container
# never takes requests it could only answer with 503, and a rollout candidate
# joins only when it can serve. `--ready` runs just that check, without the
# marker, for scripts/deploy.sh, so admission and deploy verification agree.
# After that it reports gateway liveness only, so a later backend stall or stale
# upstream keeps the gateway's explicit 503s and last-good homepage reachable
# instead of turning into an edge 404. The marker holds PID 1's start time, so a
# restarted container has to qualify again.
#
# scripts/deploy.sh drains a container before stopping it by creating the drain
# file: the check then fails, Docker marks the container unhealthy and Traefik
# stops routing to it, so stopping it cuts no requests.
base="http://127.0.0.1:${PORT:-3000}"
marker="${INFOVORE_READY_FILE:-/tmp/infovore-ready}"
ready_paths='/healthz / /now /stats'
check_ready() {
  for path in $ready_paths; do
    wget -qO /dev/null -T 4 "$base$path" || return 1
  done
}
[ "${1:-}" = --ready ] && { check_ready; exit; }
[ -e "${INFOVORE_DRAIN_FILE:-/tmp/infovore-drain}" ] && exit 1
# Field 22 of /proc/1/stat, counted after the parenthesised command name.
boot=$(sed 's/.*) //' /proc/1/stat | cut -d' ' -f20)
if [ "$(cat "$marker" 2>/dev/null)" = "$boot" ]; then
  exec wget -qO /dev/null -T 4 "$base/livez"
fi
check_ready || exit 1
echo "$boot" > "$marker"
