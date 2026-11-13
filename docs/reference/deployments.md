# Deployments

A deployment moves an app from one image to another: pull, release steps, start, health gate, traffic switch, soak. The new version only takes over if it is healthy. Otherwise the previous one keeps serving or is restored. Deployments are enabled by pointing `serve` at an apps file ([Configuration](./configuration.md)).

There are two strategies. Set one per app with `deploy.strategy`, or leave it out and it is inferred. `switch` is blue/green: the new container starts beside the old one and the proxy switches once it is healthy. It is used for an app with `domains` or a `port`. `replace` is in place: the old container is stopped and the new one started in its place. It is used for any other app.

## The apps file

The apps file is the desired state of a server, and unknown keys are rejected. The keys of an app are below; `build`, `previews`, `release`, `database` and `source` have their own pages.

```yaml
registries:                      # optional: credentials for private registries
  - host: ghcr.io
    username: my-bot
    password_file: /etc/keelson/ghcr-token   # read at every pull

apps:
  - name: web
    project: shop                # optional labels for the dashboard's Projects view (default: the app's name, and "production")
    environment: production
    enabled: true                # false stops the app and keeps it stopped: see "Stopping an app" (default true)
    image: ghcr.io/acme/web        # repository only: no tag, no digest
    env_file: /srv/web/.env      # KEY=VALUE lines; no interpolation
    env: { NODE_ENV: production }  # wins over env_file; variables set through the API win over both
    publish: ["127.0.0.1:3000:3000"]   # fixed port mappings, only for a `replace` app
    volumes: ["/srv/web/logs:/app/logs"]
    network: host                # a network name or "host"
    restart: unless-stopped
    stop_timeout: 10s            # how long before the old container is killed
    health_timeout: 90s          # how long the new container has to become healthy
    stable_after: 10s            # without a HEALTHCHECK: how long it must keep running
```

```bash
openssl rand -hex 32 > deploy-secret && chmod 600 deploy-secret   # must differ from the API token
./bin/keelson-agent serve --token-file token --deploy-secret-file deploy-secret \
  --apps apps.yaml --data-dir /var/lib/keelson
```

