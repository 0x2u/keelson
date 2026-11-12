#!/bin/sh
# Runs a Keelson agent on this machine for the dashboard's "local" server: the address and token of that entry in the
# import file, read-only (no apps file, so it only reads containers, logs and stats). Stop it with Ctrl+C.
#
#   scripts/local-agent.sh [FILE] [NAME]      # defaults: dashboard/servers.local.json, "local"
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
file=${1:-$root/dashboard/servers.local.json}
name=${2:-local}

[ -f "$file" ] || { echo "no import file at $file (copy dashboard/servers.example.json)" >&2; exit 1; }

# Two lines out of the file: where to listen, and the token. Neither goes on a command line the system can list.
# shellcheck disable=SC2016 # the program is JavaScript: its template literals are not shell expansions
entry=$(node -e '
const fs = require("fs");
const s = (JSON.parse(fs.readFileSync(process.argv[1], "utf8")).servers || []).find((x) => x.name === process.argv[2]);
if (!s || !s.url || !s.token) { console.error(`no server "${process.argv[2]}" with a url and a token in ${process.argv[1]}`); process.exit(1); }
const u = new URL(s.url);
console.log(u.host);
console.log(s.token);
' "$file" "$name")
listen=$(printf '%s\n' "$entry" | sed -n 1p)
KEELSON_TOKEN=$(printf '%s\n' "$entry" | sed -n 2p)
export KEELSON_TOKEN

mkdir -p "$root/dist"
(cd "$root/agent" && go build -o "$root/dist/local-agent" ./cmd/keelson-agent)
echo "agent for \"$name\" listening on $listen (read-only)" >&2
exec "$root/dist/local-agent" serve --listen "$listen"
