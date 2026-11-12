#!/usr/bin/env bash
# Builds the dashboard image for the server's architecture, sends it over SSH and swaps it in, with a backup of the dashboard's
# database and an automatic return to the previous version when the new one does not become healthy.
#
#   scripts/deploy-dashboard.sh HOST [--dir /opt/keelson-dashboard] [--service dashboard] [--platform linux/amd64] [--wait 90] [--allow-dirty]
#
# HOST is anything `ssh` resolves (an alias of ~/.ssh/config), for a user that can `sudo` without a password. On the server,
# DIR holds the compose file with `image: keelson-dashboard:<tag>` (docs/hosting.md). The tag is the commit's short
# SHA, so what runs is always traceable to a commit. Run it from a clean checkout of the commit to deploy.
#
# The dashboard also carries the agent's binaries: after this, a server whose agent is older shows "update available".
# The agent keeps running meanwhile; apps are not touched.
set -euo pipefail

DIR=/opt/keelson-dashboard
SERVICE=dashboard
PLATFORM=linux/amd64
ALLOW_DIRTY=0
WAIT=90

die() { echo "deploy-dashboard: $*" >&2; exit 1; }
say() { echo "deploy-dashboard: $*"; }

[ $# -ge 1 ] || die "usage: $0 HOST [--dir DIR] [--service NAME] [--platform linux/amd64] [--wait SECONDS] [--allow-dirty]"
HOST=$1; shift
while [ $# -gt 0 ]; do
  case $1 in
    --dir) DIR=${2:?}; shift 2 ;;
    --service) SERVICE=${2:?}; shift 2 ;;
    --platform) PLATFORM=${2:?}; shift 2 ;;
    --wait) WAIT=${2:?}; shift 2 ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    *) die "unknown option $1" ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"
[ -f dashboard/Dockerfile ] || die "run it inside the keelson repository"
if [ "$ALLOW_DIRTY" -ne 1 ] && [ -n "$(git status --porcelain -- agent dashboard)" ]; then
  die "agent/ or dashboard/ has uncommitted changes: the image would not be the commit it is named after (--allow-dirty to go on)"
fi
TAG=$(git rev-parse --short HEAD)
IMAGE=keelson-dashboard:$TAG
say "building $IMAGE for $PLATFORM"
docker buildx build --platform "$PLATFORM" -f dashboard/Dockerfile --build-arg "VERSION=$(scripts/version.sh)" -t "$IMAGE" --load .

say "sending it to $HOST"
docker save "$IMAGE" | gzip -1 | ssh -o BatchMode=yes "$HOST" 'gunzip | sudo -n docker load' | tail -1

say "swapping it in on $HOST ($DIR)"
# shellcheck disable=SC2087
ssh -o BatchMode=yes "$HOST" "DIR='$DIR' SERVICE='$SERVICE' TAG='$TAG' WAIT='$WAIT' bash -s" <<'REMOTE'
set -euo pipefail
cd "$DIR"
S="sudo -n"
OLD=$(sed -n 's/^[[:space:]]*image:[[:space:]]*keelson-dashboard:\([A-Za-z0-9_.-]*\).*/\1/p' compose.yaml | head -1)
[ -n "$OLD" ] || { echo "no 'image: keelson-dashboard:<tag>' in $DIR/compose.yaml" >&2; exit 1; }
if [ "$OLD" = "$TAG" ]; then echo "deploy-dashboard: $TAG is already the running tag; recreating it anyway"; fi
TS=$(date +%Y%m%d-%H%M%S)
CONTAINER=$($S docker compose ps -q "$SERVICE")
DATA=$($S docker inspect "$CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}')
[ -n "$DATA" ] || { echo "cannot find the /data volume of the running dashboard" >&2; exit 1; }

# A stopped dashboard has no half-written database: the copy is consistent. Schema changes of the new version are forward
# only, so a return to the old image needs this copy back too.
$S docker compose stop "$SERVICE" >/dev/null
$S mkdir "backup-$TS"
$S sh -c "cp -a '$DATA'/dashboard.db* 'backup-$TS'/"
$S cp compose.yaml "compose.yaml.before-$TS"
$S sed -i "s#image: keelson-dashboard:$OLD#image: keelson-dashboard:$TAG#" compose.yaml
$S docker compose up -d "$SERVICE" >/dev/null

health() { $S docker inspect "$($S docker compose ps -q "$SERVICE")" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || echo unknown; }
status=unknown
for _ in $(seq 1 "$WAIT"); do
  status=$(health)
  case $status in healthy|running) break ;; esac
  sleep 1
done
if [ "$status" = healthy ] || [ "$status" = running ]; then
  echo "deploy-dashboard: $TAG is $status (was $OLD); backup in $DIR/backup-$TS"
  echo "deploy-dashboard: to go back: restore $DIR/compose.yaml.before-$TS and the database copy of backup-$TS (the new version may have migrated it)"
  exit 0
fi
echo "deploy-dashboard: $TAG is '$status' after ${WAIT}s: going back to $OLD" >&2
$S docker compose stop "$SERVICE" >/dev/null || true
$S cp "compose.yaml.before-$TS" compose.yaml
$S sh -c "rm -f '$DATA'/dashboard.db*; cp -a 'backup-$TS'/dashboard.db* '$DATA'/"
$S docker compose up -d "$SERVICE" >/dev/null
echo "deploy-dashboard: $OLD is back, with the database as it was before; logs: docker logs keelson-dashboard" >&2
exit 1
REMOTE
