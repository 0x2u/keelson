# Getting started

This page takes you from nothing to a running app in about fifteen minutes. You install the dashboard, connect a server, deploy an image, and roll it back.

## What you need

- A Linux machine for the dashboard, with Docker and the compose plugin 2.24 or newer. A small VPS is enough.
- A Linux server to run your apps, with systemd, Docker Engine, and an outbound HTTPS connection to the dashboard. Debian 12 and 13 are the tested systems.
- A domain name pointing at the dashboard machine, if the dashboard and the server are different machines. The server has to open the dashboard's address, and an address that only works through an SSH tunnel does not do.

You can use one machine for both to try Keelson. For anything real, run the dashboard on its own machine: it holds the credentials of every server.

## 1. Install the dashboard

On the dashboard machine, with a domain (its DNS record must already point at this machine, and ports 80 and 443 must be open):

```bash
curl -fsSL https://github.com/0x2u/keelson/releases/latest/download/install.sh | sudo sh -s -- --domain keelson.example.com
```

Without `--domain` the dashboard only listens on `127.0.0.1:3000`. That is enough to look around from the same machine (or through `ssh -L 3000:127.0.0.1:3000 <machine>`), but it cannot connect other servers.

The script installs Docker Compose files in `/opt/keelson`, starts the dashboard, and prints the address and a one-time setup token. If you lose the output, the token is in the container log:

```bash
cd /opt/keelson && docker compose logs dashboard | grep "setup token"
```

## 2. First sign-in

Open the address and enter the setup token. Then:

1. Choose the admin password (at least 12 characters).
2. Download the recovery file and keep it somewhere safe, away from this machine. It holds the master key that encrypts the credentials the dashboard stores. Without it, a lost data volume cannot be read again.
3. Add a second factor (an authenticator app or a passkey), or skip it for now. You can do it later in Settings, Security.

Changes that start something on a server (adding a server, creating a project) ask you to unlock with your password first. The padlock at the top right does it.

## 3. Connect a server

In the dashboard, open Servers, Add server, and press Make the command. It shows something like:

```bash
curl -fsSL https://keelson.example.com/install | sudo sh -s -- --code <one-time code> --name vps-1
```

Run it as root on the server. It downloads the agent, creates a `keelson` account, and installs a systemd service. The agent opens one outbound HTTPS connection to the dashboard, so the server needs no open port. After a few seconds the server shows as online.

The installer checks Docker before it uses the code. If it stops, it says what is missing: Docker not running, rootless Docker, or no `docker` group.

## 4. Create a project from an image

Open Projects, New project, From an image. For a first try:

1. Image: `traefik/whoami:v1.10.3`.
2. Project name: `whoami`.
3. Container port: `80`. Leave the port on the server at its default.
4. Skip the variables, and check the review page.
5. Press Create the project and deploy now.

The page shows the pipeline (source, build, release, switch, soak, live) as it runs, and when it ends it tells you where the app listens. Without a domain the app is on a local port of the server (for example `127.0.0.1:8100`). Open it on the server, or through an SSH tunnel:

```bash
ssh -L 8100:127.0.0.1:8100 <user>@<server>
```

To serve it under a name, you need a Caddy dedicated to Keelson on the server: see [Serve apps on a domain](./reference/proxy.md#serve-apps-on-a-domain).

## 5. Deploy another version and roll back

On the project page, press Deploy and enter another tag, for example `v1.10.2`. The new container has to pass its health check before it takes over. If it does not, or if the tag does not exist, the previous version keeps serving and the deployment shows the step where it stopped.

Roll back on the project redeploys the most recent successful version that is not the one serving.

## Next

- Add a second factor if you skipped it, and download a copy of the dashboard's own state in Settings, Backup.
- Set up alerts (Telegram or a webhook) on the server so you hear about a failed deployment or an app that is down. The secret of a channel (a bot token, a webhook secret) is a file you create on the server first.
- Connect GitHub (Settings, Integrations) to deploy on each push and preview pull requests. It needs the dashboard on an https address.
- Declare a PostgreSQL database to back it up on a schedule and test the restore.
- Read [Hosting](./hosting.md) for the dashboard's options, and [Limitations](./limitations.md) for what Keelson does not do yet.
