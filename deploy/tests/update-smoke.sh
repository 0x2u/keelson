#!/bin/sh
# Runs deploy/update.sh against a real Docker engine: install a dashboard with install.sh, then ask for an update the way the
# dashboard does (a request file in run/), on a release that works and on one that never gets healthy. Needs docker, a dashboard
# image that runs (the one the CI builds, or any local one) and a free loopback port; cleans up after itself.
#
#   sh deploy/tests/update-smoke.sh <dashboard image> [port]
#
# What stands in for the real thing: the three "releases" are local tags of that image (v0.1.0 installed; v0.2.0 the same image
# with another version; v0.3.0 an image that damages the database and never gets healthy), served as a folder over file://
# (KEELSON_RELEASE_URL, the hook install.sh and update.sh share). systemd is not involved: the unit would only run update.sh.
set -u

[ $# -ge 1 ] || { echo "usage: update-smoke.sh <dashboard image> [port]" >&2; exit 2; }
base=$1
export KEELSON_PORT="${2:-39998}"
here=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/keelson-update-smoke.XXXXXX") || exit 1
work=$(cd "$work" && pwd)
dir=$work/keelson
export KEELSON_IMAGE=keelson-update-smoke
failures=0

cleanup() {
  [ ! -f "$dir/compose.yaml" ] || (cd "$dir" && docker compose down -v >/dev/null 2>&1)
  for v in v0.1.0 v0.2.0 v0.3.0; do docker rmi "$KEELSON_IMAGE:$v" >/dev/null 2>&1; done
  rm -rf "$work"
}
trap cleanup EXIT INT TERM

step() { printf '\n== %s\n' "$*"; }
ok() { # description, then a command
  desc=$1
  shift
  if "$@" >/dev/null 2>&1; then printf '   ok   %s\n' "$desc"; else printf '   FAIL %s\n' "$desc"; failures=$((failures + 1)); fi
}
running_version() { (cd "$dir" && docker compose exec -T dashboard printenv KEELSON_DASHBOARD_VERSION); }
container_id() { (cd "$dir" && docker compose ps -q dashboard); }
healthy() { curl -fsS --max-time 5 --retry 15 --retry-delay 2 --retry-connrefused "http://127.0.0.1:$KEELSON_PORT/api/health"; }
tables() { # how many tables the running dashboard's database has
  (cd "$dir" && docker compose exec -T dashboard node -e 'const{DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("/data/dashboard.db",{readOnly:true});console.log(d.prepare("select count(*) n from sqlite_master").get().n)')
}
env_version() { sed -n 's/^KEELSON_VERSION=//p' "$dir/.env"; }
state() { sed -n 's/.*"state":"\([^"]*\)".*/\1/p' "$dir/run/update-status.json"; }
ask() { # version release-folder: the request the dashboard writes, then what systemd would start
  printf '{"version":"%s","requested_at":"2026-01-01T00:00:00Z"}\n' "$1" >"$dir/run/update-request.json"
  KEELSON_RELEASE_URL=file://$work/rel/$2 sh "$dir/update.sh" --dir "$dir"
  echo "   update.sh exit status: $?"
  echo "   $(cat "$dir/run/update-status.json")"
}

step "three local releases of the image $base"
platform=$(docker image inspect -f '{{.Os}}/{{.Architecture}}' "$base") || exit 1 # built for the image's own platform
for v in v0.1.0 v0.2.0 v0.3.0; do
  {
    echo "FROM $base"
    echo "ENV KEELSON_DASHBOARD_VERSION=$v"
    # v0.3.0: damages the database, as a migration gone wrong would, and is never healthy (a health check that fails at once).
    if [ "$v" = v0.3.0 ]; then
      echo 'HEALTHCHECK --interval=2s --timeout=2s --retries=1 --start-period=1s CMD false'
      echo "CMD [\"sh\", \"-c\", \"echo not a database > /data/dashboard.db; exec node server.js\"]"
    fi
  } | docker build -q --platform "$platform" -t "$KEELSON_IMAGE:$v" - >/dev/null || exit 1
  mkdir -p "$work/rel/$v"
  cp "$here/install.sh" "$here/compose.yaml" "$here/update.sh" "$work/rel/$v/"
done

step "install v0.1.0 with install.sh (as root with systemd it also installs the units: here update.sh and updater.json are placed by hand)"
sh "$here/install.sh" --dir "$dir" --version v0.1.0 >"$work/install.out" 2>&1 || { cat "$work/install.out"; exit 1; }
cp "$here/update.sh" "$dir/update.sh"
printf '{"version":1,"installed":true}\n' >"$dir/run/updater.json"
ok "the dashboard is healthy on v0.1.0" healthy
echo "   running: $(running_version)"
(cd "$dir" && docker compose exec -T dashboard sh -c 'echo kept > /data/smoke-marker')
tables_before=$(tables)
before=$(container_id)
echo "   container $before, the database has $tables_before tables"
ok "the run directory is mounted in the container" sh -c "cd '$dir' && docker compose exec -T dashboard ls /run/keelson/updater.json"

step "a downgrade is refused and nothing is touched"
ask v0.0.9 v0.2.0
ok "status is failed" test "$(state)" = failed
ok "the container was not replaced" test "$(container_id)" = "$before"

step "update to v0.2.0"
ask v0.2.0 v0.2.0
ok "status is done" test "$(state)" = "done"
ok "the dashboard is healthy" healthy
ok "it runs v0.2.0" test "$(running_version)" = v0.2.0
ok "the container was replaced" test "$(container_id)" != "$before"
ok ".env pins v0.2.0" test "$(env_version)" = v0.2.0
ok "the data volume is kept" sh -c "cd '$dir' && docker compose exec -T dashboard cat /data/smoke-marker | grep -qx kept"
ok "the request file is gone" test ! -e "$dir/run/update-request.json"
ok "a copy of the database was taken" sh -c "ls '$dir'/backups/dashboard-*.db"
echo "   running: $(running_version)"
before=$(container_id)
tables_before=$(tables)

step "update to v0.3.0, which damages the database and never gets healthy: it must come back to v0.2.0"
ask v0.3.0 v0.3.0
ok "status is rolled_back" test "$(state)" = rolled_back
ok "the dashboard is healthy again" healthy
ok "it runs v0.2.0 again" test "$(running_version)" = v0.2.0
ok ".env is back at v0.2.0" test "$(env_version)" = v0.2.0
ok "the database was restored (it opens and has its tables)" test "$(tables)" = "$tables_before"
ok "the data volume is kept" sh -c "cd '$dir' && docker compose exec -T dashboard cat /data/smoke-marker | grep -qx kept"
ok "update.sh says it restored the database" grep -q "restoring the database from dashboard-" "$dir/update.log"
echo "   running: $(running_version)"
echo "   update.log:"
sed 's/^/     /' "$dir/update.log" | sed -n '1,400p' | grep -E "keelson update|restor|Recreat|Started|Healthy|unhealthy" | sed -n '1,25p'

echo
if [ "$failures" -ne 0 ]; then
  printf 'update-smoke: %s checks failed\n' "$failures"
  exit 1
fi
echo "update-smoke: all checks passed"
