#!/bin/sh
# Tests the part of deploy/install.sh that sets the one-click updater up (the run directory, update.sh, the systemd units,
# updater.json). docker, systemctl, id and sleep are stand-ins on PATH, the systemd directory is a folder of the test
# (KEELSON_SYSTEMD_DIR) and the files come from the checkout next to install.sh, so it runs anywhere, in CI too.
#
#   sh deploy/tests/install-updater-test.sh
set -u

here=$(cd "$(dirname "$0")" && pwd)
deploy=$(cd "$here/.." && pwd)
root=$(mktemp -d "${TMPDIR:-/tmp}/keelson-install-test.XXXXXX") || exit 1
root=$(cd "$root" && pwd) || exit 1
trap 'rm -rf "$root"' EXIT INT TERM
export FAKE="$root/fake"
mkdir -p "$FAKE" "$root/bin"
failures=0
checks=0

cat >"$root/bin/docker" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$FAKE/docker.log"
case $1 in
  info) exit 0 ;;
  compose)
    shift
    case $1 in
      version) echo 2.30.0 ;;
      up) [ ! -f "$FAKE/up-fails" ] || exit 1 ;;
    esac
    ;;
esac
exit 0
EOF
cat >"$root/bin/systemctl" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$FAKE/systemctl.log"
case $1 in enable) [ ! -f "$FAKE/enable-fails" ] || exit 1 ;; esac
exit 0
EOF
cat >"$root/bin/id" <<'EOF'
#!/bin/sh
if [ "${1:-}" = -u ] && [ -f "$FAKE/root" ]; then echo 0; elif [ "${1:-}" = -u ]; then echo 1000; else /usr/bin/id "$@"; fi
EOF
printf '#!/bin/sh\nexit 0\n' >"$root/bin/sleep"
chmod +x "$root/bin/docker" "$root/bin/systemctl" "$root/bin/id" "$root/bin/sleep"

pass() { checks=$((checks + 1)); }
fail() { checks=$((checks + 1)); failures=$((failures + 1)); printf 'FAIL %s: %s\n' "$case_name" "$*"; }
check() { desc=$1; shift; if "$@"; then pass; else fail "$desc"; fi; }
not() { ! "$@"; }
has() { grep -qF -- "$2" "$1"; }

new_case() { # name: root or not
  case_name=$1
  dir=$root/$1/keelson
  sysd=$root/$1/systemd
  out=$root/$1/out
  rm -rf "${root:?}/$1" "$FAKE"
  mkdir -p "$root/$1" "$FAKE"
  : >"$FAKE/docker.log"
  : >"$FAKE/systemctl.log"
  [ "${2:-root}" != root ] || : >"$FAKE/root"
}
# The install command of a release, from the checkout.
install() { # args
  PATH=$root/bin:$PATH KEELSON_IMAGE=keelson-test KEELSON_PORT=39999 KEELSON_SYSTEMD_DIR=$sysd \
    sh "$deploy/install.sh" --dir "$dir" "$@" >"$out" 2>&1
  rc=$?
}

# ---- as root, with systemd ---------------------------------------------------------------------------------------------
new_case first-install
install --version v0.2.0
check "installs" [ "$rc" -eq 0 ]
check "update.sh is placed, as the release has it" cmp -s "$deploy/update.sh" "$dir/update.sh"
check "update.sh is executable" [ -x "$dir/update.sh" ]
check "the run directory exists" [ -d "$dir/run" ]
check "the run directory is open to the container's user (0755)" [ "$(find "$dir/run" -maxdepth 0 -perm 755 | wc -l | tr -d ' ')" = 1 ]
check "updater.json says the updater is there" [ "$(cat "$dir/run/updater.json")" = '{"version":1,"installed":true}' ]
check "updater.json is readable by the dashboard (0644)" [ "$(find "$dir/run/updater.json" -perm 644 | wc -l | tr -d ' ')" = 1 ]
check "the service runs update.sh of this directory" has "$sysd/keelson-update.service" "ExecStart=$dir/update.sh --dir $dir"
check "the service is a one-shot" has "$sysd/keelson-update.service" "Type=oneshot"
check "the path unit watches the request file" has "$sysd/keelson-update.path" "PathExists=$dir/run/update-request.json"
check "the path unit starts that service" has "$sysd/keelson-update.path" "Unit=keelson-update.service"
check "the path unit is installed for boot" has "$sysd/keelson-update.path" "WantedBy=multi-user.target"
check "systemd is told to reload the units" has "$FAKE/systemctl.log" "daemon-reload"
check "and the path unit is enabled and started" has "$FAKE/systemctl.log" "enable --now keelson-update.path"
check "the output says one-click updates are on" has "$out" "Update to"
check "compose mounts the run directory in the dashboard" has "$dir/compose.yaml" "./run:/run/keelson"

