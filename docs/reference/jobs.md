# Scheduled jobs

The agent runs recurring work itself, so you need neither a GitHub cron workflow nor the host's crontab. A job is one of three kinds, and each entry sets exactly one:

```yaml
jobs:
  - name: monitoring
    schedule: "*/5 * * * *"            # 5-field cron, or @hourly @daily ... or "@every 15m" (30 s minimum)
    http:                              # call an endpoint of your app
      url: http://127.0.0.1:3000/api/cron/monitoring
      bearer: {app: shop, env: CRON_SECRET}   # read from the app's env at each run, or {file: /etc/keelson/cron}
      # method: GET, headers: {...}, body: "...", expect_status: [200, 202]   (default: any 2xx)
  - name: daily-report
    schedule: "0 7 * * *"
    timezone: Europe/Berlin             # default UTC
    http: {url: http://127.0.0.1:3000/api/cron/daily-report, bearer: {app: shop, env: CRON_SECRET}}
    alert_after: 2
  - name: backup
    schedule: "0 3 * * *"
    host: [/srv/shop/backup.sh]        # a program on the host: argv, no shell, KEELSON_* stripped from its environment
    dir: /srv/shop
    timeout: 20m                       # default 1m, maximum 1h
  - name: reindex
    schedule: "@every 6h"
    container: {app: shop, command: [node, reindex.js]}   # one-off container: the app's serving image and environment
    paused: true                       # kept in the file but not scheduled; "Run now" still works
```

How it behaves:

- Every run is recorded (status, trigger `schedule` or `manual`, duration, the last 4 KiB of output, 200 runs kept per job) and survives a restart. `GET /v1/jobs` lists the jobs with their next and last run; `GET /v1/jobs/{name}/runs` returns the history; `POST /v1/jobs/{name}/run` (signed like a deployment) runs one now. The dashboard shows all three.
- A job still running when its next tick comes is skipped and the skip is recorded. It does not alert.
- A host job (`host`) runs in its own process group. When its timeout ends the whole group gets `SIGKILL`, so a script's background children do not keep running.
- HTTP jobs do not follow redirects, so a redirect to a login page counts as a failure. Error messages and displayed targets never include the query string or a secret.
- A container job needs a serving version. Without one the run fails with that reason. It sees the app's environment and is removed afterwards, whatever happens.
- A run interrupted by an agent crash is marked failed at the next start.

Limits: a tick missed while the agent was down is not replayed (the next one runs on time) unless the job sets `catch_up: true`, which runs it once, late, and `job.missed` reports it. Schedules follow the time zone's clock (07:00 stays 07:00 across a daylight-saving change), but a time inside the hour that is skipped or repeated on the change night is not specially handled, so avoid it. The output is the last 4 KiB, not a log archive.
