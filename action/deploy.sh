#!/usr/bin/env bash
# Deploys an image through a Keelson agent and waits for the result.
#
# Reads its configuration from KEELSON_* environment variables (see
# action.yml). Exits 0 only when the deployment ended as "succeeded".
set -euo pipefail

fail() {
  echo "::error::$*" >&2
  exit 1
}

for tool in curl openssl jq; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required on the runner"
done

: "${KEELSON_URL:?url is required}"
: "${KEELSON_APP:?app is required}"
: "${KEELSON_DEPLOY_SECRET:?deploy-secret is required}"
: "${KEELSON_READ_TOKEN:?read-token is required}"
TIMEOUT="${KEELSON_TIMEOUT:-600}"

# Keep secrets out of the log even if a later line fails verbosely.
echo "::add-mask::$KEELSON_DEPLOY_SECRET"
echo "::add-mask::$KEELSON_READ_TOKEN"

[[ "$TIMEOUT" =~ ^[0-9]+$ && "$TIMEOUT" -ge 1 ]] || fail "timeout must be a positive number of seconds"
[[ "$KEELSON_APP" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || fail "app has an invalid name"

BASE="${KEELSON_URL%/}"
case "$BASE" in
  https://*) ;;
  http://*)
    [[ "${KEELSON_ALLOW_INSECURE_HTTP:-false}" == "true" ]] ||
      fail "refusing plain http: the read token would travel unencrypted (set allow-insecure-http for local testing)"
    ;;
  *) fail "url must start with https://" ;;
esac

# The request body is built from validated values only, so nothing needs
# JSON escaping and nothing can break out of the string.
# The time of the commit, when the workflow knows it: the agent records it for the lead time of a change. Anything that
# is not an RFC 3339 instant is left out rather than failing a deployment over a date.
COMMITTED=""
if [[ "${KEELSON_COMMITTED_AT:-}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$ ]]; then
  COMMITTED=",\"committed_at\":\"$KEELSON_COMMITTED_AT\""
fi

if [[ -n "${KEELSON_DIGEST:-}" ]]; then
  [[ "$KEELSON_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "digest must look like sha256:<64 hex characters>"
  BODY="{\"digest\":\"$KEELSON_DIGEST\"$COMMITTED}"
  WHAT="$KEELSON_DIGEST"
else
  [[ "${KEELSON_TAG:-}" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || fail "tag is empty or contains characters Docker does not allow"
  BODY="{\"tag\":\"$KEELSON_TAG\"$COMMITTED}"
  WHAT="$KEELSON_TAG"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
chmod 700 "$WORK"

# TLS options shared by every request.
CURL_TLS=()
if [[ -n "${KEELSON_CA_CERT:-}" ]]; then
  printf '%s\n' "$KEELSON_CA_CERT" >"$WORK/ca.pem"
  CURL_TLS+=(--cacert "$WORK/ca.pem")
fi
if [[ -n "${KEELSON_CLIENT_CERT:-}" || -n "${KEELSON_CLIENT_KEY:-}" ]]; then
  [[ -n "${KEELSON_CLIENT_CERT:-}" && -n "${KEELSON_CLIENT_KEY:-}" ]] || fail "client-cert and client-key must be set together"
  printf '%s\n' "$KEELSON_CLIENT_CERT" >"$WORK/client.pem"
  printf '%s\n' "$KEELSON_CLIENT_KEY" >"$WORK/client.key"
  chmod 600 "$WORK/client.key"
  CURL_TLS+=(--cert "$WORK/client.pem" --key "$WORK/client.key")
fi

# curl config files keep the bearer token out of the process list.
printf 'header = "Authorization: Bearer %s"\n' "$KEELSON_READ_TOKEN" >"$WORK/auth.conf"
chmod 600 "$WORK/auth.conf"

api_get() { # path [extra curl args...]
  local path="$1"
  shift
  # ${arr[@]+...}: an empty array is "unbound" under set -u on bash < 4.4.
  curl -sS ${CURL_TLS[@]+"${CURL_TLS[@]}"} --config "$WORK/auth.conf" "$@" "$BASE$path"
}

# --- start the deployment ----------------------------------------------------

PATH_DEPLOY="/v1/apps/$KEELSON_APP/deploy"
TS="$(date +%s)"
BODY_HASH="$(printf '%s' "$BODY" | openssl dgst -sha256 | awk '{print $NF}')"
# Canonical string and signature as documented in docs/reference/api.md: HMAC-SHA256 of
# "<timestamp>\nPOST\n<request URI>\n<hex sha256 of body>" keyed with the secret.
SIG="$(printf '%s\n%s\n%s\n%s' "$TS" POST "$PATH_DEPLOY" "$BODY_HASH" |
  openssl dgst -sha256 -hmac "$KEELSON_DEPLOY_SECRET" | awk '{print $NF}')"

echo "Deploying $WHAT to $KEELSON_APP via $BASE"
HTTP_CODE="$(curl -sS ${CURL_TLS[@]+"${CURL_TLS[@]}"} --max-time 30 -o "$WORK/start.json" -w '%{http_code}' \
  -X POST -H "X-Keelson-Timestamp: $TS" -H "X-Keelson-Signature: $SIG" \
  -H 'Content-Type: application/json' --data "$BODY" "$BASE$PATH_DEPLOY")" ||
  fail "could not reach the agent at $BASE"

case "$HTTP_CODE" in
  202) ;;
  401) fail "the agent rejected the signature (wrong deploy-secret, or the runner clock is off by more than 5 minutes)" ;;
  404) fail "the agent does not know the app '$KEELSON_APP'" ;;
  409) fail "a deployment is already running for '$KEELSON_APP': try again when it has finished" ;;
  *) fail "the agent answered HTTP $HTTP_CODE: $(head -c 300 "$WORK/start.json")" ;;
esac

ID="$(jq -er '.deployment_id' "$WORK/start.json")" || fail "the agent's answer had no deployment_id"
[[ "$ID" =~ ^[a-f0-9]+$ ]] || fail "the agent returned an unexpected deployment id"
echo "deployment $ID started"

# GITHUB_OUTPUT is unset when the script runs outside Actions.
emit() {
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo "$1=$2" >>"$GITHUB_OUTPUT"; fi
}
emit deployment-id "$ID"

# --- follow it ---------------------------------------------------------------

DEADLINE=$((SECONDS + TIMEOUT))
LAST_SEQ=0
STATUS=""

# The events endpoint replays the whole log, so after a dropped connection we
# simply reconnect and skip what was already printed.
while [[ -z "$STATUS" ]]; do
  REMAINING=$((DEADLINE - SECONDS))
  if ((REMAINING <= 0)); then
    emit status timeout
    fail "timed out after ${TIMEOUT}s: deployment $ID may still be running on the agent"
  fi

  EVENT=""
  while IFS= read -r line; do
    case "$line" in
      "event: "*) EVENT="${line#event: }" ;;
      "data: "*)
        DATA="${line#data: }"
        case "$EVENT" in
          event)
            SEQ="$(jq -r '.seq' <<<"$DATA")"
            if ((SEQ > LAST_SEQ)); then
              jq -r '"\(.time | sub("\\.[0-9]+Z$"; "Z")) \(.level | ascii_upcase | .[0:5]) \(.message)"' <<<"$DATA"
              LAST_SEQ="$SEQ"
            fi
            ;;
          end) STATUS="$(jq -r '.status' <<<"$DATA")" ;;
          error) echo "stream interrupted, reconnecting" >&2 ;;
        esac
        ;;
    esac
  done < <(api_get "/v1/deployments/$ID/events" -N --max-time "$REMAINING" 2>/dev/null || true)

  [[ -n "$STATUS" ]] || sleep 2
done

emit status "$STATUS"

# The record is the source of truth for the final result and the error text.
FINAL="$(api_get "/v1/deployments/$ID" --max-time 30)" || fail "could not read the final deployment record"
ERROR_TEXT="$(jq -r '.error // empty' <<<"$FINAL")"

case "$STATUS" in
  succeeded)
    echo "deployment $ID succeeded"
    ;;
  rolled_back)
    fail "deployment $ID failed and the previous version was restored: $ERROR_TEXT"
    ;;
  rollback_failed)
    fail "deployment $ID failed AND the previous version could not be restored, the app may be down: $ERROR_TEXT"
    ;;
  *)
    fail "deployment $ID ended as '$STATUS': $ERROR_TEXT"
    ;;
esac
