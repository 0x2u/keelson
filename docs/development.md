# Development

Keelson is a monorepo. Each part has its own tests, and CI (`.github/workflows`) runs them on every push.

| Directory | What | Needs |
|---|---|---|
| `agent/` | The Go agent (`keelson-agent`) | Go 1.27 and, for the full test suite, a Docker engine |
| `dashboard/` | The Next.js dashboard | Node.js 24 or newer (it uses the built-in `node:sqlite`) and pnpm |
| `mcp/` | The MCP server | Node.js 24 or newer and pnpm |
| `action/` | The GitHub Action (a composite action over a shell script) | `curl`, `openssl`, `jq` |
| `deploy/` | `install.sh` and the compose files for the dashboard | Docker with the compose plugin 2.24 or newer |
| `contract/` | What a real agent answers to the requests the dashboard makes, captured as JSON | |
| `scripts/` | Build, version and deployment helpers | |
| `docs/` | This documentation, and `docs/examples/` | |

## Agent

```bash
cd agent
go build -o bin/keelson-agent ./cmd/keelson-agent
go test -race ./...
go vet ./... && gofmt -l .

# local CLI, no token needed (queries the Docker engine directly)
./bin/keelson-agent ps -a
./bin/keelson-agent logs -f -n 50 <container>
```

`scripts/build-agent.sh [VERSION] [OUT_DIR]` builds static binaries for Linux and macOS, amd64 and arm64, with `SHA256SUMS`, into `dist/agent`. `scripts/local-agent.sh` runs a read-only agent for the dashboard's `local` server entry. The commands and flags of the agent are in [The agent](./reference/agent.md).

Tests that need a real Docker engine (or a Caddy container) are skipped unless you ask for them: `KEELSON_DOCKER_TEST=1 KEELSON_CADDY_TEST=1 go test -run '^TestReal' ./internal/...`. The ones in `internal/build` build real images and need an engine that supports the classic builder (they do not pass on every Docker Desktop configuration), and, like the others, use images already on the host (`alpine:3.20`, `nginx:alpine`, `postgres:16-alpine`, `caddy:2-alpine`) and never pull. CI runs them in the *Agent on a real engine* job.

The tests that break things on purpose (`TestRealABrokenRelease…`, `TestRealAgentKilledDuringTheSwap…`) are in `internal/deploy/chaos_real_test.go`: the second one simulates a killed agent by cutting its goroutine off from the engine at the chosen point (a real SIGKILL of the process is not exercised), then starts a new `Deployer` on the same database and engine and calls `Recover`. `internal/store/testdata/agent-v0.1.0.db` was written by the v0.1.0 release and is never regenerated: `TestTheDatabaseOfTheFirstRelease…` opens it with the current code. When a schema migration is added, add the fixture of the release that ships it. `scripts/demo-rollback.sh` is the end-to-end version of a failed deployment, run by CI as *Failed deployment demo*.

The JSON Schemas in `docs/json-schema/` are generated: `cd agent && go run ./cmd/genschema` rewrites them from the structs of `internal/config` and the comments on them (add a key or change its comment, run it, commit the result); `-check` is what CI runs.

## Dashboard

```bash
cd dashboard
pnpm install
pnpm run agent-bin         # builds the agent binaries the dashboard installs over SSH into dashboard/agent-bin (needs Go)
KEELSON_INSECURE_COOKIES=true pnpm run dev   # http://localhost:3000; the first visit is the setup, its token is printed in this terminal
pnpm test && pnpm run lint && pnpm run type-check
```

To skip the setup, set `KEELSON_DASHBOARD_KEY` and `KEELSON_ADMIN_PASSWORD_HASH` (`pnpm run generate-key`, `pnpm run hash-password`). A `local` server entry is registered from an import file (`dashboard/servers.example.json`; `*.local.json` is git-ignored). `pnpm run test:contract` checks the dashboard's code against `contract/agent/*.json`; `scripts/capture-contract.sh` regenerates those files from a real agent, and CI fails when running it changes one, because the agent's API shape moved and the dashboard must be checked against it. The environment variables of the dashboard are in [Hosting](./hosting.md#run-it).

## MCP server

```bash
cd mcp && pnpm install && pnpm run build
KEELSON_URL=https://keelson.example.com KEELSON_TOKEN=kst_... node dist/index.js --check   # OK, or why the token does not work
pnpm test && pnpm run lint && pnpm run type-check
```

See [MCP](./mcp.md#6-development).

## Versions and releases

`scripts/version.sh` prints the version of the checkout. The agent, the dashboard and the release all use it: a tag `vX.Y.Z`, `vX.Y.Z-N-gHASH` between tags, `-dirty` for a local change. Releases are tags; the release workflow builds the agent binaries and the dashboard image and attaches `install.sh`.

The release workflow only publishes a tag that looks like `vX.Y.Z` (or `vX.Y.Z-rc.1`) and whose commit is on `main`. To rehearse without publishing, run it by hand (`gh workflow run release.yml -f dry_run=true`, or *Actions, release, Run workflow*): every job runs, the image is built and not pushed, and no release is created. On each pull request CI also builds the dashboard image (linux/amd64), runs `install.sh` twice against it to check that a re-run keeps the data, runs the real-engine tests and scans the dependencies (`govulncheck`, `pnpm audit --prod --audit-level high`).

## Conventions

- Work happens on feature branches and lands through pull requests; `main` is never committed to directly.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org).
- A change of the apps-file schema must not change what a server runs, except for documented deltas: see [Schema](./schema.md).
- User-visible words follow the [glossary and copy rules](./design.md#glossary-and-copy-rules): **Deploy**, **Roll back**, **Promote**; server, project, environment, app.
