#!/bin/sh
# Tests deploy/update.sh, the updater that runs as root on a file the dashboard container wrote. docker, sleep and the release it
# downloads are stand-ins (a stub on PATH, a folder served over file://), so it runs anywhere with a POSIX shell, in CI too.
#
#   sh deploy/tests/update-test.sh
#   UPDATE_SH=/tmp/changed-update.sh sh deploy/tests/update-test.sh    # a changed copy: the checks must fail (mutation check)
set -u

here=$(cd "$(dirname "$0")" && pwd)
update_sh=${UPDATE_SH:-$here/../update.sh}
root=$(mktemp -d "${TMPDIR:-/tmp}/keelson-update-test.XXXXXX") || exit 1
root=$(cd "$root" && pwd) || exit 1 # as update.sh writes it into what it passes on
trap 'rm -rf "$root"' EXIT INT TERM
export FAKE="$root/fake"
mkdir -p "$FAKE" "$root/bin"
failures=0
checks=0

# ---- stand-ins --------------------------------------------------------------------------------------------------------
# The container is "c-<version in .env>", made by `compose up` (or by the release's install.sh); its health is the content of
# $FAKE/health-<container> (healthy when there is no such file). Every call is logged to $FAKE/docker.log.
cat >"$root/bin/docker" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$FAKE/docker.log"
case $1 in
  compose)
    shift
    case $1 in
      ps)
        [ ! -f "$FAKE/container" ] || cat "$FAKE/container"
        ;;
      down)
        rm -f "$FAKE/container"
        ;;
      up)
        rc=0
        [ ! -f "$FAKE/up-rc" ] || rc=$(cat "$FAKE/up-rc")
        [ "$rc" != 0 ] || printf 'c-%s\n' "$(sed -n 's/^KEELSON_VERSION=//p' .env | tail -1)" >"$FAKE/container"
        exit "$rc"
        ;;
    esac
    ;;
  inspect)
    case $3 in
      *Health*)
        if [ -f "$FAKE/health-$4" ]; then cat "$FAKE/health-$4"; else echo healthy; fi
        ;;
      *) echo "sha256:image-of-$4" ;;
    esac
    ;;
  run)
    rc=0
    [ ! -f "$FAKE/run-rc" ] || rc=$(cat "$FAKE/run-rc")
    exit "$rc"
    ;;
esac
exit 0
EOF
# Waiting for the dashboard to come up is a loop of sleeps: skip them.
printf '#!/bin/sh\nexit 0\n' >"$root/bin/sleep"
chmod +x "$root/bin/docker" "$root/bin/sleep"

# What the install.sh of the release does, per scenario ($FAKE/scenario): it sets the version in .env, copies the database, and
# either starts the new container or fails the way the real one fails.
rel=$root/release
mkdir -p "$rel"
cat >"$rel/install.sh" <<'EOF'
#!/bin/sh
dir=$2
ver=$4
printf '%s\n' "$*" >"$FAKE/install.args"
[ -e "$dir/run/update-request.json" ] || echo gone >"$FAKE/request-gone-before-install"
scenario=$(cat "$FAKE/scenario")
copy() {
  mkdir -p "$dir/backups"
  : >"$dir/backups/dashboard-20300101-000000.db"
  echo "database copied to $dir/backups/dashboard-20300101-000000.db"
}
setenv() {
  { grep -v '^KEELSON_VERSION=' "$dir/.env"; echo "KEELSON_VERSION=$ver"; } >"$dir/.env.new"
  mv "$dir/.env.new" "$dir/.env"
}
case $scenario in
  early)
    echo "keelson install: cannot talk to docker: is it running?" >&2
    exit 1
    ;;
  block)
    : >"$FAKE/blocked"
    while [ ! -f "$FAKE/go" ]; do command -p sleep 0.2; done
    ;;
esac
copy
setenv
echo "pulling Keelson $ver"
if [ "$scenario" = pull ]; then
  echo "keelson install: could not pull the images: is $ver a published release, and can this machine reach ghcr.io?" >&2
  exit 1
