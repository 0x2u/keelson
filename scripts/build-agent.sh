#!/bin/sh
# Builds the agent as a static binary for linux and darwin (macOS), amd64 and arm64, with checksums. The Linux ones run on
# servers; all four can run `keelson-agent connect` on a machine that builds images for the dashboard.
#
#   scripts/build-agent.sh [VERSION] [OUT_DIR]
#
# VERSION defaults to scripts/version.sh (v0.1.0 on a tag, v0.1.0-3-g1a2b3c4 after it, -dirty with local changes, dev-<hash> without
# a tag); a release passes its tag. OUT_DIR to dist/agent. A local dashboard looks in dashboard/agent-bin: `pnpm run agent-bin`
# (in dashboard/) builds there, or point it at any output with KEELSON_AGENT_BIN_DIR.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
version=${1:-$("$root/scripts/version.sh")}
out=${2:-$root/dist/agent}

# A relative OUT_DIR is relative to where this is run from, not to the agent's directory.
case $out in /*) ;; *) out=$PWD/$out ;; esac

mkdir -p "$out"
cd "$root/agent"
for os in linux darwin; do
  for arch in amd64 arm64; do
    echo "building keelson-agent $version for $os/$arch"
    CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath \
      -ldflags "-s -w -X main.version=$version" \
      -o "$out/keelson-agent-$os-$arch" ./cmd/keelson-agent
  done
done
# The dashboard reads this to tell whether a server runs the version it carries.
printf '%s\n' "$version" > "$out/VERSION"
# macOS has shasum, not sha256sum; both write the same format.
if command -v sha256sum >/dev/null 2>&1; then sum="sha256sum"; else sum="shasum -a 256"; fi
(cd "$out" && $sum keelson-agent-linux-* keelson-agent-darwin-* > SHA256SUMS)
echo "done: $out"
cat "$out/SHA256SUMS"
