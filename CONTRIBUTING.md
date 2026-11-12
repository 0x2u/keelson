# Contributing to Keelson

Thanks for wanting to help. Keelson has one maintainer, so replies and reviews can be slow. A ping after a week is fine.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems as described in [SECURITY.md](SECURITY.md), not in public issues.

## Propose first

For anything beyond a small fix, open an issue before writing code. Describe the problem and what you would change, so you do not spend time on something that does not fit. A small bug fix can go straight to a pull request. [Known limits](docs/limitations.md) lists what Keelson does not do today.

## What reviews look for

Changes are checked against these rules (see [Architecture](docs/architecture.md)):

- The agent holds its state and enforces it. It never needs an inbound call to keep running.
- A deploy, a rollback, a backup or an alert must still work with the dashboard down.
- Secrets are write-only. Once stored they are not shown again or put in logs, API answers or errors.
- Whatever the dashboard configures ends up in the agent's YAML, readable and editable by hand.

## Development setup and tests

Setup for each component is in [docs/development.md](docs/development.md). In short:

```bash
# agent (Go; the full suite wants a Docker engine)
cd agent && go test -race ./... && go vet ./... && gofmt -l .

# dashboard and MCP server (Node.js 24+, pnpm)
cd dashboard && pnpm install && pnpm test && pnpm run lint && pnpm run type-check
cd mcp && pnpm install && pnpm test && pnpm run lint && pnpm run type-check
```

If you change the agent's API shape, regenerate the golden files the dashboard is checked against and commit them:

```bash
scripts/capture-contract.sh
cd dashboard && pnpm run test:contract
```

CI fails when the captured files differ from the committed ones.

## Commits and pull requests

- Start commit messages with a conventional prefix: `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `ci:`, optionally with a scope (`feat(agent): ...`), then an imperative summary.
- One topic per pull request, branched from `main`. Keep unrelated refactors and formatting changes out.
- A pull request should have tests for the behavior it adds or fixes, updated documentation where users would look (`docs/`, the README, the configuration reference), a line in the changelog under `Unreleased` for user-visible changes, and a description of why, not only what.
- CI must pass. If a test is flaky or fails for a reason unrelated to your change, say so in the pull request.
