# API

The agent serves a versioned HTTP API (`/v1`) on its listener, or over its outbound connection for an agent that connects out ([relay](./relay.md)). The dashboard, the [GitHub Action](../github-action.md) and `curl` all use it. The dashboard exposes its own REST API for scripts and the MCP server ([Hosting](../hosting.md#api-tokens-rest-api-and-mcp)).

## Authentication

| Level | Routes | Credential |
|---|---|---|
| Public | `GET /v1/health`, `POST /v1/enroll` (only when enrolment is on) | none |
| Read | every other `GET` | `Authorization: Bearer <token>` (the API token, at least 32 characters) |
| Change | every `POST`, `PUT` and `DELETE` | an HMAC signature keyed with the deploy secret, which must differ from the API token |

With mutual TLS configured, every request without a verified client certificate is refused before any handler runs, `POST /v1/enroll` excepted. An optional `X-Keelson-Actor` header labels the sender in the audit log; it labels, it does not authenticate.

## Signed requests

Send the hex HMAC-SHA256, keyed with the deploy secret, of

```
<unix timestamp> \n <METHOD> \n <request URI with query> \n <hex sha256 of the body>
```

in `X-Keelson-Signature`, with the timestamp in `X-Keelson-Timestamp`. Timestamps more than 5 minutes off are refused, and an exact signature is accepted only once (replays get `401`).

```bash
ts=$(date +%s); path=/v1/apps/web/deploy; body='{"tag":"abc123"}'
bodyhash=$(printf '%s' "$body" | openssl dgst -sha256 | awk '{print $NF}')
sig=$(printf '%s\n%s\n%s\n%s' "$ts" POST "$path" "$bodyhash" | openssl dgst -sha256 -hmac "$(cat deploy-secret)" | awk '{print $NF}')
curl -X POST -H "X-Keelson-Timestamp: $ts" -H "X-Keelson-Signature: $sig" -d "$body" http://127.0.0.1:7070$path
```

Errors are JSON, `{"error": "..."}`, with the usual status codes (`400` a bad request, `401` bad credentials or signature, `404`, `409` a conflicting operation is running, `429`, `503`). A signed request on a full disk answers `507`.

## All routes

Each route is described on the page linked in the last column.

| Route | Auth | Described in |
|---|---|---|
| `DELETE /v1/apps/{app}/env` | signature | [environment](./environment.md) |
| `DELETE /v1/build-vars/{app}` | signature | [builds](./builds.md#building-on-one-server-running-on-another) |
| `DELETE /v1/config/apps/{name}` | signature | [configuration](./configuration.md#editing-the-configuration-while-the-agent-runs) |
| `DELETE /v1/config/databases/{name}` | signature | [configuration](./configuration.md#editing-the-configuration-while-the-agent-runs) |
| `DELETE /v1/config/jobs/{name}` | signature | [configuration](./configuration.md#editing-the-configuration-while-the-agent-runs) |
| `DELETE /v1/config/previews/{app}` | signature | [configuration](./configuration.md#editing-the-configuration-while-the-agent-runs) |
| `DELETE /v1/postgres/databases/{name}` | signature | [databases](./databases.md#managed-postgresql) |
| `DELETE /v1/previews/{app}/{pr}` | signature | [previews](./previews.md) |
| `DELETE /v1/projects/{name}/config` | signature | [configuration](./configuration.md#one-file-per-project) |
| `GET /metrics` | read token | [metrics](./metrics.md) |
| `GET /v1/apps` | read token | [deployments](./deployments.md#routes) |
| `GET /v1/apps/{app}/availability` | read token | [configuration](./configuration.md#editing-the-configuration-while-the-agent-runs) |
| `GET /v1/apps/{app}/env` | read token | [environment](./environment.md) |
| `GET /v1/audit` | read token | [configuration](./configuration.md#editing-the-configuration-while-the-agent-runs) |
| `GET /v1/build-vars/{app}` | read token | [builds](./builds.md#building-on-one-server-running-on-another) |
| `GET /v1/config` | read token | [configuration](./configuration.md#editing-the-configuration-while-the-agent-runs) |
| `GET /v1/config/versions` | read token | [configuration](./configuration.md#editing-the-configuration-while-the-agent-runs) |
| `GET /v1/config/versions/{id}` | read token | [configuration](./configuration.md#editing-the-configuration-while-the-agent-runs) |
| `GET /v1/containers` | read token | [agent](./agent.md#read-only-routes) |
| `GET /v1/containers/{id}` | read token | [agent](./agent.md#read-only-routes) |
| `GET /v1/containers/{id}/logs` | read token | [agent](./agent.md#read-only-routes) |
| `GET /v1/containers/{id}/stats` | read token | [agent](./agent.md#read-only-routes) |
| `GET /v1/databases` | read token | [databases](./databases.md#declaring-a-database) |
| `GET /v1/databases/{name}/backups` | read token | [databases](./databases.md#declaring-a-database) |
| `GET /v1/databases/{name}/live` | read token | [databases](./databases.md#declaring-a-database) |
| `GET /v1/databases/{name}/restores` | read token | [databases](./databases.md#declaring-a-database) |
| `GET /v1/databases/{name}/restore-tests` | read token | [databases](./databases.md#declaring-a-database) |
| `GET /v1/deployments` | read token | [deployments](./deployments.md#routes) |
| `GET /v1/deployments/{id}` | read token | [deployments](./deployments.md#routes) |
| `GET /v1/deployments/{id}/events` | read token | [deployments](./deployments.md#routes) |
| `GET /v1/health` | public | [agent](./agent.md#read-only-routes) |
| `GET /v1/info` | read token | [agent](./agent.md#read-only-routes) |
| `GET /v1/jobs` | read token | [jobs](./jobs.md) |
| `GET /v1/jobs/{name}/runs` | read token | [jobs](./jobs.md) |
| `GET /v1/notifications/history` | read token | [notifications](./notifications.md) |
| `GET /v1/postgres` | read token | [databases](./databases.md#managed-postgresql) |
| `GET /v1/previews` | read token | [previews](./previews.md) |
| `GET /v1/projects` | read token | [configuration](./configuration.md#one-file-per-project) |
| `GET /v1/projects/{name}/config` | read token | [configuration](./configuration.md#one-file-per-project) |
| `GET /v1/proofs` | read token | [databases](./databases.md#declaring-a-database) |
| `GET /v1/proxy` | read token | [proxy](./proxy.md#reading-the-proxy) |
| `GET /v1/stats/history` | read token | [configuration](./configuration.md#editing-the-configuration-while-the-agent-runs) |
| `GET /v1/stats/host` | read token | [configuration](./configuration.md#editing-the-configuration-while-the-agent-runs) |
| `GET /v1/system` | read token | [agent](./agent.md#read-only-routes) |
| `GET /v1/system/disk` | read token | [agent](./agent.md#read-only-routes) |
| `POST /v1/apps/{app}/build` | signature | [deployments](./deployments.md#routes) |
| `POST /v1/apps/{app}/deploy` | signature | [deployments](./deployments.md#routes) |
| `POST /v1/apps/{app}/image/export` | signature | [builds](./builds.md#building-on-one-server-running-on-another) |
| `POST /v1/apps/{app}/rollback` | signature | [deployments](./deployments.md#routes) |
| `POST /v1/builds` | signature | [builds](./builds.md#building-on-one-server-running-on-another) |
| `POST /v1/config/validate` | signature | [configuration](./configuration.md#editing-the-configuration-while-the-agent-runs) |
| `POST /v1/config/versions/{id}/restore` | signature | [configuration](./configuration.md#editing-the-configuration-while-the-agent-runs) |
| `POST /v1/containers/{name}/restart` | signature | [deployments](./deployments.md#routes) |
| `POST /v1/containers/{name}/start` | signature | [deployments](./deployments.md#routes) |
| `POST /v1/databases/{name}/restore` | signature | [databases](./databases.md#declaring-a-database) |
| `POST /v1/databases/{name}/restore-test` | signature | [databases](./databases.md#declaring-a-database) |
| `POST /v1/databases/{name}/verify-key` | signature | [databases](./databases.md#declaring-a-database) |
| `POST /v1/enroll` | public | [servers](./servers.md#enrolling-the-dashboard-with-a-one-time-code) |
| `POST /v1/images/export` | signature | [builds](./builds.md#building-on-one-server-running-on-another) |
| `POST /v1/jobs/{name}/run` | signature | [jobs](./jobs.md) |
| `POST /v1/notifications/test` | signature | [databases](./databases.md#declaring-a-database) |
| `POST /v1/postgres/databases` | signature | [databases](./databases.md#managed-postgresql) |
| `POST /v1/postgres/databases/{name}/password` | signature | [databases](./databases.md#managed-postgresql) |
| `POST /v1/projects/{name}/config/validate` | signature | [configuration](./configuration.md#one-file-per-project) |
| `POST /v1/projects/{name}/split` | signature | [configuration](./configuration.md#one-file-per-project) |
| `PUT /v1/apps/{app}/env` | signature | [environment](./environment.md) |
| `PUT /v1/apps/{app}/image/{tag}` | signature | [builds](./builds.md#building-on-one-server-running-on-another) |
| `PUT /v1/build-vars/{app}` | signature | [builds](./builds.md#building-on-one-server-running-on-another) |
| `PUT /v1/config` | signature | [configuration](./configuration.md#editing-the-configuration-while-the-agent-runs) |
| `PUT /v1/config/apps/{name}` | signature | [configuration](./configuration.md#editing-the-configuration-while-the-agent-runs) |
| `PUT /v1/config/databases/{name}` | signature | [configuration](./configuration.md#editing-the-configuration-while-the-agent-runs) |
| `PUT /v1/config/jobs/{name}` | signature | [configuration](./configuration.md#editing-the-configuration-while-the-agent-runs) |
| `PUT /v1/config/notifications` | signature | [configuration](./configuration.md#editing-the-configuration-while-the-agent-runs) |
| `PUT /v1/config/previews/{app}` | signature | [configuration](./configuration.md#editing-the-configuration-while-the-agent-runs) |
| `PUT /v1/previews/{app}/{pr}` | signature | [previews](./previews.md) |
| `PUT /v1/projects/{name}/config` | signature | [configuration](./configuration.md#one-file-per-project) |
