#!/bin/sh
# Updates the Keelson dashboard when the dashboard asks for it. Run as root by the systemd unit keelson-update.service, which
# keelson-update.path starts when the dashboard writes DIR/run/update-request.json; install.sh installs all three. Not meant to
# be run by hand, but safe to: `sh update.sh --dir /opt/keelson` handles a request file that is there and does nothing otherwise.
#
#   update.sh [--dir /opt/keelson]
#
# DIR/run is shared with the dashboard container (mounted at /run/keelson), which can write there: the request file is UNTRUSTED
# input. Only the "version" string is read from it and only a plain release version (vMAJOR.MINOR.PATCH) strictly newer than
# the one in DIR/.env is accepted; nothing else of the file is used, and nothing from it is ever put into a command. The file
# is deleted before anything is done, so a failing update cannot loop. Everything this script writes goes to DIR (root's) first
# and is renamed into DIR/run, never written through a path the container controls.
#
# What it does: downloads install.sh of that release (https://github.com/0x2u/keelson/releases, or KEELSON_RELEASE_URL, the
# testing hook install.sh has too: file:// works) and runs it with --dir and --version: it copies the database to DIR/backups,
# pulls the images and starts them. If install.sh fails, or the dashboard is not healthy afterwards, the previous version is put
# back: the stack stops, the files and the database copy made by this run are restored (the previous image already on the
# machine does it: nothing is pulled), and the previous version starts again. DIR/run/update-status.json tells how far it got:
#   {"state":"running|done|failed|rolled_back","phase":"validating|downloading|backup|pulling|starting|rolling-back|done",
#    "from":"v0.1.0","to":"v0.2.0","message":"...","started_at":"<ISO>","finished_at":"<ISO or empty>"}
# and the output of the run is DIR/update.log.
set -eu
umask 077
HOME=${HOME:-/root}
export HOME

repo=0x2u/keelson
dir=/opt/keelson

log_ready=
say() {
  printf 'keelson update: %s\n' "$*"
  [ -z "$log_ready" ] || printf 'keelson update: %s\n' "$*" >>"$log"
}
die() { printf 'keelson update: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case $1 in
    --dir) [ $# -ge 2 ] || die "--dir needs a directory"; dir=$2; shift 2 ;;
    -h | --help) say "usage: update.sh [--dir /opt/keelson]"; exit 0 ;;
    *) die "unknown option $1 (try --help)" ;;
  esac
done
dir=$(cd "$dir" 2>/dev/null && pwd) || die "$dir is not a directory"
run=$dir/run
req=$run/update-request.json
status=$run/update-status.json
log=$dir/update.log
[ -d "$run" ] || die "$run does not exist: run install.sh again to set the updater up"

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ---- the lock --------------------------------------------------------------------------------------------------------
# One run at a time. A second run leaves the request file alone: it is handled when the first one is over (the path unit looks
# at the file again then).
lockdir=
cleanup_lock() { [ -z "$lockdir" ] || rm -rf "$lockdir"; }
if command -v flock >/dev/null 2>&1; then
  exec 9>"$dir/.update.lock"
  flock -n 9 || die "another update is running: this request waits for it"
else
  lockdir=$dir/.update.lock.d
  if ! mkdir "$lockdir" 2>/dev/null; then
    holder=$(cat "$lockdir/pid" 2>/dev/null || true)
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
      rm -rf "$lockdir"
      mkdir "$lockdir" 2>/dev/null || die "another update is running: this request waits for it"
    else
      lockdir=
      die "another update is running: this request waits for it"
    fi
  fi
  printf '%s' "$$" >"$lockdir/pid"
fi

# ---- the status ------------------------------------------------------------------------------------------------------
from=
to=
phase=validating
started_at=$(now)
have_status=
final=
work=

# Strips what would break the JSON out of a sentence: control characters, backslashes and double quotes; keeps it short.
jstr() { printf '%s' "$1" | tr -d '\000-\037\177' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | cut -c1-400; }

# mv -T never moves a file into a directory that sits where the target should be; where it is missing the target is cleared first.
mv_t=
status_move() { # file target
  if [ -L "$2" ] || [ -d "$2" ]; then rm -rf "$2"; fi
  if [ -z "$mv_t" ]; then
    : >"$dir/.update-probe"
    if mv -T "$dir/.update-probe" "$dir/.update-probe2" 2>/dev/null; then mv_t=-T; else mv_t=none; fi
    rm -f "$dir/.update-probe" "$dir/.update-probe2"
  fi
  if [ "$mv_t" = -T ]; then mv -fT "$1" "$2"; else mv -f "$1" "$2"; fi
}

write_status() { # state phase message
  phase=$2
  finished=
  case $1 in running) ;; *) finished=$(now); final=1 ;; esac
  have_status=1
  [ -z "$work" ] || printf '%s' "$2" >"$work/phase" # the install.sh pipeline below runs in a subshell: this is how its phase comes back
  {
    printf '{"state":"%s","phase":"%s","from":"%s","to":"%s","message":"%s","started_at":"%s","finished_at":"%s"}\n' \
      "$1" "$2" "$(jstr "$from")" "$(jstr "$to")" "$(jstr "$3")" "$started_at" "$finished" >"$dir/.update-status.$$" &&
      chmod 644 "$dir/.update-status.$$" &&
      status_move "$dir/.update-status.$$" "$status"
  } || say "warning: could not write $status"
  rm -f "$dir/.update-status.$$"
}