fi
echo starting
echo "c-$ver" >"$FAKE/container"
if [ "$scenario" = late ]; then
  echo "keelson install: the dashboard did not become healthy (log above). Fix it and run this again." >&2
  exit 1
fi
exit 0
EOF

# ---- helpers ----------------------------------------------------------------------------------------------------------
pass() { checks=$((checks + 1)); }
fail() { checks=$((checks + 1)); failures=$((failures + 1)); printf 'FAIL %s: %s\n' "$case_name" "$*"; }
check() { # description, then a test command
  desc=$1
  shift
  if "$@"; then pass; else fail "$desc"; fi
}
not() { ! "$@"; }
has() { grep -qF -- "$2" "$1"; }
lacks() { ! grep -qF -- "$2" "$1"; }

# A fresh install directory at v0.1.0 whose container is c-v0.1.0, with a database copy from an earlier update.
new_case() { # name current-version
  case_name=$1
  dir=$root/$1/keelson
  rm -rf "${root:?}/$1"
  mkdir -p "$dir/run" "$dir/backups"
  chmod 755 "$dir/run"
  current=${2-v0.1.0}
  [ -z "$current" ] || printf 'KEELSON_VERSION=%s\nKEELSON_PORT=3999\n' "$current" >"$dir/.env"
  : >"$dir/compose.yaml"
  : >"$dir/backups/dashboard-20991231-235959.db"
  rm -rf "$FAKE"
  mkdir -p "$FAKE"
  echo "c-$current" >"$FAKE/container"
  echo ok >"$FAKE/scenario"
  out=$root/$1/out
  : >"$FAKE/docker.log"
}
request() { printf '%s' "$1" >"$dir/run/update-request.json"; }
request_version() { request "{\"version\":\"$1\",\"requested_at\":\"2026-01-01T00:00:00Z\"}"; }
update() {
  PATH=$root/bin:$PATH KEELSON_RELEASE_URL=file://$rel sh "$update_sh" --dir "$dir" >"$out" 2>&1
  rc=$?
}
status_file=
field() { # name: a string member of the status file
  sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" "$status_file"
}
status_is() { [ -f "$status_file" ] && [ "$(field state)" = "$1" ]; }
docker_called() { grep -q -- "$1" "$FAKE/docker.log"; }
no_leftovers() { [ -z "$(find "$dir" -maxdepth 1 \( -name '.update.??????' -o -name '.update-status.*' -o -name '.update-probe*' \) | head -n 1)" ]; }
json_valid() { # the status file is JSON (python3 when there is one)
  command -v python3 >/dev/null 2>&1 || return 0
  python3 -m json.tool "$status_file" >/dev/null 2>&1
}
set_case() { status_file=$dir/run/update-status.json; }

# Both docker calls happened, the first before the second: the order of a rollback.
before() { # pattern pattern
  first=$(grep -n -- "$1" "$FAKE/docker.log" | sed -n '1s/:.*//p')
  second=$(grep -n -- "$2" "$FAKE/docker.log" | sed -n '1s/:.*//p')
  [ -n "$first" ] && [ -n "$second" ] && [ "$first" -lt "$second" ]
}

# ---- requests that must be refused ------------------------------------------------------------------------------------
refused() { # name, request body, expected text in the message
  new_case "refused-$1"
  set_case
  request "$2"
  update
  check "exits non-zero" [ "$rc" -ne 0 ]
  check "status is failed" status_is failed
  check "the message says why ($3)" has "$status_file" "$3"
  check "status is valid JSON" json_valid
  check "the request file is gone" [ ! -e "$dir/run/update-request.json" ]
  check "install.sh was not run" [ ! -e "$FAKE/install.args" ]
  check "docker was not touched" [ ! -s "$FAKE/docker.log" ]
  check "nothing was executed from the request" [ ! -e "$root/pwned" ]
  check "no temporary files left" no_leftovers
  check ".env is as it was" has "$dir/.env" KEELSON_VERSION=v0.1.0
}

