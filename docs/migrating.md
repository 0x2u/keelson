# Moving a site that already runs into Keelson

Keelson does not adopt a running site automatically. It does not read a compose project, an nginx virtual host or a native database and guess the rest, because a wrong guess touches production. Do it the way you would by hand:

**Run the site as a new project on a staging address, check it, then switch the real address in one step. The old setup stays untouched until you remove it.**

The steps below use a site `www.example.com` that runs somewhere else today (a compose project, a host with nginx, a static host).

## 1. Create the project on a staging domain

*New project*, then pick the repository. For a static site a preset does the work:

| The site is | Preset | Settings |
|---|---|---|
| plain HTML, CSS and JavaScript in the repository | `static` | `output_dir: .` (or the folder that holds the files) |
| a Next.js static export (`output: "export"`) | `static` | `build_command: pnpm run build` (your package manager), `output_dir: out` |
| a Vite, React or Vue build | `vite` | `output_dir: dist`, `spa: true` if it routes in the browser |

Give it a staging hostname you control, for example `staging.example.com`, with its DNS record pointing where the real one does (or the same Cloudflare proxy), and deploy it. The live site is not affected. Presets are described in [Builds](./reference/builds.md#build-presets-no-dockerfile-in-the-repository).

## 2. Check it like the real thing

Open the staging address and compare it with the live one: the home page, a deep page, a page that does not exist (the 404), a font or an image, the response headers you rely on (cache, security headers), and any redirect you depend on (`www` and the bare domain). A preset serves `output_dir` with nginx. If the old site relied on Caddy options (`try_files`, immutable cache globs, custom headers), you may need to reproduce them. Look at what the old configuration set and compare headers with `curl -I`.

## 3. Switch the real address

How you switch depends on where the old site is.

**On the same server, served by Keelson's own Caddy as a `proxy.sites` entry.** The site entry holds the real host, and the agent refuses an app that claims a host a site already has. So do both changes in **one configuration save**. The agent validates and applies the whole file at once, sites and apps together, and keeps the last good version if it refuses:

1. remove the `hosts: [www.example.com]` site entry (and keep the `example.com` redirect entry);
2. change the new app's `domains` from `staging.example.com` to `www.example.com`.

No DNS change is needed, since the server is the same. If anything looks wrong, *Configuration → Versions → restore* puts the site entry back. The old files were never touched.

**On another server** (a VPS with nginx or compose, say). When staging looks right, change the DNS record of the real host to the new server (or the Cloudflare origin). Set a low TTL a day before. The old server keeps serving anyone who still resolves the old address. Remove it later.

**Keeping nginx in front, with the app already running in a container.** The agent can take over a container that is already running without an outage. Create the upstream file by hand pointing at the current port, change nginx to `proxy_pass http://keelson_<app>` and reload, then deploy through Keelson. The first deployment adopts the running container as the version to replace. See [Adopting a container that is already running](./reference/deployments.md#adopting-a-container-that-is-already-running) and [Behind nginx](./reference/proxy.md#behind-nginx-on-the-host-network).

## 4. Afterwards

- Keep the old copy (the files, the old virtual host, the old container) for a few days, then remove it. The dashboard never removes what it did not create.
- Turn off whatever used to deploy it (a CI `rsync` step, a cron job), so two things do not write the same site.
- Turn on the project's *Deploy each push* once the first manual deploy has gone well. A push then no longer waits for the tests, unless you deploy from the workflow that runs them.

## A site that is not static

A site with a database, an `.env`, volumes or a background process follows the same steps, plus these checks before the real switch:

- **Environment.** The agent runs as its own user (`keelson`) and reads the app's `env_file` to build the container's environment. The file must be readable by that user (group-readable is enough, and its owner and mode can stay as they are for whatever else reads it). Otherwise the first deployment fails at once with a permission error and changes nothing. Compare the environment the new container sees with the old one, variable by variable (names only, since values are write-only).
- **A backup before the first migration.** Declare the database with a `backups` section and add a `backup` [release step](./reference/deployments.md#release-phase-backup-and-migration-before-the-switch) before the migration. A failed backup then stops the deployment before anything changes. Keep a copy off the server.
- **A restore tried once.** Before you rely on a backup, run the database's *Restore test* (it restores into a scratch database and compares row counts) and prove the encryption key. The project's readiness checklist tracks both.
- **No second scheduler.** If CI cron workflows or the host's crontab ran the site's jobs, move them to [jobs](./reference/jobs.md) and disable the old ones. Otherwise every job runs twice.
- **A health gate and a soak.** Give the app a `health_path` that shows it works, and `verify` pages for what matters. The new version is then watched after the switch, and traffic goes back to the old one if it fails ([Deployments](./reference/deployments.md#the-soak-watching-the-new-version-after-the-switch)).
- **A way back.** Before the first Keelson deployment, undoing the proxy change is enough. After it, the previous image is still on the server (`keep_images`), so *Roll back* works. A rollback does not undo a schema change, so the pre-migration backup is what protects the data.
- **The first build is slow.** There is no layer cache for the new image name, so the first release rebuilds everything. Set the build's `memory` from a measurement ([Builds](./reference/builds.md)) and consider building on another server.
- **Something outside the server watches it.** Only something outside the machine can tell that the whole server is down. Configure the `heartbeat` in [Notifications](./reference/notifications.md) or keep an external uptime check.

## What this guide has not been checked on

The same-server swap (removing the `proxy.sites` entry and giving the host to an app in one save) follows from how the agent validates and applies its file, but has not been run on a real production server. Try it first on a host nobody uses (the staging one), then on the real one outside a busy hour.
