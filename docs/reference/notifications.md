# Notifications

Notifications cover operations only: a deployment that did not go through, an app that is down. Business events such as a new order belong in the application. The agent sends them, not the dashboard, because the dashboard may be off when something breaks.

```yaml
notifications:
  name: vps-1                    # how this server is called in messages (default: the hostname)
  events: [deployment.failed, deployment.rolled_back, deployment.rollback_failed, app.down, app.recovered]
  webhooks:
    - url: https://hooks.example.com/keelson
      secret_file: /etc/keelson/webhook-secret       # optional: signs the body
  telegram:
    bot_token_file: /etc/keelson/telegram-token
    chat_id: "-1001234567890"
    # api_url: https://api.telegram.org              # set it for a self-hosted Bot API server
  heartbeat:
    url: https://hc-ping.com/your-uuid               # an external dead-man switch
    every: 5m
```

| Event | When |
|---|---|
| `deployment.failed` | A deployment ended without touching the serving version (bad tag, failed pull, health check refused). |
| `deployment.rolled_back` | The new version failed and the previous one is serving again. |
| `deployment.rollback_failed` | The new version failed **and** the previous one could not be restored: the app may be down. |
| `app.down` | An app's container has been not running, restarting in a loop, unhealthy or gone for three checks in a row (15 s apart). |
| `app.recovered` | The app is back; the message says how long it was down. |
| `job.failed` | A scheduled job has failed `alert_after` times in a row (default 1). Sent once per streak; again at the next failed run (at least 15 minutes later) when the alert did not get through (Telegram unreachable at that moment), and again every `realert_after` (24h by default, `0s` never) while the streak goes on. The message says how many runs failed; an HTTP job's response body is never in it. |
| `job.recovered` | A job that had raised `job.failed` succeeded again. |
| `certificate.expiring` | The certificate the proxy serves for one of this server's names runs out in `cert_warn_days` days or fewer (14 by default, 90 at most). Said once at the threshold and again at 7, 3, 1 and 0 days, critical from 3 days. A name the proxy does not answer for raises nothing. |
| `certificate.renewed` | A name that had been announced is served with a certificate that runs well past the threshold again. |
| `proxy.drifted` | The proxy no longer served what the agent had applied (it restarted empty, or something edited it) and the agent applied its routes again. At most one message an hour while the drift lasts. |
| `deployment.succeeded` | A deployment succeeded. Off by default. |
| `job.missed` | Scheduled runs did not happen because the agent, or the server, was not running (found when the agent starts: the run list shows one run marked *missed*, with how many and since when). With `catch_up: true` on the job it then runs once, late. Off by default. |
| `engine.down` / `engine.recovered` | The Docker engine stopped answering for three probes 15 s apart / answers again. Off by default. |
| `disk.high` / `disk.recovered` | The filesystem that holds Docker's data or the agent's is more than `disk_alert_percent` full (85 by default), and back 5 points below. Off by default. |
| `memory.low` | Less than `memory_alert_percent` of memory is available (10 by default); it re-arms 5 points above. Off by default. |
| `agent.started` | The agent (re)started: a reboot or a crash loop shows. At most one a minute; the others are in the history as *suppressed*. Off by default. |
| `dashboard.unreachable` / `dashboard.recovered` | An agent that connects out to the dashboard has had no link to it for three minutes / is talking to it again. The apps keep running and their alerts keep coming; the dashboard shows the server as unreachable and nothing can be deployed from it. Off by default. |

Without `events`, everything is sent except `deployment.succeeded` and the events marked *off by default* above (`job.missed`, `engine.*`, `disk.*`, `memory.low`, `agent.started`, `dashboard.*`), which are sent only when `events` lists them.

## Certificates

Every six hours (and two minutes after the agent starts) the agent opens a TLS handshake on `127.0.0.1:443` for each name this server serves — the domains of the proxied apps and the hosts of the proxy's sites — and reads the date on the certificate it is given. That is the certificate a visitor gets, without DNS, Cloudflare or the network in the way; it is not verified, since the watch is about the date and a development server answers with Caddy's own local CA. A name the proxy does not answer for (TLS somewhere else, a server with no proxy) raises nothing: a proxy that is down is what `app.down` and `proxy.drifted` are for.

This catches what Caddy's own renewal cannot tell you about: a certificate file you installed yourself (a Cloudflare origin certificate), an ACME renewal that keeps failing, a name whose DNS moved away.

`alert_cooldown` (5 minutes by default, `0s` off) holds back a second `app.down` of an app that came back less than that long ago: a flapping app sends one pair of messages per cooldown (an app that is still down when the cooldown ends is announced then). `app.down` is also judged during a build and the release steps (a crash of the serving container during a nine-minute build alerts). It is held back only from the traffic switch to the end of the soak, while that container is being replaced.

 The webhook receives `{"type", "severity", "server", "app", "job", "time", "title", "message", "deployment_id", "ref"}` as JSON (empty fields left out), with `X-Keelson-Event` and, if a secret is set, `X-Keelson-Signature: sha256=<hex HMAC-SHA256 of the body>`. Telegram messages are HTML with every dynamic part escaped.

The dashboard edits this section for one server (*Server → Configuration → Notifications*) and across servers (*Settings → Notifications*), through `PUT /v1/config/notifications`; the secret files it names must already exist on each agent.

Run `keelson-agent notify-test --apps apps.yaml` after configuring it. It sends a test message on every channel and reports which ones work. A mistyped secret path fails at startup.

History: the agent keeps the last 200 notifications with how each delivery ended (`delivered`, `partial`, `failed`, `dropped`, `no_channel`, `suppressed`; a channel that failed is named without its error) in `<data-dir>/notifications.json`, and serves them newest first at `GET /v1/notifications/history?limit=` (read token). The alert state of each job's failure streak is kept there too, so a restart neither forgets an alert that never arrived nor repeats one that did.

**What never got through is sent again.** Thirty seconds after channels come into force — at every start of the agent, and when the notifications section gains a channel — the agent goes through its history for the events nobody ever saw (`failed`, `dropped`, `no_channel`), raised less than 24 hours ago and tried fewer than three times, and sends them again, oldest first, two seconds apart. The record is updated where it is, so the history keeps one line per event with how the last attempt went and how many were made; an event the configuration no longer selects is left alone. This is what makes a job that failed before the first webhook existed, or an alert raised while Telegram was down, arrive after all.

How it behaves:

- Delivery does not block the agent. Events go through a queue of 64 to a background worker; a channel that fails is retried three times (after 1 s, then 4 s), then given up with a log line. Other channels are not held back. If the queue is full the oldest event is dropped. Queued events are flushed at shutdown.
- An app that is being deployed is not watched, a container whose health check is still `starting` gets no verdict, and an alert needs three bad checks in a row, so a quick restart stays quiet. An app is announced once when it goes down and once when it is back.
- A webhook URL or the Telegram API URL carries a secret, and Go puts the URL in network errors. The agent strips these, and channels appear in logs by host only.
- The heartbeat is the only way to learn that a whole server is gone, since nothing local can report its own death. Point it at a service that alerts you when the pings stop.

Limits: an event raised while the agent is not running is never raised at all (the state it describes is seen again when the agent is back: an app that is still down is announced then), and an event still queued when the agent is killed is lost — what reached the history unsent is retried, what never reached it is not. There is no interactive bot (the dashboard does that job).
