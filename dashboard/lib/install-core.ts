// The /install script a server runs to connect itself to this dashboard, and the commands the dashboard shows for it. Pure: the
// route only decides which origin to bake in. The script never prints the code or any secret, and refuses to start when it
// was cut short (everything is inside main, called on the last line).

/** The origin an agent is told to connect to is where it sends its code and secrets and where it fetches its binary from: in the clear, anyone on the way could read or swap them. */
const LOOPBACK_HTTP = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/;

/** Why a dashboard address cannot be given to a machine that connects out, or null when it can: https, or plain http to this very machine. */
export function originProblem(origin: string): string | null {
  if (/^https:\/\//.test(origin) || LOOPBACK_HTTP.test(origin)) return null;
  return "This dashboard is reached over plain http: a machine would send it its secrets in the clear. Serve it over https and set KEELSON_PUBLIC_URL to that address.";
}

/** Whether a dashboard address only reaches this very machine (plain http to loopback): a command built on it cannot work from another machine. */
export function isLocalOrigin(origin: string): boolean {
  return LOOPBACK_HTTP.test(origin);
}

/** `text` as one word of POSIX sh: left as it is when it holds nothing the shell treats specially, else in single quotes. */
export function shellQuote(text: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
}

/** The command that connects a server: the one the Add server page shows. */
export function installLine(origin: string, code: string): string {
  return `curl -fsSL ${shellQuote(`${origin}/install`)} | sudo sh -s -- --code ${shellQuote(code)}`;
}

/** The command that replaces the agent of a server that was connected this way, keeping how it was set up. */
export function upgradeLine(origin: string, code: string): string {
  return `curl -fsSL ${shellQuote(`${origin}/install`)} | sudo sh -s -- --upgrade --code ${shellQuote(code)}`;
}

/** The body of /install for this dashboard. `origin` must have passed `originProblem`. */
export function installScript(origin: string): string {
  const quoted = shellQuote(origin);
  return `#!/bin/sh
# Connects this server to the Keelson dashboard it was fetched from.
#   curl -fsSL DASHBOARD/install | sudo sh -s -- --code CODE [--name NAME]
#   ... | sudo sh -s -- --upgrade --code CODE      replaces the agent, keeping how it was set up
# The code is made on the dashboard (Servers > Add server), works once and expires in 30 minutes. Nothing is printed of it.
set -eu

ORIGIN=${quoted}

say() { echo "keelson: $*" >&2; }
fail() { say "$*"; exit 1; }

usage() {
  echo "usage: curl -fsSL $ORIGIN/install | sudo sh -s -- --code CODE [--name NAME] [--upgrade]"
}

main() {
  code=""
  name=""
  upgrade=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --code)
        [ $# -ge 2 ] || fail "--code needs a value"
        code=$2
        shift 2
        ;;
      --name)
        [ $# -ge 2 ] || fail "--name needs a value"
        name=$2
        shift 2
        ;;
      --upgrade)
        upgrade=1
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        usage >&2
        fail "unknown option: $1"
        ;;
    esac
  done
  [ -n "$code" ] || fail "--code is required: make one on the dashboard, under Servers > Add server"
  case "$code" in
    *[!A-Za-z0-9_-]*) fail "the code has characters a code never has: copy the whole command again" ;;
  esac

  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  case "$os" in
    linux | darwin) ;;
    *) fail "unsupported operating system: $os (Keelson runs on Linux, and a Mac can connect as a build machine)" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) fail "unsupported processor: $(uname -m) (amd64 and arm64 are supported)" ;;
  esac

  if [ "$os" = linux ]; then
    [ "$(id -u)" -eq 0 ] || fail "this installs a service and needs root: run it as  curl -fsSL $ORIGIN/install | sudo sh -s -- --code CODE"
  else
    [ "$(id -u)" -ne 0 ] || fail "on a Mac run this as yourself, without sudo: the Mac connects as a build machine and keeps its files in your home directory"
    [ "$upgrade" -eq 0 ] || fail "--upgrade is for servers: on a Mac, run the connect command from the Add server page again"
  fi

  command -v curl >/dev/null 2>&1 || fail "curl is required"
  # On a server the agent's install checks for Docker (a socket counts as well as the command) before the code is spent.
  if [ "$os" = darwin ] && ! command -v docker >/dev/null 2>&1; then
    say "warning: docker was not found: builds fail until Docker runs on this Mac"
  fi

  if [ "$os" = linux ]; then
    tmp=$(mktemp -d) || fail "could not create a temporary directory"
    trap 'rm -rf "$tmp"' EXIT
    trap 'exit 1' HUP INT TERM
    bin=$tmp/keelson-agent
  else
    bin=./keelson-agent
  fi

  say "downloading the agent for $os/$arch"
  hdr="$bin.headers"
  curl -fsSL -D "$hdr" "$ORIGIN/api/relay/binary?os=$os&arch=$arch&code=$code" -o "$bin" || fail "could not download the agent from $ORIGIN: the code may have expired or been used. Make a new one on the dashboard."
  [ -s "$bin" ] || fail "the download was empty"
  # The dashboard announces the SHA-256 of the binary it serves: a corrupted or altered download is refused before anything runs.
  # (An older dashboard sends none, and a machine without a hashing tool cannot check: both go on, as before.)
  want=$(tr -d '\\r' < "$hdr" 2>/dev/null | awk 'tolower($1)=="x-checksum-sha256:" {print tolower($2)}' | tail -n 1)
  have=""
  if command -v sha256sum >/dev/null 2>&1; then
    have=$(sha256sum "$bin" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    have=$(shasum -a 256 "$bin" | awk '{print $1}')
  fi
  rm -f "$hdr"
  if [ -n "$want" ] && [ -n "$have" ] && [ "$want" != "$have" ]; then
    fail "the downloaded agent does not match the checksum this dashboard announced (a damaged download, or something changed it on the way): nothing was installed"
  fi
  chmod +x "$bin"
  "$bin" version >/dev/null 2>&1 </dev/null || fail "the downloaded agent does not run on this machine ($os/$arch)"

  if [ "$os" = darwin ]; then
    say "connecting this Mac as a build machine; leave this window open (Ctrl-C disconnects it)"
    connection="ksr1.$(printf '{"u":"%s","c":"%s"}' "$ORIGIN" "$code" | base64 | tr '+/' '-_' | tr -d '=\\n')"
    exec "$bin" connect "$connection" </dev/null
  fi

  if [ "$upgrade" -eq 1 ]; then
    "$bin" install --upgrade </dev/null
  elif [ -n "$name" ]; then
    "$bin" install --dashboard "$ORIGIN" --code "$code" --name "$name" </dev/null
  else
    "$bin" install --dashboard "$ORIGIN" --code "$code" </dev/null
  fi
}

main "$@"
`;
}

/** A script that only says why this dashboard cannot give a real one, for a request it cannot answer: safe to pipe into sh. */
export function installRefusal(reason: string): string {
  return `#!/bin/sh\necho ${shellQuote(`keelson: ${reason.replace(/[\r\n]+/g, " ")}`)} >&2\nexit 1\n`;
}