# Whatever ends the script, the status says how: a run that stops unexpectedly (a signal, a failing command) is a failure.
on_exit() {
  code=$?
  trap - EXIT
  if [ -n "$have_status" ] && [ -z "$final" ]; then
    write_status failed "$phase" "The update stopped unexpectedly. The log is $log."
  fi
  [ -z "$work" ] || rm -rf "$work"
  cleanup_lock
  exit "$code"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

fail() { # message
  say "$1"
  write_status failed "$phase" "$1"
  exit 1
}

# ---- the request -----------------------------------------------------------------------------------------------------
if [ ! -e "$req" ] && [ ! -L "$req" ]; then
  say "no update request in $run: nothing to do"
  exit 0
fi
: >"$log"
chmod 600 "$log"
log_ready=1
raw=
if [ -f "$req" ] && [ ! -L "$req" ]; then raw=$(dd if="$req" bs=4096 count=1 2>/dev/null || true); fi
rm -rf -- "$req" # first, so a request that fails once does not come back
write_status running validating "Checking the request."

# A release version: v, then three numbers (at most 9 digits each, so the arithmetic below cannot overflow), nothing else.
semver_ok() { # text
  case $1 in v*.*.*) ;; *) return 1 ;; esac
  v=${1#v}
  case $v in *[!0-9.]* | .* | *..* | *.) return 1 ;; esac
  v1=${v%%.*}
  v2=${v#*.}
  v3=${v2#*.}
  v2=${v2%%.*}
  case $v3 in *.*) return 1 ;; esac
  for n in "$v1" "$v2" "$v3"; do
    [ -n "$n" ] && [ "${#n}" -le 9 ] || return 1
  done
}

# a > b, component by component, as numbers (`[ -gt ]` reads 08 as 8).
semver_gt() { # a b
  a=${1#v}
  b=${2#v}
  a1=${a%%.*}; a2=${a#*.}; a3=${a2#*.}; a2=${a2%%.*}
  b1=${b%%.*}; b2=${b#*.}; b3=${b2#*.}; b2=${b2%%.*}
  [ "$a1" -eq "$b1" ] || { [ "$a1" -gt "$b1" ]; return; }
  [ "$a2" -eq "$b2" ] || { [ "$a2" -gt "$b2" ]; return; }
  [ "$a3" -gt "$b3" ]
}

# The one "version" member of the request (more than one, or none, is not a request this dashboard writes).
compact=$(printf '%s' "$raw" | tr -d '\n\r')
hits=$(printf '%s' "$compact" | grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' || true)
case $hits in
  "" | *"
"*) fail "The update request is not valid: it must name one version." ;;
esac
to=$(printf '%s' "$hits" | sed 's/^"version"[[:space:]]*:[[:space:]]*"\(.*\)"$/\1/')
semver_ok "$to" || { to=; fail "The update request is not valid: the version must look like v0.2.0."; }

from=$(sed -n 's/^KEELSON_VERSION=//p' "$dir/.env" 2>/dev/null | tail -1 || true)
if ! semver_ok "$from"; then
  shown=$from
  from=
  fail "The version in $dir/.env is '${shown:-none}': pin a release first, by running the install command again with --version $to."
fi
semver_gt "$to" "$from" || fail "$to is not newer than $from: updating only goes forward (restore a backup to go back)."

command -v docker >/dev/null 2>&1 || fail "docker is not installed or not on the PATH of this service."

# ---- what a rollback needs: the files as they are, the container, the image, the copies already there --------------------
work=$(mktemp -d "$dir/.update.XXXXXX") || fail "cannot write in $dir."
mkdir "$work/snap"
for f in .env compose.yaml compose.tls.yaml Caddyfile; do
  [ ! -f "$dir/$f" ] || cp -p "$dir/$f" "$work/snap/$f"
done
cd "$dir"
before_id=$(docker compose ps -q dashboard 2>/dev/null | sed -n 1p || true)
before_image=
[ -z "$before_id" ] || before_image=$(docker inspect -f '{{.Image}}' "$before_id" 2>/dev/null || true)
{ ls -1 "$dir"/backups/dashboard-*.db 2>/dev/null || true; } >"$work/copies-before"

# ---- download install.sh of the release --------------------------------------------------------------------------------
write_status running downloading "Downloading the installer of $to."
if [ -n "${KEELSON_RELEASE_URL:-}" ]; then base=$KEELSON_RELEASE_URL; else base=https://github.com/$repo/releases/download/$to; fi
if command -v curl >/dev/null 2>&1; then
  curl -fsSL --max-time 120 "$base/install.sh" -o "$work/install.sh" || fail "Could not download $base/install.sh: is $to a published release? Nothing was changed."
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$work/install.sh" -T 120 "$base/install.sh" || fail "Could not download $base/install.sh: is $to a published release? Nothing was changed."
else
  fail "Neither curl nor wget is installed. Nothing was changed."
fi
if [ ! -s "$work/install.sh" ] || ! sh -n "$work/install.sh" 2>/dev/null; then
  fail "What was downloaded from $base/install.sh is not a script. Nothing was changed."
fi

# ---- install.sh ------------------------------------------------------------------------------------------------------
# Its progress lines move the phase (they are read in a pipeline, so the phase and the last error go through files).
write_status running backup "Copying the database, then updating to $to."
: >"$work/rc"
: >"$work/err"
(
  rc=0
  sh "$work/install.sh" --dir "$dir" --version "$to" </dev/null 2>&1 || rc=$?
  printf '%s' "$rc" >"$work/rc"
) | while IFS= read -r line; do
  printf '%s\n' "$line" >>"$log"
  case $line in
    "pulling Keelson "*) write_status running pulling "Pulling the images of $to." ;;
    "starting") write_status running starting "Starting $to: the dashboard restarts." ;;
    "keelson install: "*) printf '%s' "${line#keelson install: }" >"$work/err" ;;
  esac
done
install_rc=$(cat "$work/rc" 2>/dev/null || true)
phase=$(cat "$work/phase" 2>/dev/null || true)
[ -n "$phase" ] || phase=backup

# The dashboard's container is up and healthy (or running, for an image without a health check), within a minute.
dashboard_healthy() {
  tries=0
  while [ "$tries" -lt 30 ]; do
    id=$(docker compose ps -q dashboard 2>/dev/null | sed -n 1p || true)
    if [ -n "$id" ]; then
      state=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || true)
      case $state in healthy | running) return 0 ;; esac
    fi
    tries=$((tries + 1))
    sleep 2
  done
  return 1
}