refused_version() { # name, version text: as a request the dashboard could never write
  refused "$1" "$(printf '{"version":"%s","requested_at":"x"}' "$2")" "the version must look like v0.2.0"
}
refused_version injection-semicolon "v1.2.3; touch $root/pwned"
refused_version injection-subshell "\$(touch $root/pwned)"
refused_version injection-subshell-in-version "v1.2.\$(touch $root/pwned)"
refused_version injection-backtick "v1.2.\`touch $root/pwned\`"
refused_version newline "v1.2.3
touch $root/pwned"
refused_version escaped-newline 'v1.2.3\ntouch pwned'
refused_version latest latest
refused_version two-parts v1.2
refused_version capital-v V1.2.3
refused_version no-v 1.2.3
refused_version prerelease v1.2.3-rc.1
refused_version four-parts v1.2.3.4
refused_version letter v1.2.x
refused_version empty ""
refused_version dots v1..3
refused_version trailing-dot v1.2.
refused_version too-long v1.2.9999999999
refused_version path ../../x
refused_version space "v1.2.3 "
refused "not-json" 'v1.2.3' "it must name one version"
refused "empty-file" '' "it must name one version"
refused "two-versions" '{"version":"v0.2.0","version":"v0.3.0"}' "it must name one version"
refused "number" '{"version":2}' "it must name one version"

# A request that is a symbolic link is not read at all (it could point at any file of the machine).
new_case refused-symlink
set_case
echo '{"version":"v0.2.0"}' >"$root/target.json"
ln -s "$root/target.json" "$dir/run/update-request.json"
update
check "a symlinked request is refused" status_is failed
check "install.sh was not run" [ ! -e "$FAKE/install.args" ]
check "the link is removed" [ ! -L "$dir/run/update-request.json" ]
check "and its target is left alone" [ -f "$root/target.json" ]

# Other members of the request are never read.
new_case extra-members
set_case
# shellcheck disable=SC2016 # the $( ) in the request is the point: it must not run
request '{"requested_at":"x","note":"$(touch '"$root"'/pwned)","version":"v0.2.0","command":"touch '"$root"'/pwned"}'
update
check "a request with other members is still read for its version" status_is "done"
check "the other members were not executed" [ ! -e "$root/pwned" ]

# ---- the current version ----------------------------------------------------------------------------------------------
new_case current-latest latest
set_case
request_version v0.2.0
update
check "latest as the current version is refused" status_is failed
check "the message tells to pin a version" has "$status_file" "pin a release"
check "install.sh was not run" [ ! -e "$FAKE/install.args" ]

new_case current-missing ""
set_case
printf 'KEELSON_PORT=3999\n' >"$dir/.env"
request_version v0.2.0
update
check "no version in .env is refused" status_is failed
check "install.sh was not run" [ ! -e "$FAKE/install.args" ]

new_case current-odd "v0.1"
set_case
request_version v0.2.0
update
check "a current version that is not vX.Y.Z is refused" status_is failed
check "install.sh was not run" [ ! -e "$FAKE/install.args" ]

# ---- going forward only -----------------------------------------------------------------------------------------------
not_newer() { # name current requested
  new_case "not-newer-$1" "$2"
  set_case
  request_version "$3"
  update
  check "$3 over $2 is refused" status_is failed
  check "the message says it is not newer" has "$status_file" "is not newer than $2"
  check "exits non-zero" [ "$rc" -ne 0 ]
  check "install.sh was not run" [ ! -e "$FAKE/install.args" ]
  check "docker was not touched" [ ! -s "$FAKE/docker.log" ]
  check ".env is as it was" has "$dir/.env" "KEELSON_VERSION=$2"
}
not_newer equal v0.2.0 v0.2.0
not_newer patch-down v0.2.1 v0.2.0
not_newer minor-down v0.3.0 v0.2.9
not_newer major-down v1.0.0 v0.9.9
not_newer numeric-minor v0.10.0 v0.9.0 # 10 > 9 as numbers, not as text
not_newer numeric-patch v0.1.10 v0.1.9
not_newer leading-zero v0.8.0 v0.08.0 # equal as numbers

