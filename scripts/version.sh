#!/bin/sh
# Prints the version of the checkout: the one name the agent, the dashboard and the release use.
#
#   on the tag v0.1.0                v0.1.0
#   3 commits after it               v0.1.0-3-g1a2b3c4
#   with uncommitted changes         v0.1.0-3-g1a2b3c4-dirty
#   no v* tag in history             dev-1a2b3c4   (dev-1a2b3c4-dirty)
#   not a git checkout               dev
#
# The dashboard reads the first three as versions and orders them; "dev-..." has no order, so an agent built that way is
# only ever "different" from the one a dashboard carries. A release build passes the tag itself and does not call this.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
if git -C "$root" describe --tags --match 'v[0-9]*' --dirty 2>/dev/null; then exit 0; fi
hash=$(git -C "$root" rev-parse --short HEAD 2>/dev/null) || { echo dev; exit 0; }
if git -C "$root" diff-index --quiet HEAD -- 2>/dev/null; then echo "dev-$hash"; else echo "dev-$hash-dirty"; fi
