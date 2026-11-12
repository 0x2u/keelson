#!/bin/sh
# Captures what a real agent answers to the requests the dashboard makes, into contract/agent/*.json. The dashboard's tests
# (dashboard/tests/contract) read those files with the dashboard's own code, and CI fails when running this again changes
# one: the agent's API shape moved, so the dashboard must be checked against it.
#
#   scripts/capture-contract.sh
#
# It builds the agent, starts it on a loopback port with a temporary data directory and the apps files of contract/input,
# gives it a stand-in for the Docker engine and for /proc (scripts/contract-engine.mjs: no engine, no network and no
# registry are needed, and what the machine holds does not matter), deploys one app, reads the answers, replaces what
# differs from machine to machine and run to run (times, ids, hashes, hostnames, paths, ports) and stops the agent. Needs
# Go and Node 22 or later.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/keelson-contract.XXXXXX")
work=$(cd "$work" && pwd)
pids=""

cleanup() {
  status=$?
  trap - EXIT INT TERM
  for pid in $pids; do kill "$pid" 2>/dev/null || true; done
  for pid in $pids; do wait "$pid" 2>/dev/null || true; done
  if [ "$status" -ne 0 ]; then
    for log in agent engine; do
      [ -f "$work/$log.log" ] && { echo "--- $log log" >&2; cat "$work/$log.log" >&2; }
    done
  fi
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT INT TERM

# Two loopback ports nothing listens on: the agent's, and the one its Caddy would have.
ports=$(node -e '
const net = require("net");
const servers = [net.createServer(), net.createServer()];
let left = servers.length;
const found = [];
for (const s of servers) s.listen(0, "127.0.0.1", () => {
  found.push(s.address().port);
  if (--left === 0) { console.log(found.join(" ")); servers.forEach((x) => x.close()); }
});
')
# shellcheck disable=SC2086 # two words
set -- $ports
port=$1
admin=$2

mkdir -p "$work/projects.d" "$work/data" "$work/proc" "$work/out"
for file in apps.yaml projects.d/blog.yaml; do
  sed -e "s|@WORK@|$work|g" -e "s|@ADMIN_PORT@|$admin|g" "$root/contract/input/$file" > "$work/$file"
done
# The files the apps file names (secrets, env files, certificates) must exist: the agent reads some of them while it starts.
mkdir -p "$work/etc"
grep -oh '@WORK@/etc/[A-Za-z0-9._-]*' "$root"/contract/input/apps.yaml "$root"/contract/input/projects.d/*.yaml | sort -u | sed 's|.*/||' |
  while read -r name; do printf '%s\n' "contract" > "$work/etc/$name"; done
printf '%s\n' "contract-read-token-0123456789abcdef0123456789abcdef" > "$work/token"
printf '%s\n' "contract-deploy-secret-0123456789abcdef0123456789" > "$work/secret"
chmod 600 "$work/token" "$work/secret"
# The same host on every machine: what the agent reads from /proc.
printf '%s\n' "0.10 0.20 0.30 1/100 1000" > "$work/proc/loadavg"
printf '%s\n' "MemTotal:        8388608 kB" "MemAvailable:    4194304 kB" "SwapTotal:       1048576 kB" "SwapFree:        1048576 kB" > "$work/proc/meminfo"
printf '%s\n' "3600.00 7200.00" > "$work/proc/uptime"

echo "building the agent" >&2
(cd "$root/agent" && go build -o "$work/keelson-agent" -ldflags "-X main.version=v0.0.0-contract" ./cmd/keelson-agent)

node "$root/scripts/contract-engine.mjs" "$work/engine.sock" "$work/engine.log" 2> "$work/engine.err" &
pids="$pids $!"
i=0
while [ ! -S "$work/engine.sock" ]; do
  i=$((i + 1))
  [ "$i" -le 100 ] || { echo "the stand-in engine did not start" >&2; cat "$work/engine.err" >&2; exit 1; }
  sleep 0.1
done

KEELSON_PROC_DIR="$work/proc" "$work/keelson-agent" serve \
  --listen "127.0.0.1:$port" --token-file "$work/token" --deploy-secret-file "$work/secret" \
  --apps "$work/apps.yaml" --data-dir "$work/data" --docker-socket "$work/engine.sock" > "$work/agent.log" 2>&1 &
pids="$pids $!"
i=0
until curl -fsS "http://127.0.0.1:$port/v1/health" > /dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -le 100 ] || { echo "the agent did not become healthy" >&2; exit 1; }
  sleep 0.1
done

node "$root/scripts/contract-capture.mjs" "http://127.0.0.1:$port" "$work/token" "$work/secret" "$work/apps.yaml" "$work" "$admin" "$work/out"

# Only a complete capture replaces the last one, so that a file for a request that is gone does not stay behind.
rm -rf "$root/contract/agent"
mkdir -p "$root/contract/agent"
cp "$work"/out/*.json "$root/contract/agent/"
echo "captured what the agent answers in contract/agent" >&2