forward() { # name current requested
  new_case "forward-$1" "$2"
  set_case
  request_version "$3"
  update
  check "$2 to $3 is accepted (done)" status_is "done"
  check "install.sh got that version" has "$FAKE/install.args" "--dir $dir --version $3"
}
forward minor v0.9.0 v0.10.0
forward patch v0.1.9 v0.1.10
forward major v0.99.99 v1.0.0
forward leading-zero v0.8.0 v0.09.0

# ---- the happy path ---------------------------------------------------------------------------------------------------
new_case happy
set_case
request_version v0.2.0
update
check "exits 0" [ "$rc" -eq 0 ]
check "install.sh of the release ran with the directory and the version" [ "$(cat "$FAKE/install.args")" = "--dir $dir --version v0.2.0" ]
check "the request file was deleted before install.sh ran" [ -e "$FAKE/request-gone-before-install" ]
check "the request file is gone" [ ! -e "$dir/run/update-request.json" ]
check "status is done" status_is "done"
check "phase is done" [ "$(field phase)" = "done" ]
check "from is the previous version" [ "$(field from)" = v0.1.0 ]
check "to is the new version" [ "$(field to)" = v0.2.0 ]
check "the message says what happened" has "$status_file" "Updated to v0.2.0."
check "finished_at is set" [ -n "$(field finished_at)" ]
check "started_at is a UTC time" [ -n "$(field started_at | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$')" ]
check "status is valid JSON" json_valid
# shellcheck disable=SC2012
check "the status file is readable by the dashboard (0644)" [ "$(ls -l "$status_file" | cut -c1-10)" = "-rw-r--r--" ]
check "the stack was not taken down" not docker_called '^compose down'
check "no database restore" not docker_called '^run'
check ".env says the new version" has "$dir/.env" KEELSON_VERSION=v0.2.0
check "no temporary files left" no_leftovers
check "the lock is released: a second request goes through" sh -c "! [ -e '$dir/.update.lock.d' ]"
request_version v0.3.0
echo ok >"$FAKE/scenario"
update
check "and a second update right after works" status_is "done"

# The status of an earlier run is replaced, never left in place to be mistaken for the new one.
new_case replaces-old-status
set_case
echo '{"state":"done","phase":"done","from":"v0.0.9","to":"v0.1.0","message":"old","started_at":"a","finished_at":"b"}' >"$status_file"
request_version v0.2.0
echo block >"$FAKE/scenario"
(update) &
waiter=$!
n=0
while [ ! -f "$FAKE/blocked" ] && [ "$n" -lt 100 ]; do command -p sleep 0.1; n=$((n + 1)); done
check "while it runs the status is running, with this run's versions" sh -c "grep -q '\"state\":\"running\"' '$status_file' && grep -q '\"to\":\"v0.2.0\"' '$status_file'"
check "and the phase is backup" [ "$(field phase)" = backup ]
check "and it was not finished" [ -z "$(field finished_at)" ]
echo go >"$FAKE/go"
wait "$waiter"
check "the run ends done" status_is "done"

# ---- two at once ------------------------------------------------------------------------------------------------------
new_case concurrent
set_case
request_version v0.2.0
echo block >"$FAKE/scenario"
(update) &
first=$!
n=0
while [ ! -f "$FAKE/blocked" ] && [ "$n" -lt 100 ]; do command -p sleep 0.1; n=$((n + 1)); done
request_version v0.3.0
second_out=$root/concurrent/second-out
PATH=$root/bin:$PATH KEELSON_RELEASE_URL=file://$rel sh "$update_sh" --dir "$dir" >"$second_out" 2>&1
second_rc=$?
check "the second run is refused" [ "$second_rc" -ne 0 ]
check "it says another update is running" has "$second_out" "another update is running"
check "the second request is left for when the first is over" [ -e "$dir/run/update-request.json" ]
check "the first run's status was not touched" sh -c "grep -q '\"to\":\"v0.2.0\"' '$status_file' && grep -q '\"state\":\"running\"' '$status_file'"
echo go >"$FAKE/go"
wait "$first"
check "the first run still finishes" status_is "done"
check "only the first request ran" [ "$(cat "$FAKE/install.args")" = "--dir $dir --version v0.2.0" ]

