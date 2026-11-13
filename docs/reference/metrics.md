# Metrics

The agent answers `GET /metrics` in the Prometheus text format, so a team that already runs Prometheus, Grafana Alloy or any scraper of that format can alert on a failed deployment, a dead app, a job that stopped, a backup that is too old or a restore nobody tried, without a second tool.

The agent keeps no registry and adds no dependency: the numbers are read when the scrape comes, from the same sources as the JSON routes. The route is authenticated like every other read: the bearer token, and the client certificate when mutual TLS is on. Prometheus sends the token with `authorization.credentials_file`.

## Scraping

The agent listens on `127.0.0.1:7070` by default, and an agent that connects out to the dashboard keeps that loopback listener, so scrape it from the server it runs on. Over the network, use the mutual TLS listener and give the scraper the client certificate. A scrape reads the engine and the database and takes a few tens of milliseconds; every 30 seconds is plenty.

[`docs/examples/prometheus`](../examples/prometheus) has a `prometheus.yml`, alert rules (`keelson.rules.yml`) and their unit tests (`keelson.rules.test.yml`, run with `promtool test rules`). CI runs `promtool` on all three and lints a real agent's answer.

## What is exported

Labels: `app`, `project`, `environment` for an app; `job` and `project` for a job; `database` and `project` for a backup. A label with no value is left out. Times are Unix seconds, so `time() - metric` is an age.

| Metric | Meaning |
|---|---|
| `keelson_agent_info{version,read_only}` | Always 1. `read_only` is `true` on an agent with no apps file. |
| `keelson_engine_up` | 1 when the Docker engine answers. |
| `keelson_engine_containers{state}` | `running` and `total` containers on the engine. |
| `keelson_engine_images` | Images on the engine. |
| `keelson_host_cpus`, `keelson_host_uptime_seconds` | The machine. |
| `keelson_host_load{window}` | Load average over `1m`, `5m` and `15m`. |
| `keelson_host_memory_bytes{kind}` | `total` and `available`. |
| `keelson_host_disk_bytes{path,kind}` | `total` and `free` of the disk Docker keeps its data on (the root when that cannot be read). |
| `keelson_app_up` | 1 when the container runs and is neither restarting nor reported unhealthy. A configured app with no container is 0. |
| `keelson_app_container_restarts` | Restarts of the container since it was created: alert on `increase()`. |
| `keelson_app_oom_killed` | 1 when the engine killed the container for lack of memory. |
| `keelson_app_started_timestamp_seconds` | When the running container started. |
| `keelson_app_last_deployment_success` | 1 when the last finished deployment succeeded; 0 when it failed, was rolled back or could not roll back. Absent before the first one. |
| `keelson_app_last_deployment_timestamp_seconds{status}` | When that deployment started, labelled with how it ended (`succeeded`, `failed`, `rolled_back`, `rollback_failed`). |
| `keelson_app_deploying` | 1 while a deployment of the app is running. |
| `keelson_job_paused`, `keelson_job_running` | The job's state. |
| `keelson_job_next_run_timestamp_seconds` | When it runs next; absent while it is paused. In the past, it means the scheduler did not run it. |
| `keelson_job_last_run_timestamp_seconds` | When its latest run started. |
| `keelson_job_last_run_success` | 1 when the latest finished run succeeded, 0 when it failed or was missed. Absent while a run is going or when the latest was skipped, which says nothing about whether the job works. |
| `keelson_job_last_success_timestamp_seconds` | When the job last succeeded, among its 50 latest runs; absent when none did. |
| `keelson_backup_scheduled` | 1 for a database with a backup schedule that is not paused. Only databases with a `backups` section are listed. |
| `keelson_backup_last_run_success` | As for a job, for the database's backup job. |
| `keelson_backup_last_success_timestamp_seconds` | When a backup of the database last succeeded, among the 50 latest runs; absent when none did. |
| `keelson_proof_timestamp_seconds{kind,subject}` | When the agent last saw a thing proven: `restore` (a backup restored into a scratch database and compared), `key` (a private key opened a backup), `alert` (a test notification was delivered). |
| `keelson_delivery_deployments{window,status}` | Deployments that finished in the last 30 days by outcome; `keelson_delivery_deploys_per_day` is the frequency and `keelson_delivery_change_failure_ratio` the share that did not leave the new version serving. See [Delivery performance](./delivery.md). |
| `keelson_delivery_incidents{window}`, `keelson_delivery_restore_seconds{window,quantile}` | Outages of the window and how long they lasted (`quantile` 0.5 and 1). |
| `keelson_delivery_lead_time_seconds{window,quantile}`, `keelson_delivery_lead_time_deployments{window}` | Commit to production over the deployments whose commit time the caller sent, and how many that is. |
| `keelson_collector_success{collector}` | 1 when a part of the answer could be read: `engine`, `apps`, `jobs`, `backups`, `proofs`. 0 means its series are missing from this scrape. |
| `keelson_scrape_duration_seconds` | How long the answer took to collect. |

A part that cannot be read leaves its series out and says so in `keelson_collector_success` instead of failing the scrape: the rest is still worth having, and an alert on `absent()` or on the collector catches the gap. The host's numbers are exported even when the engine does not answer.

## What it does not do

- No history is kept by the agent: Prometheus keeps it. The agent still records 24 hours of host and container statistics for the dashboard's charts.
- No per-container CPU and memory: run cAdvisor for those, or read them in the dashboard. The agent exports the state of the apps it deploys, not the engine's metrics.
- No histograms (a deployment's duration or its number of failures): the last deployment's start and outcome are exported, and Prometheus can count what changed.
- The alert rules assume a daily backup schedule: change `36 * 3600` in `KeelsonBackupTooOld` to your own.