The file may be one for the whole server, or one per project: a `projects.d/` directory next to it holds a `<project>.yaml` per project, and `project:` also labels jobs and databases. See [One file per project](./configuration.md#one-file-per-project).

## In-place deployments

An app with no `domains` and no `port` is deployed in place (strategy `replace`). An app with `domains` or a `port` is deployed blue/green behind the [reverse proxy](./proxy.md) (strategy `switch`). An in-place deployment does, in order:

1. Read the environment (the `env_file`, `env`, and the [variables stored through the API](./environment.md)) and pull the image. Any failure here (unknown tag, bad credentials, missing env file) leaves the running container untouched.
2. Stop the running container and rename it `<app>.prev`.
3. Create and start the new container under the app's name, then wait until it is healthy: `healthy` when the image has a `HEALTHCHECK`, otherwise running for `stable_after`. A container that exits, restarts or turns unhealthy fails immediately.
4. Success removes `<app>.prev`. Failure removes the new container and renames `<app>.prev` back, restarts it and waits for it to be healthy. The deployment ends as `succeeded`, `failed`, `rolled_back` or `rollback_failed`.

The old container is stopped before the new one starts, so there is a short outage during the swap. Give the app `domains` to avoid it. One deployment per app runs at a time (`409` otherwise). A deployment keeps running if the HTTP client disconnects. If the agent dies mid-swap, the next start restores the previous container and marks the deployment `rolled_back`. The `deploy` subcommand takes an exclusive lock on the data directory, so it refuses to run beside a serving agent: deploy through the API instead.

## Blue/green deployments

An app with `domains` is served through the [reverse proxy](./proxy.md) and deployed without an outage. In order:

1. Read the environment file and pull the image (failure leaves everything untouched).
2. Start the new container under the name `<app>-<deployment id>` next to the old one. The agent publishes the app `port` on a random port of `127.0.0.1`, so two versions never compete for a host port.
3. Wait until the new container is healthy, while the old one keeps serving.
4. Tell Caddy to route the domains to the new container, then record it as the serving one. Caddy applies the change gracefully, so in-flight requests finish.
5. Stop and remove the old container.

Any failure before step 4 removes the new container and leaves the old version serving, untouched: the deployment ends as `failed`. Domains are lowercased and unique across apps; `publish` cannot be combined with a `switch` deployment (use strategy `replace` to publish fixed ports).

Docker can give a restarted container another random host port. The agent compares the routes with what the engine reports every 10 seconds and pushes a correction, so after a crash restart there can be up to 10 seconds of 502s. A container that is gone loses its route. At startup the agent also removes blue/green containers that a crashed deployment left behind (only names of the form `<app>-<16 hex>`) and resolves the interrupted deployment: `succeeded` if traffic had already switched, `failed` otherwise.

## Phases and failures

A deployment records the phases it went through, so the dashboard can draw the pipeline *Source → Build → Release → Switch → Canary → Soak → Live* instead of a flat log. `GET /v1/deployments` and `GET /v1/deployments/{id}` (and `last_deployment` in `GET /v1/apps`) carry `"phases": [{"name", "status": "running|done|failed|skipped", "started_at", "finished_at"}]` in order, only for the phases the deployment reached or deliberately skipped: `source` (downloading the source archive) and `build` only for a build; `release` (fetching the image, then the release steps: `check-env`, `backup`, `migrate`), `skipped` for a roll back unless the app sets `on_rollback`; `switch` (starting the new container, the health gate, the traffic switch and the drain; with a [canary](#canary-sharing-the-traffic-step-by-step) only the first two; for an app deployed in place: stop the old one, start the new one, health); `canary` (only for an app with a `canary:` block that had a version to share with: the steps, then the traffic switch and the drain that follow them); `soak` (`skipped` when the app has none, absent in place); `live` (stopping the previous version, pruning). The phase that was running when the deployment failed is `failed` and nothing after it is listed; the restore of the previous version belongs to it. Events carry a `"phase"` (replay and SSE). `"serving_ref"` is set when the deployment ends: the image that serves afterwards (the deployment's own on success, `previous_ref` after `failed` before the switch or `rolled_back`), and absent when nothing known serves. Rows from before this existed have none of these fields. Notifications use the trigger: `<app> deployed <version>`, `<app> rolled back to <version>`, `<app>: deploy failed` (with *<version> is still serving*), `<app>: deploy rolled back`, `<app>: rollback failed`.

When the new container was started and then failed (it exited, restarted in a loop, turned unhealthy, did not answer its `health_path`), its last output is read before it is removed and stored in the deployment's log as events of level `output`, one per line: at most the last 200 lines and 32 KiB (a line is cut at 4 KiB), introduced by an `info` event ("last output of ..."), or by a note that it printed nothing. The output is the app's own stdout and stderr, stored as it is: the agent filters no secret from it. Reading is bounded to 10 s and never fails the deployment. A restored previous version that fails as well has its output recorded the same way. The output of a failed release step is already in the log, line by line, prefixed by the step's name.

## The soak: watching the new version after the switch

The health gate checks the new container before traffic reaches it. The soak keeps watching it after the switch, to catch a build that answers `health_path` and then crashes or serves 500 on real pages. The old container stays running for the `soak` (30 seconds by default, `0s` turns it off, 10 minutes at most) while the new one is watched every few seconds: the container (running, not restarting, not Docker-`unhealthy`), `health_path` and each `verify` page, requested on `127.0.0.1:<port>` of the new container (a request that fails is asked once more at once before it counts). If it fails, traffic is switched back to the previous container through the same proxy-and-state path as the forward switch, the new container is removed (its last output kept in the deployment's events), and the deployment ends `rolled_back` with the reason (`deployment.rolled_back` is notified). If it holds, the previous container is stopped. An app that was not serving before has nothing to go back to: the failure is reported as `failed` and its container stays for you to look at.

```yaml
apps:
  - name: shop
    domains: [www.shop.example]
    health_path: /api/health
    drain: 10s
    soak: 60s
    verify:
      - {path: /}                       # any 2xx
      - {path: /products/1}
      - {path: /legacy, status: 301}    # a redirect is an answer, not followed: say which one
```

The soak sees what `127.0.0.1` sees: the app itself, not Cloudflare, the proxy or DNS, and not a bug that needs a logged-in visitor. `verify` takes at most 10 pages. `stable_after` applies to an image without a HEALTHCHECK, and to one that has it when the file sets it: the container must then stay healthy that long before the traffic switches. A crash of the agent during a soak leaves `app_state` on the new container: after the restart the new version serves and the previous container, now an orphan, is removed.

Set `health_path`. An image `HEALTHCHECK` that hardcodes a port (`fetch('http://127.0.0.1:3000/...')`) probes the other instance, so Docker calls a broken new container healthy. `health_path` asks the port the container really listens on. Better still, make the `HEALTHCHECK` read the same variable (`process.env.PORT`). Otherwise Docker marks the new container `unhealthy` once the old one is stopped. That is cosmetic, but it shows in `docker ps` and in the dashboard.

## Metric gates: judging the new version by your metrics

A page that answers 200 says the app is up, not that it is right. A version can serve every page and still double the error rate, or answer in three seconds instead of three hundred milliseconds. If you already run Prometheus, give the soak the numbers that decide: during the soak the agent asks it each metric's query, and a value out of bounds several evaluations in a row sends traffic back to the previous version, through the same path as a page that fails.

```yaml
apps:
  - name: shop
    domains: [www.shop.example]
    health_path: /api/health
    soak: 2m
    analysis:
      address: http://127.0.0.1:9090     # default; Prometheus, Mimir, VictoriaMetrics or Thanos
      metrics:
        - name: error-rate
          query: |
            sum(rate(http_requests_total{app="{{app}}",code=~"5.."}[1m]))
            / sum(rate(http_requests_total{app="{{app}}"}[1m]))
          max: 0.02                      # at most 2% of the requests
          interval: 15s                  # default 10s, at least 1s
          failure_limit: 3               # bad evaluations in a row that roll back (default 3)
        - name: p95-latency
          query: histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{app="{{app}}"}[1m])))
          max: 0.8
        - name: memory
          query: container_memory_working_set_bytes{name="{{container}}"}   # cAdvisor
          max: 400e6
          no_data: fail                  # no sample at all is a failure (default: pass)
```

- **When it is asked.** Each metric is asked every `interval`, the first time one interval after the soak starts, so that a `[1m]` rate has samples of the new version to work on. Each one is also asked at least once, however long its interval. The soak must be long enough for `failure_limit` evaluations to fit (`soak / interval`); the agent refuses a file where the gate could never trip.
- **What it judges.** The query must answer a number: a scalar or an instant vector. Every sample of a vector is judged, so `max` holds for the worst series. `max` is the highest value that is fine, `min` the lowest (a success rate); set one or both. A `NaN` (a rate of nothing over nothing) is no data.
- **What counts as bad.** A value outside the bounds. A query that fails (Prometheus down, a timeout of 10 s, a syntax error, an answer that is not a number) counts as bad too: a gate that cannot be asked cannot vouch for the version. No data passes by default, since an app nobody has called has no error rate; `no_data: fail` makes it bad. A good evaluation resets the run, so one noisy sample does not roll back a deployment.
- **Variables.** `{{app}}`, `{{container}}` (the new container's name) and `{{version}}` (the image reference being deployed) are replaced in the query, escaped for a PromQL string. Use them to tell the new version from the previous one, which still serves part of the soak: with the same label on both, a rate mixes them.
- **What you see.** The deployment's events say what each metric answered the first time and every time it changes, each bad evaluation with its count (`metric error-rate: 0.12, above the maximum 0.02 (2 of 3)`), and a summary when the soak holds. The error of a rolled back deployment names the metric, the value and the bound.
- **What it needs.** The Prometheus must be reachable from the agent, not from the dashboard: the queries are made by the agent, at the address you give (no credentials in it: put a local proxy that adds them in front). It is only for blue/green apps (an app with `port` or `domains`) with a soak above `0s` or a [canary](#canary-sharing-the-traffic-step-by-step), where every step is judged by it; a preview instance does not inherit it.

`keelson-agent config validate` checks the structure and every rule above. It does not ask Prometheus: try each query in its UI first, and check that it returns one number.

It is tested end to end against a real Prometheus and a real Docker engine (`TestRealMetricGateAgainstPrometheus`): a version whose pages all answer 200 but whose exported metric is bad is rolled back.

## Canary: sharing the traffic step by step

A switch gives the new version every visitor at once and relies on the soak to take them back if it turns out bad. A canary gives it a few visitors first. The new version receives a share of them, is watched, receives more, and takes everything only after the last step held. A step that fails sends every visitor back to the previous version, which never stopped.

A complete file, with two metric gates, is [`docs/examples/canary.apps.yaml`](../examples/canary.apps.yaml).

```yaml
proxy:
  acme_email: ops@example.com
apps:
  - name: shop
    image: ghcr.io/acme/shop
    domains: [www.shop.example]
    port: 3000
    health_path: /api/health
    soak: 30s
    canary:
      steps: [10, 50]                    # percent of the visitors: 10%, then 50%, then everyone
      hold: 2m                           # how long each step is watched (default 1m, 10s to 10m)
    verify:
      - {path: /}
```

- **What a step does.** The proxy is told to send `steps[i]` percent of the visitors to the new container and the rest to the previous one, then the new version is watched for `hold` exactly like a soak: its container, `health_path`, each `verify` page and, when the app has an [`analysis`](#metric-gates-judging-the-new-version-by-your-metrics), each metric. Every step is judged afresh, with its own run of evaluations. After the last step the proxy switches to the new version alone, the drain runs, and the usual soak follows, still with the previous version running.
- **A visitor stays on one version.** The share is of visitors, not of requests. Caddy gives a browser a version the first time it comes in a step and keeps it there with a cookie (`keelson_canary`), so a page and the assets it points to (hashed bundles of a front-end build) come from the same version. Someone who sends no cookie (a script, `curl`) is drawn at every request. Each step is a new draw: a cookie from an earlier step or an earlier rollout never matches, and the visitors are shared again by the new percentage. The weights are a cycle of 100, so out of every 100 new visitors exactly `steps[i]` get the new version.
- **What you see.** The pipeline gets a *Canary* step between *Switch* and *Soak*. The events say `canary 10%: 10% of the visitors go to the new version`, then what each watch found, and `the new version held at every step of the canary` before the switch. A step that fails ends the deployment as `rolled_back`, its error starts with `the canary failed: canary 50%:` and names the page or the metric. The new container's last output is kept as for any failed container.
- **What it needs.** A blue/green app on the Caddy proxy: nginx cannot keep a visitor on one version, and the apps file refuses `canary` with it. `steps` has 1 to 5 percentages from 1 to 99, rising (100 is the end of the rollout, it needs no step). The first deployment of an app has nothing to share with and goes live at once. A preview instance does not inherit it. Two copies of the app run for `steps × hold`, plus the soak: size `hold` for the memory of the server.
- **If the agent stops.** The share lives in the agent's memory, on purpose. An agent that restarts mid-rollout comes back with `app_state`, which names the version that served: its reconciler puts every visitor back on it, and the new container, now an orphan, is removed with the deployment reported as interrupted.

Because a canary judges numbers and not traffic, the metric is only as good as its labels at telling the new container from the previous one: use `{{container}}` or `{{version}}` in the query. It is tested end to end against a real Docker engine and a real Caddy (`TestRealCanaryOnARealEngineAndARealCaddy`): fifty visitors keep asking a site while a good version is shared 20% then 60% and then takes everything (none is refused), and a version that breaks at its first step is taken back by everyone.

## Stopping an app

`enabled: false` stops an app without deleting it. Use it for a test app left on a server, or one you want off for a while:

```yaml
apps:
  - name: demo
    image: ghcr.io/acme/demo
    domains: [demo.example.com]
    port: 3000
    enabled: false          # remove the key (or set true) to run it again
```

Starting from the file is the desired state: the agent stops what runs and keeps it stopped, and starts nothing by itself.

- **What stops.** Every running container of the app is stopped with the app's `stop_timeout`, at once when the file is applied and again at each reconcile (every 10 s), so a container started by hand with `docker start`, or by Docker's restart policy after a reboot, is stopped again within seconds. A deployment under way is not fought with: it ends, and the app is stopped at the next tick. Nothing is removed: the container, its image, `env`, `volumes`, the data in them, the deployment history and the configuration stay.
- **What visitors see.** The app's `domains` answer `503` with the text `This app is stopped.` (Caddy); with nginx the app's upstream stays in the file marked `down`, which is what nginx already does for an app nothing serves. A stopped app that was never deployed answers the same.
- **No outage, no alert.** A stopped app raises no `app.down` ([Notifications](./notifications.md)), is not an outage in `GET /v1/apps/{app}/availability` or in the time to restore of [Delivery performance](./delivery.md) (an outage that was open when it was stopped ends at that moment; the time stopped counts as up), and has no `keelson_app_up` series, so an alert on `keelson_app_up == 0` does not fire ([Metrics](./metrics.md)). `keelson_app_enabled` says 0 for it.
- **What is refused.** A deployment, a rollback, a build of the app and the start or restart of its container answer `409` with `app <name> is stopped (enabled: false): start it first`. It makes no [preview](./previews.md), and a preview instance never inherits `enabled`. `enabled: false` on a build-only app (`build.only`) is a configuration error: it has no container.
- **Starting it again.** Remove the key (or set `enabled: true`) in the file, or through the [configuration API](./configuration.md#editing-the-configuration-while-the-agent-runs), then start the container: `POST /v1/containers/{name}/start` (the dashboard does both). Changing the file does not start anything; the proxy picks the app up again after the start like any started container, and the next deployment deploys as usual. `GET /v1/apps` lists `enabled` for every app so that a client can tell a stopped app from a crashed one.

It is tested end to end against a real Docker engine and a real Caddy (`TestRealStoppedAppOnARealEngineAndARealCaddy`): the file stops the app, the container stops and is kept, the host answers `503` with no drift in Caddy, a deployment is refused, a container started by hand is stopped again, and after the key is removed and the container started the host serves again.

## What a request chooses

A request only chooses the tag or digest. The repository comes from the apps file, so an API caller cannot make the agent run an arbitrary image.

An app that has a `build:` block never pulls a tag it did not build: a tag that is not on this server is refused (`keelson-local/<app>` names exist on Docker Hub for anyone to register, and a deployment of one would run a stranger's image). A first deployment that would adopt a running container whose port it cannot read (`port.host` without `PORT` in that container's environment) is refused before anything runs, with the reason, instead of colliding with it on the first port. Each phase of a deployment has its own time budget (the pull, the release steps by their own timeouts, the health gate, the soak), so a `backup` step of 20 minutes is not cut at 15.

A tag the server built itself (an app with a `build:` block) is deployed from the server and not pulled, since no registry has it. That is how "deploy the previous build" and `POST .../deploy {"tag":"<40-hex commit sha>"}` work for such an app, as `rollback` already did. A tag that was never built here is pulled.

## Adopting a container that is already running

If no deployment has ever run for the app but a running container named after it exists (typically left by `docker compose`), the first deployment treats it as the version to replace. It keeps serving until the switch, and is stopped and removed afterwards. To migrate without an outage: create the upstream file by hand pointing at the current port, change nginx to `proxy_pass http://keelson_<app>` and reload, then deploy through Keelson. The agent reads the current port from the container's `PORT` variable and picks the other one. A stopped container of that name is left alone.

## Release phase: backup and migration before the switch

Between the pull and the switch, the agent can run steps that must succeed for the new version to take over: typically a database backup and the schema migration. They run before anything serving is touched, so a failing step fails the deployment (`failed`) and leaves the running version as it was.

```yaml
apps:
  - name: shop
    image: ghcr.io/acme/shop
    network: host
    env_file: /srv/shop/.env
    release:
      steps:
        # On the host, as the agent's user: a script that already lives on the server.
        - name: backup
          host: [/srv/shop/scripts/backup-db.sh]
          continue_on_failure: true      # warn and go on, instead of aborting
        # In a throwaway container: the app's environment, volumes and network.
        - name: migrate
          container:
            image: ghcr.io/acme/shop-migrate # optional: a tool that is not in the runtime image
            command: [pnpm, exec, prisma, migrate, deploy]
          timeout: 10m
```

The agent's own encrypted, verified backup (see [Databases](./databases.md#declaring-a-database)) can be the first step, with nothing to script:

```yaml
databases:
  - {name: shop, host: 127.0.0.1, database: shop, user: shop, password_file: /etc/keelson/db-shop,
     backups: {schedule: "0 3 * * *", recipients: ["age1..."], destinations: [{local: {dir: /var/backups/keelson}}]}}
apps:
  - name: shop
    release:
      steps:
        - {name: backup, backup: shop, timeout: 20m}     # fails the deployment if the backup cannot be taken and checked
        - {name: migrate, container: {command: [pnpm, exec, prisma, migrate, deploy]}}
```

- Host steps (`host`) are an argument list, with no shell. They get `KEELSON_APP`, `KEELSON_REF`, `KEELSON_DEPLOYMENT_ID` and `KEELSON_TRIGGER`; every other `KEELSON_*` variable of the agent (its token, its secrets) is removed from their environment. A host step runs in its own process group: when its timeout ends or the deployment is cancelled, the whole group is killed (`SIGKILL`), so a program the script forked or left in the background does not outlive it.
- Container steps (`container`) run `container.command`, which replaces the image's `CMD` in a container created from the image being deployed, with the app's environment (`env_file`, `env`, and its stored variables), `volumes` and `network` (so `localhost:5432` works for an app on the host network). With `container.image` the step runs another repository at the same tag as the app, which suits a migrator built next to the app; it therefore cannot follow a deployment by digest. The container is always removed, also after a failure or a timeout.
- Steps run in order and stop at the first failure unless it has `continue_on_failure`. Each has a timeout (default 10 minutes, at most 1 hour). Their output goes into the deployment's log, up to 500 lines per step.
- A `backup` step (`backup: <database>`) takes the same backup as the database's schedule: `pg_dump`, a read-back of the dump, age encryption, the stored copy hashed again. The database must be declared under `databases:` with a `backups` section (the file is refused otherwise). Its output goes into the deployment's log. A backup already running for that database (the nightly one) makes the step fail with that reason: retry the deployment. It is skipped by a rollback like any step.
- A rollback skips the steps unless `release.on_rollback` is `true`, because re-running migrations from an older image is not what a rollback is for.
- Release containers are labelled `keelson.release=true`, with the step's timeout in `keelson.release.timeout`. When the agent starts it removes the ones a crashed agent left behind that have exited. One that is still running (a migration the agent's death did not stop) is left to finish, so that a migration is not cut in half (Prisma then refuses to continue: P3009): a background task waits for it for the rest of the step's timeout, counted from when the container started (the longest allowed timeout, 1 hour, when it carries no record of it), then removes it, forcibly if it is still running. The task ends with the agent, and the next start sweeps again. The deployment that started it is marked interrupted; the migration it was running is not rolled back or verified: check it before redeploying.

A migration that fails halfway may have changed the schema, and a rollback restores the previous image, not the previous schema. The backup step is your protection, and restoring it is up to you.

## Disk housekeeping

The agent tidies the disk by default:

- Logs: Docker keeps a container's output forever unless told to rotate it. Every container the agent creates rotates its logs (`json-file`, 10 MiB per file, 3 files). Change it per app with `log: { driver: local, max_size: 50m, max_file: 5 }` (`driver` is `json-file` or `local`; `max_size` is a number and `k`, `m` or `g`). It applies to the next deployment, not to a container that is already running.
- Untagged images left by builds: a multi-stage build leaves each stage but the last as an untagged image. After a successful build the agent removes the untagged images that were already on the engine when it started (what the builds before left), and keeps the ones this build made: the next build reuses their cached layers (a dependency install is minutes), and removes them in turn. About one build's worth of leftovers stays, instead of one more at every build. A failed build removes nothing. The engine refuses to remove an image a container uses, and the agent never forces it. This is `docker image prune` for the images that exist at the start of a build, so it also removes untagged images you made yourself on that server; the build cache (`docker builder prune`) is still yours to clear.
- `agent.db` is copied: the agent keeps seven dated copies of its database in `<data-dir>/snapshots/` (one a day at most, so a restart loop does not push the good copies out), and, when an upgrade is about to change the schema of an existing database, the database as it was next to it as `agent.db.before-upgrade-from-vN` (the previous agent refuses a newer schema: this copy is what going back uses). It holds the deployment history, what serves, the previews and the ledgers. The copies are on the same disk: they are for a corrupted or replaced file, not for the loss of the machine.
- If `agent.db` is lost or old while the site runs (deleted, recreated after corruption, restored from an older copy), the agent does not take the container that serves for an orphan. At start, when `app_state` has no row for an app that was never deployed from this database, or names a container that is not there, the newest running `<app>-<16 hex>` container is adopted as the one that serves and the proxy is routed to it; other running ones are left alone (the next deployment, which has a state again, removes them); stopped ones are removed. The history is gone, the site is not. A crashed first deployment is still cleaned up: it leaves a deployment row, and its container never served.
- Old images: after a successful deployment the agent removes the app's images older than the last `keep_images` deployed versions (3 by default, the running one included). A version counts as deployed once its deployment succeeded; any other local image of the same repository, including one you built or pulled by hand, is not and is removed too. The images of [release steps](#release-phase-backup-and-migration-before-the-switch) that have their own `container.image` (a migration image, pulled at each deployment's tag) are pruned the same way, at the tags of the versions that stay. The engine refuses to remove an image a container still uses, and the agent never forces it. A failure to prune never fails the deployment: it is shown as a warning in the deployment log. Rollback still works for versions you keep; an older one is pulled again.

## Routes

| Route | Auth | Description |
|---|---|---|
| `POST /v1/apps/{app}/deploy` | signature | `409` when the app is [stopped](#stopping-an-app) (`enabled: false`), like `rollback` and `build`. Body `{"tag":"..."}` or `{"digest":"sha256:..."}`, and optionally `"trigger": "promotion"` (default `"api"`; anything else is refused) for a version moved from another environment: it is recorded in the deployment's history. Answers `202 {"deployment_id"}`. |
| `POST /v1/apps/{app}/rollback` | signature | Redeploys the most recent successful image that is not the running one. |
| `POST /v1/apps/{app}/build` | signature | Builds the app's image on this server and deploys it: body `{"sha":"<40 hex>","source":{"url":"https://api.github.com/repos/o/r/tarball/<sha>","token":"<bearer token>"},"deploy":true}` (`deploy` may only be `true`). `202 {"deployment_id"}`; `404` unknown app, `400` the app has no `build:` block, a bad body, sha or token, or a `url` that is not https on one of the app's `source_hosts`, `409` this app is deploying or another build is running, `503` shutting down. See [Builds](./builds.md#building-on-the-server-from-a-github-app). |
| `POST /v1/containers/{name}/start` | signature | Starts a stopped container of an app (one with the `keelson.app` label; any other is refused). `204` once it runs; `404` unknown container, `409` it is not managed by keelson, a deployment of its app is running, or the app is [stopped](#stopping-an-app) by the file (`enabled: false`: it would be stopped again at the next reconcile), `400` a bad name. For a blue/green app the proxy is reconciled at once: a start can give the container another host port. |
| `POST /v1/containers/{name}/restart` | signature | Stops the container with its app's `stop_timeout` (10 s when the app is no longer in the file), then starts it again. Same answers and rules as `start`. Audited as `container.start` and `container.restart`. |
| `GET /v1/apps` | read token | Configured apps with their container and last deployment, and `enabled`: a boolean that is always there, `false` only when the file stops the app ([Stopping an app](#stopping-an-app)), their `project` and `environment` labels as written, and the `digest` (`sha256:...`) of the image that serves, empty when nothing runs or the image has no registry digest. `env_changed_at` is when the app's [stored variables](./environment.md) last changed (RFC 3339, empty when there are none), to compare with the serving deployment. `domains` lists the public hostnames the proxy routes to the app (omitted when there are none); the dashboard shows the first domain as the address of the site. |
| `GET /v1/deployments?app=&limit=` | read token | Recent deployments, newest first. |
| `GET /v1/deployments/{id}` | read token | One deployment. |
| `GET /v1/deployments/{id}/events` | read token | Server-Sent Events: the deployment's log (replayed if finished), then `end` with the final status. Events have the level `info`, `warn` or `error`, and `output` for a line printed by a failed container (see below). |

Local equivalents: `keelson-agent deploy --apps apps.yaml APP TAG` and `keelson-agent history [APP]`.