# The previous version again: the stack stops, the files and the database copy of this run are put back, the old version starts
# from the image that is already here.
rollback() { # cause
  cause=${1%.}
  say "updating to $to failed ($cause): going back to $from"
  write_status running rolling-back "Updating to $to failed ($cause). Going back to $from."
  after_id=$(docker compose ps -a -q dashboard 2>/dev/null | sed -n 1p || true)
  problem=
  note=
  docker compose down >>"$log" 2>&1 || problem="the stack did not stop"
  for f in .env compose.yaml compose.tls.yaml Caddyfile; do
    [ ! -f "$work/snap/$f" ] || cp -p "$work/snap/$f" "$dir/$f"
  done
  # Only a dashboard that was replaced can have migrated the database forward: before that the copy would only lose what was written since.
  if [ -z "$problem" ] && [ "$after_id" != "$before_id" ]; then
    { ls -1 "$dir"/backups/dashboard-*.db 2>/dev/null || true; } >"$work/copies-after"
    copy=$(grep -vxFf "$work/copies-before" "$work/copies-after" 2>/dev/null | sort | tail -n 1 || true)
    name=${copy##*/}
    case $name in
      dashboard-*.db) ;;
      *) name= ;;
    esac
    case $name in *[!A-Za-z0-9._-]*) name= ;; esac
    if [ -z "$name" ]; then
      note="No copy of the database was made before the update, so it is as the new version left it."
    else
      image=$before_image
      if [ -z "$image" ]; then
        kimage=$(sed -n 's/^KEELSON_IMAGE=//p' "$work/snap/.env" 2>/dev/null | tail -1 || true)
        image=${kimage:-ghcr.io/$repo-dashboard}:$from
      fi
      say "restoring the database from $name"
      docker run --rm --user 0:0 --entrypoint sh -v keelson_data:/data -v "$dir/backups:/b:ro" "$image" \
        -c 'rm -f /data/dashboard.db-wal /data/dashboard.db-shm && cp "/b/$1" /data/dashboard.db && chown 1000:1000 /data/dashboard.db' sh "$name" >>"$log" 2>&1 ||
        problem="the database copy $name could not be restored"
      [ -n "$problem" ] || note="The database is the copy made before the update."
    fi
  fi
  if [ -z "$problem" ]; then
    docker compose up -d --pull never --wait --wait-timeout 180 >>"$log" 2>&1 || problem="$from did not start"
  fi
  if [ -z "$problem" ] && dashboard_healthy; then
    write_status rolled_back rolling-back "Updating to $to failed ($cause). Went back to $from.${note:+ $note}"
    say "went back to $from"
    exit 1
  fi
  fail "Updating to $to failed ($cause), and going back to $from failed too (${problem:-the dashboard is not healthy}). Look at $log, then run docker compose up -d in $dir."
}

if [ "$install_rc" != 0 ]; then
  err=$(sed -e 's/ *(log above).*$//' -e 's/\. *Fix it and run this again\.$//' "$work/err" 2>/dev/null || true)
  rollback "${err:-the installer exited with status ${install_rc:-unknown}}"
fi
write_status running starting "Waiting for $to to be healthy."
dashboard_healthy || rollback "the dashboard is not healthy"
write_status "done" "done" "Updated to $to."
say "updated to $to"
