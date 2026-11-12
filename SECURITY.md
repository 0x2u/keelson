# Security policy

## Supported versions

Keelson is pre-1.0. Only the latest 0.x release gets security fixes, so please update before reporting if you can.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability.

Use GitHub's private vulnerability reporting: open the repository's **Security** tab, choose **Report a vulnerability** and fill in the form. Only the maintainer sees it.

Include:

- the component (dashboard, agent, install script, relay, MCP server, GitHub Action) and its version (`keelson-agent version`, or the version shown in the dashboard);
- what you can do that you should not be able to, and the impact;
- steps to reproduce, or a proof of concept, with the configuration that matters;
- whether you have told anyone else.

## What to expect

Keelson has one maintainer, so these are targets, not guarantees: an acknowledgement within about a week, a first assessment within about two weeks, and a fix or mitigation plan as soon as there is one. A fix ships with a note in the [changelog](CHANGELOG.md), and reporters are credited unless they prefer not to be. Please give a reasonable time to fix before disclosing publicly.

## Scope

In scope:

- the **dashboard** (authentication, sessions, two-factor and passkeys, the API and its tokens, the stored secrets and the master key, the GitHub webhook);
- the **agent** (its API and mutual TLS, deployments, the proxy and database features, the secret store, the local CLI);
- the **install script** (`deploy/install.sh`) and the compose files;
- the **relay**, the connection by which an agent connects out to the dashboard;
- the MCP server and the GitHub Action, as far as they handle tokens.

Out of scope:

- findings that need an already compromised server, an operator's own account, or the dashboard's master key;
- the security of the apps you deploy, of Docker, Caddy, nginx, PostgreSQL or GitHub themselves (report those upstream);
- denial of service by an authenticated operator, missing hardening headers without a demonstrated impact, and results of automated scanners without a working scenario;
- exposure you set up yourself, such as publishing the dashboard without TLS against the documentation.

## Threat model in short

Agents hold the state and enforce it on their server, and the dashboard is a control plane that deploys do not depend on. The dashboard holds secrets (write-only, never shown again) and the credentials to reach your agents, so whoever controls it can change what runs on your servers. Protect it with TLS, a strong password and a second factor, an IP allowlist where you can, and a backup of the master key. The agent has access to the Docker engine, which is equivalent to root on its host. The full model, with what is and is not verified, is in [docs/reference/security.md](docs/reference/security.md).
