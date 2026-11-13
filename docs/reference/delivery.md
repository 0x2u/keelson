# Delivery performance

Four numbers say how a team delivers, and they are the ones a technical manager asks for: how often you deploy, how long a change takes to reach production, how often a change does not hold, and how long you take to restore service. They come from [DORA](https://dora.dev/), and Keelson computes them from what it already records — every deployment with its outcome, and every outage of an app its watcher saw — so there is nothing to instrument.

The dashboard shows them for the whole fleet under **Delivery**, with a line per server. Each agent serves its own at `GET /v1/delivery` and exports them on [`/metrics`](./metrics.md).

## What each number is

| Measure | What Keelson counts | Window |
|---|---|---|
| **Deployment frequency** | Deployments that finished successfully, over the length of the window. | 24 h, 7 d or 30 d |
| **Lead time for changes** | The median of (end of a successful deployment − the time of the commit it carried), over the deployments whose commit time the caller sent. | the same |
| **Change failure rate** | Finished deployments that did not leave the new version serving — failed, rolled back, or rolled back badly — over all finished ones. | the same |
| **Time to restore service** | The median length of the outages that touch the window, as the app watcher judged them (an app down, restarting in a loop, unhealthy or gone for three checks in a row). An outage still going is counted up to now. The clock starts when the watcher declares the app down, which takes three checks 15 s apart, so each outage is recorded about 30 to 45 s shorter than it really was. | the same |

A deployment that is still running counts for nothing: its outcome is not known yet. Thirty days is the longest window, because that is how long the agent keeps the record of outages.

The dashboard puts each number in a band (elite, high, medium, low), those of the [2023 State of DevOps report](https://dora.dev/research/2023/dora-report/): deployments on demand, daily to weekly, weekly to monthly; lead time under a day, a week, a month; 5 %, 10 % and 15 % of changes failing; recovery under an hour, a day, a week. The bands are a yardstick, not a verdict: DORA itself advises comparing one application with its own past, and a server that is deployed once a month on purpose is not failing.

## The lead time needs the time of the commit

The agent sees images, not repositories: a tag says nothing about when its code was written. So the caller sends it, and the agent records it with the deployment:

- **The dashboard**, when it builds from a repository on a push, or deploys the image a workflow built (`head_commit.timestamp` of the delivery).
- **The deploy action** ([GitHub Action](../github-action.md)), from `github.event.head_commit.timestamp`. Set `committed-at` yourself for another trigger, or to `""` to send nothing.
- **Your own caller**: `committed_at` (RFC 3339) in the body of `POST /v1/apps/{app}/deploy`, `POST /v1/apps/{app}/build` or `POST /v1/builds`.

A deployment without it is counted everywhere except in the lead time; the dashboard says what share of the successful deployments the figure covers, so a low coverage is visible instead of silently skewing it. A commit time after the deployment ended (a clock that is wrong) is ignored.

## The route

**`GET /v1/delivery?range=24h|7d|30d&app=<name>`** (read token). Without `app`, the answer is the server's, with the same numbers per app under `apps`.

```json
{
  "range": "30d",
  "from": "2026-10-13T09:00:00Z",
  "to": "2026-11-12T09:00:00Z",
  "days": 30,
  "deployments": {"total": 42, "succeeded": 39, "failed": 1, "rolled_back": 2, "rollback_failed": 0},
  "per_day": 1.3,
  "change_failure_ratio": 0.0714,
  "restore": {"incidents": 3, "median_seconds": 420, "longest_seconds": 1860, "ongoing": 0, "seconds": [180, 420, 1860]},
  "lead_time": {"deployments": 31, "covered": 0.794, "median_seconds": 5400, "p90_seconds": 23400, "seconds": [900, 1200]},
  "apps": [{"app": "shop", "...": "the same keys"}]
}
```

`seconds` carries the durations themselves (at most 500, sorted), so that a reader with several servers can compute the fleet's median over the values instead of averaging medians, which would be wrong. That is what the dashboard's Delivery page does.

## In Prometheus

The same numbers over 30 days, at every scrape (see [Metrics](./metrics.md)):

```
keelson_delivery_deployments{window="30d",status="succeeded"}
keelson_delivery_deploys_per_day{window="30d"}
keelson_delivery_change_failure_ratio{window="30d"}
keelson_delivery_incidents{window="30d"}
keelson_delivery_restore_seconds{window="30d",quantile="0.5"}
keelson_delivery_lead_time_seconds{window="30d",quantile="0.5"}
keelson_delivery_lead_time_deployments{window="30d"}
```

They are gauges over a moving window, not counters: the agent keeps no registry, and the window is the one its records cover.

## What it does not measure

- A deployment Keelson did not make. An image someone ran with `docker run` on the server is not a deployment.
- Only the outages a deployment caused. The 2023 report asks for the recovery time after a *failed deployment*; Keelson counts every outage its watcher saw (a crash, an out-of-memory kill, a bad deployment), because it cannot always tell which was which.
- The work before the commit. The lead time starts at the commit, as DORA defines it, not at the ticket.
- An outage nobody watched: an app with no container yet, or a server whose agent was down (the agent cannot record what it did not see). The dashboard says how many servers answered.
