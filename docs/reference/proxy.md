# Reverse proxy

The agent drives a reverse proxy to switch traffic between versions of an app and to serve sites. There are two drivers. **Caddy** is the default for apps with `domains` (automatic TLS, a runtime admin API, no reload). **nginx** is for a host that already runs it, or for apps on the host network. One server uses one driver. The switch itself is part of a [blue/green deployment](./deployments.md#bluegreen-deployments), and `GET /v1/proxy` shows what the proxy serves.

## Serve apps on a domain

To put an app on `https://www.example.com`, a server needs a Caddy that Keelson drives, a `proxy:` block and a DNS record.

**1. A Caddy dedicated to Keelson.** The agent replaces its whole configuration on every change, so do not share it with anything else. It must own ports 80 and 443 and reach the host's loopback. Run it natively (the admin API on `127.0.0.1:2019`, Caddy's default) or as a container on the host network:

```bash
docker run -d --name caddy --restart unless-stopped --network host \
  -v caddy_data:/data -v caddy_config:/config \
  caddy:2-alpine
```

The volume keeps certificates across container replacement. Stop anything else listening on ports 80 and 443 first, and open them in the server's firewall.

**2. The `proxy:` block** in the server's configuration. The apps' own `domains` and `port` come with the app, and the dashboard's *New project* writes them for you.

```yaml
proxy:
  acme_email: ops@example.com    # optional: the contact the certificate authority uses

apps:
  - name: web
    image: ghcr.io/acme/web
    domains: [www.example.com]
    port: 3000
```

