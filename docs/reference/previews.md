# Previews

A `previews` block in an app gives it temporary copies named `<app>-pr-<n>`, each on its own domain. CI builds the pull request's image tagged with its commit. The dashboard's webhook then asks the agent for the instance (see [Hosting](../hosting.md#github-webhook-automatic-deploys-and-previews)) and removes it when the pull request is closed. The agent never talks to GitHub.

```yaml
apps:
  - name: shop                         # the parent app: proxied with `port`, behind Caddy
    image: ghcr.io/acme/shop
    domains: [shop.example.com]
    port: 3000
    previews:
      domain: pr-{pr}-shop.example.com   # {pr} in the first label: one level, so a wildcard certificate covers it
      env_file: /etc/keelson/shop-preview.env   # optional, the instance's own
      env: { NODE_ENV: production }             # optional
      ttl: 72h                           # default 168h: it expires this long after its last deployment
      max: 5                             # default 5: one more instance removes a failed one, else the least recently deployed
```

See [`examples/previews.apps.yaml`](../examples/previews.apps.yaml).

- An instance is built from the parent: it takes the parent's image repository, port, health check, command, timeouts, logs, drain and restart policy. It gets its own domain, `environment: pr-<n>` and the same `project`. Nothing that could reach production is copied: no `env_file` or `env` of the parent (only the template's own, then the app's stored `preview` variables), no volumes, no release steps, no ports.
- Instances are not in the apps file, only their template is. They live in the agent's database, are not in `GET /v1/apps` (so the dashboard's Projects view does not change), and are deployed by the same blue/green pipeline as any proxied app (health gate, then the proxy switch).
- Previews need the Caddy driver (nginx keeps the hosts in your own server blocks). The file is refused, with one issue per template, when the parent is not proxied with `port`, uses `port.host`, when `domain` has no `{pr}` or has it outside the first label, when two templates share a pattern, or when a pattern can produce a domain of a configured app or an app is named like an instance.
- Removal is idempotent. It removes the containers (leftovers of an interrupted deployment included), the route, the database row and the images the instance pulled, except versions the parent or another instance keeps. The parent's image retention never removes an instance's version, and an instance never removes the parent's.
- A sweeper runs every minute and removes instances past their TTL, instances above `max` (failed ones first, then the least recently deployed) and instances whose template was removed from the file (the proxy route goes at the next reconcile, within 10 seconds; removing a template needs `force`, as it removes live environments). Creating an instance beyond `max` removes failed instances first, then the least recently deployed (last deploy time, not creation), and says so in the answer. An instance whose first deployment fails is removed at once (it never served anything; the deployment stays readable by id and `GET /v1/previews` does not list it); a failed redeploy keeps the old version serving. Nothing is removed while an instance is being deployed: it is refused with `409` and the sweeper waits.
- A preview's deployments do not raise `deployment.*` events. The pull request's status says how it went.

| Route | Auth | Description |
|---|---|---|
| `GET /v1/previews` | read token | `{"previews": [{name, app, pr, domain, url, ref, status, deployment_id, created_at, updated_at, expires_at}]}`, oldest first. `status` is `deploying`, `running` or `failed`; `ref` is the image reference of the latest deployment. |
| `PUT /v1/previews/{app}/{pr}` | signature | Body `{"tag":"<commit sha>"}` (CI built the image), or `{"sha":"<40 hex>","source":{"url":"...","token":"..."}}` (this agent builds it: [Building on the server](./builds.md#building-on-the-server-from-a-github-app)); exactly one of the two. Creates or redeploys the instance: `202 {deployment_id, name, url, evicted}`. `404` no template for the app, `400` bad number (1 to 999999), tag, sha or source, or the app has no `build:` block, `409` a deployment of that instance is running or another build is running, `503` shutting down. The deployment is recorded with the trigger `preview`. |
| `DELETE /v1/previews/{app}/{pr}` | signature | Removes the instance completely: `204`, also when it does not exist. `409` while one of its deployments runs. |