# A lock left by a run that died does not block the next one (mkdir fallback of a machine without flock).
new_case stale-lock
set_case
mkdir "$dir/.update.lock.d"
(exit 0) &
dead=$!
wait "$dead"
printf '%s' "$dead" >"$dir/.update.lock.d/pid"
request_version v0.2.0
update
if command -v flock >/dev/null 2>&1; then
  check "(flock machine) the stale directory is ignored" status_is "done"
else
  check "a lock of a process that is gone is taken over" status_is "done"
fi

# ---- the release cannot be had ----------------------------------------------------------------------------------------
new_case no-release
set_case
request_version v0.2.0
PATH=$root/bin:$PATH KEELSON_RELEASE_URL=file://$root/nowhere sh "$update_sh" --dir "$dir" >"$out" 2>&1
check "an unreachable release fails" status_is failed
check "the phase says downloading" [ "$(field phase)" = downloading ]
check "it says nothing was changed" has "$status_file" "Nothing was changed"
check "the stack was left alone" not docker_called '^compose down'

new_case not-a-script
set_case
request_version v0.2.0
mkdir "$root/notscript"
printf '<html>404 not found</html>\nif then fi (\n' >"$root/notscript/install.sh"
PATH=$root/bin:$PATH KEELSON_RELEASE_URL=file://$root/notscript sh "$update_sh" --dir "$dir" >"$out" 2>&1
check "a download that is not a script is refused" status_is failed
check "the stack was left alone" not docker_called '^compose down'
check "the stack was not restarted" [ ! -e "$FAKE/install.args" ]

# ---- install.sh fails: the previous version comes back -----------------------------------------------------------------
expect_rolled_back() { # cause text
  check "exits non-zero" [ "$rc" -ne 0 ]
  check "status is rolled_back" status_is rolled_back
  check "phase is rolling-back" [ "$(field phase)" = rolling-back ]
  check "the cause is in the message" has "$status_file" "$1"
  check "the message names the version it went back to" has "$status_file" "Went back to v0.1.0"
  check "status is valid JSON" json_valid
  check "finished_at is set" [ -n "$(field finished_at)" ]
  check ".env is back at the previous version" has "$dir/.env" KEELSON_VERSION=v0.1.0
  check "other .env values are as they were" has "$dir/.env" KEELSON_PORT=3999
  check "the previous version is running" [ "$(cat "$FAKE/container")" = c-v0.1.0 ]
  check "the stack went down, then up without pulling anything" before '^compose down' '^compose up'
  check "up does not pull" docker_called '^compose up -d --pull never --wait'
  check "nothing was pulled" not docker_called '^compose pull'
  check "no temporary files left" no_leftovers
}

new_case rollback-late
set_case
request_version v0.2.0
echo late >"$FAKE/scenario"
update
expect_rolled_back "the dashboard did not become healthy"
check "the database copy made by this run was restored, not an older one" has "$FAKE/docker.log" "sh dashboard-20300101-000000.db"
check "it is restored by the image already on the machine, with nothing pulled" docker_called '^run --rm --user 0:0 --entrypoint sh -v keelson_data:/data -v '"$dir"'/backups:/b:ro sha256:image-of-c-v0.1.0 -c '
# shellcheck disable=SC2016
check "the file is read from /b and written to the data volume" has "$FAKE/docker.log" '/b/$1'
check "the restore happens after down" before '^compose down' '^run'
check "and before up" before '^run' '^compose up'
check "the database restore is part of the message" has "$status_file" "The database is the copy made before the update."