`admin` defaults to `http://127.0.0.1:2019`, so a Caddy on the same host needs no other key. The full list of keys is under [Caddy](#caddy).

**3. DNS.** Create an `A` record (or `AAAA`) for each name in `domains` that points at the server's public address. If Cloudflare is connected under *Settings → Integrations*, Keelson can create the record for you. Otherwise it tells you which record to add. Caddy gets the certificate itself once the name reaches the server (HTTP-01 on port 80, which also works behind the Cloudflare proxy).

**Check it works.** Open the server's **Proxy** tab. The app's route is listed, and *in sync* means Caddy serves exactly what the agent generates. On the app's page the **Domains** card checks each name in the order a visitor meets it (DNS, proxy, then HTTPS) and says what to do when one fails. A certificate can take a minute after the first DNS answer.

## Caddy

An app with `domains` is served through [Caddy](https://caddyserver.com), which obtains and renews TLS certificates itself and redirects HTTP to HTTPS.

```yaml
proxy:
  admin: http://127.0.0.1:2019   # Caddy's admin API (default)
  acme_email: ops@example.com    # optional contact for the certificate authority
  tls: internal                  # optional: Caddy's local CA instead of a public one (development)

apps:
  - name: web
    image: ghcr.io/acme/web
    domains: [example.com, www.example.com]
    port: 3000                   # container port the proxy forwards to
```

Run a Caddy that is **dedicated to Keelson**. The agent replaces its whole configuration on every change, through the admin API, atomically. It must reach the host's loopback and own ports 80 and 443, so run it natively or as a container with `--network host`. The admin API must stay on loopback.

The agent publishes each version of an app on a random port of `127.0.0.1`, so two versions never compete for a host port.

## Sites: static files, fixed upstreams and redirects

The agent owns Caddy's whole configuration, so anything else Caddy has to serve is declared in the same `proxy:` section. `sites` are the non-app sites. Each has `hosts` (validated like app `domains`, unique across apps and sites) and **exactly one** of `root`, `upstream` or `redirect`. See [`examples/proxy-sites.apps.yaml`](../examples/proxy-sites.apps.yaml).

```yaml
proxy:
  acme_email: ops@example.com
  sites:
    - hosts: [www.example.com]
      root: /var/www/example                  # static files, an absolute path as Caddy sees it
      not_found: 404.html                     # served with status 404
      headers: {X-Frame-Options: DENY}        # added to every response
      immutable: ["/_next/static/*", "*.png"] # Cache-Control: public, max-age=31536000, immutable
    - hosts: [example.com]
      redirect: {to: "https://www.example.com{uri}", code: 301}
    - hosts: [dashboard.example.com]
      upstream: 127.0.0.1:3100                # a fixed reverse proxy; headers also work here
```

- `root` serves a directory. `try_files` (default `{path}`, `{path}.html`, `{path}/`, so `/about` serves `about.html`) is tried in order and anything else is a 404. `index` (default `index.html`) is the file of a directory (`/blog` redirects to `/blog/`, as any static server does). `not_found` is a file under `root` that answers every 404 with its status kept and the site's `headers`. `immutable` takes path globs, and matching responses get the one-year immutable `Cache-Control`. Put hashed assets there, never HTML.
- `upstream` is a fixed `host:port`, for something the agent does not deploy (the dashboard itself, a service run by systemd).
- `redirect` answers every request with `code` (301 by default; 302, 303, 307 and 308 are allowed) to `to`. In `to`, `{uri}` (path and query), `{path}`, `{query}` and `{host}` stand for parts of the request.
- Sites are validated like the rest of the file: issues carry a path such as `proxy.sites[1]` and its line. They need the Caddy driver (nginx keeps its hosts in your own server blocks and refuses `sites`). A file with sites and no app at all is valid.
- Sites are part of the one configuration pushed by every deployment, so no deployment can drop them. `GET /v1/proxy` lists them as routes of kind `site` (with `site_kind`: `static`, `upstream` or `redirect`) and they count in `in_sync`.
- TLS is the same as for apps: certificates are obtained by ACME (HTTP-01 on port 80), which also works behind the Cloudflare proxy.
- For your own certificate (a Cloudflare origin certificate, say), `proxy.certificates` lists `cert_file`/`key_file` pairs (PEM, absolute paths *as Caddy sees them*; with Caddy in a container, mount the directory at the same path). Caddy serves them for the names they cover and asks no certificate authority for those names. The other names still use ACME. The agent does not read the files itself, so a wrong path shows up as Caddy refusing the configuration.

```yaml
proxy:
  certificates:
    - {cert_file: /etc/ssl/cloudflare/example.com.pem, key_file: /etc/ssl/cloudflare/example.com.key}
```

- `proxy.access_log: /data/access.log` (an absolute path *as Caddy sees it*) makes Caddy write one JSON line per request it serves, and rotate the file (100 MiB, ten files, ninety days). Each line has the client address Caddy worked out (`request.client_ip`; behind Cloudflare with `trusted_proxies`, that is the visitor), the method, host, URI and status. Nothing else goes to the file, and the entries are kept off Caddy's own output. With the container above, `/data` is the volume `caddy_data`, so a tool on the host (fail2ban, say) reads `/var/lib/docker/volumes/caddy_data/_data/access.log`. Filters for the JSON lines are in [`examples/fail2ban-caddy`](../examples/fail2ban-caddy/). Mount a directory instead if you want a path of your own. A line looks like `{"level":"info","ts":1793221671.76,"logger":"http.log.access.access","msg":"handled request","request":{"remote_ip":"…","client_ip":"203.0.113.7","proto":"HTTP/2.0","method":"GET","host":"example.com","uri":"/wp-login.php",…},"status":404,…}`. Without the option Caddy logs no requests.

**Trusted proxies and the client address.** Behind a CDN, Caddy sees the CDN's address, not the visitor's. `trusted_proxies` lists the ranges (CIDR or plain IPs) whose headers Caddy believes, and `client_ip_header` names the header they put the client in. Every reverse proxy route, apps included, then sends the upstream `X-Forwarded-For: <real client address>`, overwriting what the client wrote. A request from an address outside `trusted_proxies` is never believed, and the upstream sees its direct address. Without `trusted_proxies`, Caddy's own defaults apply and nothing changes. `client_ip_header` needs `trusted_proxies`.

```yaml
proxy:
  client_ip_header: CF-Connecting-IP
  trusted_proxies:      # https://www.cloudflare.com/ips/ (update when Cloudflare does)
    - 173.245.48.0/20
    - 103.21.244.0/22
    # ... the full list is in the example file
```

**Running Caddy for this.** Run a Caddy dedicated to Keelson as a container on the host network, so it reaches the apps' loopback ports and the admin API stays on `127.0.0.1:2019`. Keep its data directory on a volume so certificates survive container replacement (the certificate authority rate-limits re-issuing), and mount the static roots read-only at the paths used in `root`:

```bash
docker run -d --name caddy --restart unless-stopped --network host \
  -v caddy_data:/data -v caddy_config:/config \
  -v /var/www/example:/var/www/example:ro \
  caddy:2-alpine
```

The image starts with a default configuration that serves a placeholder on port 80. The agent replaces it at startup and again whenever it finds that Caddy serves something other than what it generated. **A restarted or recreated Caddy, even with no app at all, gets every route and site back within the reconcile period (10 seconds).** To move from nginx, stop it on ports 80 and 443 first (or move it aside) and migrate one site at a time: lower DNS TTLs, start Caddy, check each host with `curl --resolve host:443:127.0.0.1 https://host/`, then stop nginx.

## Behind nginx, on the host network

Caddy is optional. If nginx already owns ports 80 and 443, or the app runs with `network: host` to reach a database on `localhost`, the agent can switch traffic by rewriting one small file of upstream blocks and reloading nginx. A reload starts new workers on the new configuration and lets the old ones finish their requests.

```yaml
proxy:
  type: nginx
  upstreams_file: /etc/nginx/keelson/upstreams.conf   # the only file the agent writes
  test: [nginx, -t]                                   # optional: run before reloading
  reload: [systemctl, reload, nginx]

apps:
  - name: shop
    image: ghcr.io/acme/shop
    network: host
    port:
      host: [3000, 3001]         # the agent alternates between these two
      env: PORT                  # variable that tells the app which one to listen on (default PORT)
    health_path: /api/health     # must answer 2xx on the new port before traffic switches
    env_file: /srv/shop/.env
    restart: unless-stopped
```

In nginx, include the file in the `http` block and point `proxy_pass` at the upstream named after the app. Hosts, TLS and headers stay in your own server blocks:

```nginx
http {
  include /etc/nginx/keelson/*.conf;     # defines: upstream keelson_shop { server 127.0.0.1:3000; }
  server {
    server_name shop.example.com;
    location / { proxy_pass http://keelson_shop; }
  }
}
```

Each deployment starts the new container on the port the old one does not use and passes it as `PORT` (it replaces any `PORT` in the env file). It waits for the container to be healthy, requests `health_path` on that port, then rewrites the upstream and reloads nginx. The old container is stopped only after a **drain** (`drain`, 5 seconds by default, `0s` to disable). A reload only signals nginx, and for a few milliseconds a worker that has not yet taken the new file can still send a request to the old port. If nginx rejects the new file (`test` fails) or the reload fails, the previous file is put back, the old version keeps serving and the deployment ends as `failed`.

**An app with no serving container keeps its upstream, marked `down`.** nginx cannot load a configuration whose server block names an upstream that does not exist (`host not found in upstream`). So the agent never drops the `keelson_<app>` block of an app that declares `port.host`. While nothing serves the app (before its first deployment, or after its container stopped or went away) it writes `server 127.0.0.1:<first port> down;`. nginx then answers `502` for that app and the rest of the configuration stays loadable, for the agent's own test as for a reload, a restart or a boot of the server. The dashboard's proxy view compares the file with that content.

## Reading the proxy

`GET /v1/proxy` (read token) returns the reverse proxy: each route (`kind` `app`: app, domains, upstream, serving image, whether its container runs; `kind` `site`: domains, `site_kind` and `target`), apps with no route yet, the configuration the agent generates, and whether the proxy serves exactly that (`in_sync`; absent with `live_error` when it could not be read). It answers `404` when no proxy is configured. Nothing is applied.
