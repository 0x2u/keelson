#!/bin/sh
# A deployment that goes wrong, on this machine, with nothing but Docker and Go: version 1 of a site serves, version 2
# has a typo in its web server configuration and cannot start. The agent deploys it, sees it fail, puts version 1 back
# and records what happened. Nothing is installed and everything this script makes is removed when it ends.
#
#   scripts/demo-rollback.sh
#
# It needs Docker (the images nginx:alpine and registry:2 are pulled once), Go and curl, and the ports 5099 (a throwaway
# registry the agent pulls from, as it would from ghcr.io) and 18080 (the site); DEMO_REGISTRY_PORT and DEMO_PORT change
# them. KEELSON_AGENT=/path/to/keelson-agent uses a binary you already built instead of building one.
#
# This is an in-place deployment (no reverse proxy), which stops the old container before it starts the new one: the
# site is unreachable for those few seconds, and the script measures how many. Behind Caddy or nginx (blue/green) the old
# version keeps serving until the new one is healthy.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
reg_port=${DEMO_REGISTRY_PORT:-5099}
port=${DEMO_PORT:-18080}
registry=localhost:$reg_port
image=$registry/demo/web
url=http://127.0.0.1:$port/

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "$1 is needed and was not found" >&2; exit 1; }; }
need docker
need curl
[ -n "${KEELSON_AGENT:-}" ] || need go
docker info >/dev/null 2>&1 || { echo "the Docker engine does not answer: start it first" >&2; exit 1; }

work=$(mktemp -d)
probe_pid=
cleanup() {
  [ -z "$probe_pid" ] || kill "$probe_pid" 2>/dev/null || true
  docker rm -f demo-web demo-web.prev kv-demo-registry >/dev/null 2>&1 || true
  docker rmi "$image:v1" "$image:v2" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT INT TERM

if [ -n "${KEELSON_AGENT:-}" ]; then
  agent=$KEELSON_AGENT
else
  say "Building the agent"
  (cd "$root/agent" && go build -o "$work/keelson-agent" ./cmd/keelson-agent)
  agent=$work/keelson-agent
fi

say "Preparing two versions of a site in a throwaway registry on $registry"
docker rm -f kv-demo-registry >/dev/null 2>&1 || true
docker run -d --name kv-demo-registry -p "127.0.0.1:$reg_port:5000" registry:2 >/dev/null
docker pull -q nginx:alpine >/dev/null
docker tag nginx:alpine "$image:v1"
# Version 2 is what a typo ships: the image builds and pushes fine, the server inside refuses its own configuration.
printf 'FROM nginx:alpine\nRUN echo "this is not a valid nginx directive;" > /etc/nginx/conf.d/default.conf\n' | docker build -q -t "$image:v2" - >/dev/null
tries=0
until docker push -q "$image:v1" >/dev/null 2>&1; do
  tries=$((tries + 1))
  [ "$tries" -lt 20 ] || { echo "the throwaway registry did not come up on $registry" >&2; exit 1; }
  sleep 0.5
done
docker push -q "$image:v2" >/dev/null
docker rmi "$image:v1" "$image:v2" >/dev/null # the agent must pull them, as it does in real life

cat >"$work/apps.yaml" <<EOF
apps:
  - name: demo-web
    image: $image
    publish: ["127.0.0.1:$port:80"]
    stop_timeout: 2s
    health_timeout: 20s
    stable_after: 3s
EOF

deploy() { "$agent" deploy --apps "$work/apps.yaml" --data-dir "$work" demo-web "$1"; }
answer() { curl -s -o /dev/null -m 2 -w '%{http_code}' "$url" || true; }
running() { docker inspect -f '{{.Config.Image}} ({{.State.Status}})' demo-web 2>/dev/null || echo "no container"; }

say "Deploying version 1"
deploy v1
echo "the site answers: HTTP $(answer), running $(running)"

say "Deploying version 2, which cannot start (the site is probed about five times a second meanwhile)"
(
  while :; do
    { answer; echo; } >>"$work/probes"
    sleep 0.2
  done
) &
probe_pid=$!
sleep 1
status=0
deploy v2 || status=$?
sleep 1
kill "$probe_pid" 2>/dev/null || true
probe_pid=

say "What is left"
echo "deploy exit status: $status (non-zero: the deployment did not succeed)"
echo "the site answers: HTTP $(answer), running $(running)"
total=$(wc -l <"$work/probes" | tr -d ' ')
down=$(grep -vc '^200$' "$work/probes" || true)
echo "probes: $total, answered: $((total - down)), unanswered: $down (the window in which the old container was stopped and the new one tried)"
echo
"$agent" history --data-dir "$work" demo-web

[ "$status" -ne 0 ] || { echo "the broken version was expected to fail" >&2; exit 1; }
case $(running) in "$image:v1 (running)") ;; *) echo "version 1 is not serving" >&2; exit 1 ;; esac
[ "$(answer)" = 200 ] || { echo "the site does not answer" >&2; exit 1; }