new_case rollback-unhealthy
set_case
request_version v0.2.0
echo ok >"$FAKE/scenario"
echo unhealthy >"$FAKE/health-c-v0.2.0"
update
expect_rolled_back "the dashboard is not healthy"
check "the database copy was restored" docker_called '^run '

new_case rollback-pull
set_case
request_version v0.2.0
echo pull >"$FAKE/scenario"
update
expect_rolled_back "could not pull the images"
check "the cause is the installer's own, without its advice" lacks "$status_file" "Fix it and run this again"
check "the dashboard was not replaced: the database is not touched" not docker_called '^run '

new_case rollback-early
set_case
request_version v0.2.0
echo early >"$FAKE/scenario"
update
expect_rolled_back "cannot talk to docker"
check "no database restore (nothing was replaced)" not docker_called '^run '

# install.sh exits non-zero without a line of its own to blame: the status still says why.
new_case rollback-silent
set_case
request_version v0.2.0
cp "$rel/install.sh" "$root/install.sh.keep"
printf '#!/bin/sh\nexit 7\n' >"$rel/install.sh"
update
cp "$root/install.sh.keep" "$rel/install.sh"
expect_rolled_back "the installer exited with status 7"

# A new container that is replaced but left no copy of the database: say so, restore nothing.
new_case rollback-no-copy
set_case
request_version v0.2.0
cp "$rel/install.sh" "$root/install.sh.keep"
# shellcheck disable=SC2016
printf '#!/bin/sh\nsed "s/^KEELSON_VERSION=.*/KEELSON_VERSION=$4/" "$2/.env" >"$2/.env.new" && mv "$2/.env.new" "$2/.env"\necho "c-$4" >"$FAKE/container"\necho "keelson install: broke" >&2\nexit 1\n' >"$rel/install.sh"
update
cp "$root/install.sh.keep" "$rel/install.sh"
expect_rolled_back "broke"
check "no copy was restored (the one that was there before is not this run's)" not docker_called '^run '
check "the message says there was no copy" has "$status_file" "No copy of the database was made before the update"

# ---- the rollback fails too -------------------------------------------------------------------------------------------
new_case rollback-up-fails
set_case
request_version v0.2.0
echo late >"$FAKE/scenario"
echo 1 >"$FAKE/up-rc"
update
check "exits non-zero" [ "$rc" -ne 0 ]
check "status is failed, not rolled_back" status_is failed
check "the message names both failures" has "$status_file" "going back to v0.1.0 failed too"
check "the cause of the first is in it" has "$status_file" "the dashboard did not become healthy"
check "the message tells where to look" has "$status_file" "update.log"
check "status is valid JSON" json_valid

new_case rollback-restore-fails
set_case
request_version v0.2.0
echo late >"$FAKE/scenario"
echo 1 >"$FAKE/run-rc"
update
check "status is failed" status_is failed
check "it says the copy could not be restored" has "$status_file" "could not be restored"
check "the old version is not started over a database it cannot read" not docker_called '^compose up'

new_case rollback-unhealthy-after
set_case
request_version v0.2.0
echo ok >"$FAKE/scenario"
echo unhealthy >"$FAKE/health-c-v0.2.0"
echo unhealthy >"$FAKE/health-c-v0.1.0"
update
check "a previous version that does not come up healthy is a failure" status_is failed

# Quotes and backslashes of a message never break the status file.
new_case message-quoting
set_case
request_version v0.2.0
cp "$rel/install.sh" "$root/install.sh.keep"
printf '#!/bin/sh\necho "keelson install: say \\"no\\" \\\\ to C:\\\\path" >&2\nexit 1\n' >"$rel/install.sh"
update
cp "$root/install.sh.keep" "$rel/install.sh"
check "status is valid JSON with quotes and backslashes in the cause" json_valid
check "the status is rolled_back" status_is rolled_back

echo
if [ "$failures" -ne 0 ]; then
  printf 'update-test: %s of %s checks failed\n' "$failures" "$checks"
  exit 1
fi
printf 'update-test: %s checks passed\n' "$checks"