# Run again, with no version: same result, units untouched (no reload), nothing duplicated.
: >"$FAKE/systemctl.log"
install
check "a re-run without a version works" [ "$rc" -eq 0 ]
check "the units did not change: no reload" not has "$FAKE/systemctl.log" "daemon-reload"
check "the path unit is still enabled" has "$FAKE/systemctl.log" "enable --now keelson-update.path"
check "updater.json is still there" [ -f "$dir/run/updater.json" ]
check "update.sh was not replaced (no .old)" [ ! -e "$dir/update.sh.old" ]

# A unit that was changed by hand is put back, with a reload.
echo "# edited" >>"$sysd/keelson-update.service"
: >"$FAKE/systemctl.log"
install
check "an edited unit is rewritten" not has "$sysd/keelson-update.service" "# edited"
check "and systemd reloads" has "$FAKE/systemctl.log" "daemon-reload"

# ---- an install made before the updater: a re-run without --version adds it --------------------------------------------
new_case existing-install
mkdir -p "$dir"
: >"$dir/compose.yaml"
printf 'KEELSON_VERSION=v0.1.0\nKEELSON_PORT=39999\n' >"$dir/.env"
install
check "a re-run without --version succeeds on an install made before" [ "$rc" -eq 0 ]
check "it adds update.sh" [ -x "$dir/update.sh" ]
check "it adds the units" [ -f "$sysd/keelson-update.path" ]
check "it adds updater.json" [ -f "$dir/run/updater.json" ]
check "it keeps the version in .env" has "$dir/.env" KEELSON_VERSION=v0.1.0
# (with a checkout the files are the checkout's: a release is fetched by version, see below)

# ---- not root, or the updater cannot be had -----------------------------------------------------------------------------
new_case not-root user
install --version v0.2.0
check "installs" [ "$rc" -eq 0 ]
check "says the updater is not set up, and why" has "$out" "One-click dashboard updates are not set up: this was not run as root"
check "no units" [ ! -e "$sysd/keelson-update.path" ]
check "systemctl was not called" [ ! -s "$FAKE/systemctl.log" ]
check "no updater.json" [ ! -e "$dir/run/updater.json" ]
check "no update.sh" [ ! -e "$dir/update.sh" ]
check "the run directory exists anyway (compose mounts it)" [ -d "$dir/run" ]
check "does not advertise the one-click" not has "$out" "Update to <version>"

new_case enable-fails
: >"$FAKE/enable-fails"
install --version v0.2.0
check "installs" [ "$rc" -eq 0 ]
check "warns that it could not be enabled" has "$out" "could not enable keelson-update.path"
check "no updater.json when the path unit is not running" [ ! -e "$dir/run/updater.json" ]

new_case odd-dir
dir="$root/odd-dir/with space"
install --version v0.2.0
check "installs" [ "$rc" -eq 0 ]
check "skips the updater: a unit cannot hold that name" has "$out" "characters a systemd unit cannot hold"
check "no units" [ ! -e "$sysd/keelson-update.path" ]

# A pinned release older than the updater has no update.sh: install anyway, say it.
new_case old-release
mkdir -p "$root/old-release/rel"
cp "$deploy/compose.yaml" "$root/old-release/rel/"
PATH=$root/bin:$PATH KEELSON_IMAGE=keelson-test KEELSON_PORT=39999 KEELSON_SYSTEMD_DIR=$sysd KEELSON_RELEASE_URL=file://$root/old-release/rel \
  sh "$deploy/install.sh" --dir "$dir" --version v0.1.0 >"$out" 2>&1
rc=$?
check "an old release installs" [ "$rc" -eq 0 ]
check "it says it has no update.sh" has "$out" "has no update.sh"
check "no units" [ ! -e "$sysd/keelson-update.path" ]
check "no updater.json" [ ! -e "$dir/run/updater.json" ]
check ".env pins that version" has "$dir/.env" KEELSON_VERSION=v0.1.0

# A release that has it: fetched from the release, by its version.
new_case from-release
mkdir -p "$root/from-release/rel"
cp "$deploy/compose.yaml" "$root/from-release/rel/"
printf '#!/bin/sh\n# the update.sh of the release\n' >"$root/from-release/rel/update.sh"
PATH=$root/bin:$PATH KEELSON_IMAGE=keelson-test KEELSON_PORT=39999 KEELSON_SYSTEMD_DIR=$sysd KEELSON_RELEASE_URL=file://$root/from-release/rel \
  sh "$deploy/install.sh" --dir "$dir" --version v0.2.0 >"$out" 2>&1
rc=$?
check "installs" [ "$rc" -eq 0 ]
check "update.sh comes from the release, not from the checkout" has "$dir/update.sh" "the update.sh of the release"
check "it is executable" [ -x "$dir/update.sh" ]

# The docker side is untouched by the updater: the stack is started the same way.
check "the stack was started" has "$FAKE/docker.log" "compose up -d --wait"

echo
if [ "$failures" -ne 0 ]; then
  printf 'install-updater-test: %s of %s checks failed\n' "$failures" "$checks"
  exit 1
fi
printf 'install-updater-test: %s checks passed\n' "$checks"
