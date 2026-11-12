# UI guidelines

Rules for the dashboard's screens, for anyone changing them. The dashboard is what the operator opens during an incident, so it should be dense, quick and honest about state.

## Principles

1. State first. The top of a page says whether things are fine. Every resource has a live status (running, deploying, degraded, down, unknown). When data is stale or a stream is lost, the page says so instead of showing old values as current.
2. Show the cause. An error says what failed, why, and what to try. A deployment failure links to its log. No bare "Something went wrong".
3. Every action answers: a pending state on the control itself, a toast with the outcome, a link to what was created.
4. Production-affecting actions (deploy, roll back, restore, delete) show what will change first (diff, versions, affected domains). Irreversible ones ask you to type the resource's name.
5. Render the first paint on the server. Use skeletons shaped like the final content (no spinners, no layout shift), streams instead of polling, and optimistic updates only where the outcome is certain.
6. Everything is reachable from the command palette and shortcuts, and the main incident actions (see status, view logs, roll back) work on a phone.
7. Colour carries meaning (status, diff, danger), not decoration. Motion is under 150 ms and respects `prefers-reduced-motion`.

## Information architecture

The left sidebar is organised around projects. One entry is lit for any path. A page about something a project owns (an app, a deployment, a container, a job, a database, or the form that edits it) lights Projects, not Servers. The shell reads the owning project from the page's breadcrumb (`Projects > shop > Jobs > nightly`), which the page resolves with `lib/owner-core.ts` (the same rules as the project hub's membership). Unassigned jobs and databases and the server's own pages keep the Servers highlight and a server breadcrumb.

| Entry | Route | Contents |
|---|---|---|
| **Home** | `/` | What needs attention, the projects, the databases, the last 24 h, the servers. The fleet-wide lists `/jobs` and `/databases` (filters `?server=` `?project=`; shortcuts `g j`, `g d`, the palette) are sections of Home and light it. They have no sidebar entry. |
| **Projects** | `/projects`, `/projects/new`, `/projects/[project]/…` | Every project with its environments, serving version, health, last deployment, next jobs. Under the entry, a live project list with a status dot (the worst environment of each), which can be folded away, and New project. |
| **Servers** | `/servers`, `/servers/new`, `/servers/[id]/…` | The list (status, agent version, apps, containers, last deployment, disk; the ones that need a look first) and Add server: one main card, *Connect with one command* (a code and the `curl … \| sudo sh` line, and a live "waiting for the server" that turns into a link), and a collapsed *Advanced* section with the other ways. Under the entry, a live server list with status dots, which can be folded away. Infrastructure only. A server page ends with its **Readiness** card (alert channel tested, agent version); a project has a **Readiness** tab: checks grouped Data, Alerts, Deploys, Access, each *Passing*, *To do*, *Needs a look* or *Not applicable*, with one action (Test restore, Prove the key, Send a test alert, Download a copy, or a link to the fix). Readiness is not attention: it never turns a status dot red. |
| **Activity** | `/activity` | One feed, newest first, of deployments, job runs, database backups and restores, the agents' audit entries (`kind=change`: who did what, `token:<name>` for an API token) and the dashboard's own security-relevant ones (`kind=security`). Filters live in the URL: `?kind=`, `?server=`, `?project=`, app, failed only, 1 h / 24 h / 7 d; "load more" is bounded (200 rows). A server that does not answer is a row ("Can't tell: X did not answer"). Projects and servers link here with their filter prefilled. Alerts are not in this feed: the agent keeps a delivery history of the notifications it sent (`GET /v1/notifications/history`), but the feed does not list it, and attention items are computed from the current state. |
| **Settings** (footer) | `/settings` and a sub-nav: `/settings/security`, `/settings/api-tokens`, `/settings/integrations`, `/settings/notifications`, `/settings/backup` | One layout with a sub-nav. The index shows where each section stands in one line (2FA, tokens, GitHub, Cloudflare, notifications, backup). Notifications is a **fleet table** (one row per server, problems first, search and filters, a default you apply to selected servers, Test all); a row opens `/servers/[id]/config/notifications`. Do not put a full form per server on a page that lists servers. The account menu keeps the theme and sign out. |

A **server page** has a header (name, status, agent version, Settings, Configuration, Activity: the feed filtered to this server) and a tab bar whose tabs are routes, each rendering only its own data:

- Overview (`/servers/[id]`): the verdict and attention items of this server, apps, how many jobs and databases it has as links to their lists, recent deployments, resources, and Docker disk usage folded away.
- Containers (`/containers`).
- Proxy (`/proxy`), not shown for an agent that has no apps file.

A tab carries a count and a dot where the attention model has items for it (Containers: stopped or unhealthy, Proxy: not in sync). On a phone the tab bar scrolls sideways with the current tab in view. The older `/servers/[id]?tab=x` links redirect to the routes.

Other pages of a server (apps, configuration, containers, deployments, jobs, databases detail, update, uninstall) have no tab bar. Their breadcrumb starts at Projects when a project owns the entity and at Servers otherwise. Some routes redirect:

- `/servers/[id]/audit` goes to Activity.
- `/servers/[id]/apps/[app]/source` and `/environment` go to the project's Source and Variables tabs for an app of a project (a preview instance keeps its page).
- `/servers/[id]/jobs` and `/servers/[id]/databases` go to `/jobs?server=<id>` and `/databases?server=<id>`. The pages of one job or database (`/servers/[id]/jobs/[name]`, `/databases/[name]`) stay.
- `/servers/[id]/config/notifications` is the server's own notifications form, reached from the Settings > Notifications table.

**Jobs and databases** are listed by one table each (`JobsTable`, `DatabasesTable`), whichever page shows them, with a `scope`:

- `fleet` (`/jobs`, `/databases`, the home page): every server, with a Project and a Server column.
- `project` (the project's Jobs and Databases tabs): why each belongs to the project, with the ones no app claims collapsed below.
- `server` (`/jobs?server=<id>`): no Server column.

The global lists take `?server=` and `?project=` (chips that are links, so the filter is in the address). They are not in the sidebar. You reach them from Home, the server and project pages, the palette and `g j` / `g d`. Rows are sorted by what needs a look (a failing job, a job that never ran, a paused one; a failed or overdue backup, no backup, paused). Run now, Back up now, Restore and Edit are disabled with "Read-only server" on a server without a deploy secret. Add job / Add database opens the server's configuration form (a menu asks which server when there are several) with `?from=` set to the list, which is where the form returns to and where it reads the project from (`?project=`). A server that did not answer is named above the rows, or instead of them when it was the only one.

A **project page** has tabs: Overview, Apps, Jobs, Databases, Domains, Variables, Source, Configuration (`/projects/[project]/apps`). A top bar holds the global search (the command palette). The breadcrumb of a page starts at its section (Servers, Projects, Settings), never at Home.

## Foundations

| Area | Choice |
|---|---|
| Components | [shadcn/ui](https://ui.shadcn.com) on Radix primitives and Tailwind v4. The source is copied into the repo. Hand-written components are migrated to it, not kept alongside. |
| Tokens | CSS variables for colour (semantic: `card`, `border`, `muted`, `accent`, `success`, `warning`, `destructive`, `info`; each status colour has a `-text` shade that passes WCAG AA on its theme's background), radius, spacing and elevation. A light and a dark theme come from the same tokens, following the system preference with a manual switch. Small text (errors, help, status words) uses the `-text` shade, never the plain one. One focus ring everywhere (`ring-[3px] ring-ring/50`, `FOCUS_RING` in `components/layout.tsx`). |
| Type | Geist Sans and Geist Mono, tabular numbers in tables and metrics. The name and the page titles (`font-display`) are Sora SemiBold, served from the repository (`app/fonts`), so a build needs no network. |
| Brand | The mark and the name are `KeelsonMark` and `KeelsonWordmark` (`components/brand.tsx`): the frames of the mark take the text colour, the keel is `--brand`. `--brand` (keel cyan) is a fill; `--brand-text` is the shade that passes AA as text or as a ring on the theme's background. The dark theme's primary action, focus ring and active tab are the brand cyan; the light theme's primary is the ink, and the cyan is in the mark, the ring and the active icon of the sidebar. The brand colour never means a state. Neutrals lean towards the ink (no plain grey). The pages before a session (`AuthShell`) are the one place with a backdrop. Files and rules for use outside the dashboard: [brand](./brand/README.md). |
| Signature | Four pieces make the interface recognisable (`components/signature.tsx`): `EYEBROW`, the small uppercase label in the display face that titles every section, table column and summary card; `Orb`, the state of a whole drawn large (pulsing only when it is not fine); `Gauge`, a measure against its limit, neutral until it needs a look and then the colour of its tone; `Figure`, a big number with its label. The pipeline of a deployment is a connected rail (a node per step, a line that is solid as far as the deployment got), on the page of a deployment and in miniature on a project card. Home opens with a hero: the headline, three figures (apps up, deployments, backups) and the last 24 hours as 24 hourly bars (`fleetFigures` and `dayBuckets` in `lib/home-core.ts`, tested: the block can only say what the lists under it say). A card has a 16 px radius, a hairline instead of a shadow in the dark theme, and a one-pixel line on top of a project card that is the brand where all is well and the state's colour where it is not. |
| Icons | lucide, one stroke weight. `lib/icons.ts` maps each concept (project, server, app, job, database, history, configuration, settings, variables...) to one icon. The sidebar, the palette, empty states and buttons take it from there, so a concept keeps its icon everywhere. |
| Command palette | `cmdk` with our own ranking (`lib/palette-core.ts`): pages, projects and each project's tabs (`shop › Variables`), servers, apps, domains, jobs, databases, containers, and the actions that apply to them (deploy, roll back, run job, restart, start; New project, Add app, Add environment, Add job, Add database). What a project owns is listed with its project, and domains open the project's Domains tab. An action only navigates to the page with its dialog already open (`?deploy=`, `?rollback=1`, `?runnow=1`, `?restart=1`, `?start=1`), so the palette never changes anything itself. Recent choices are kept in the browser, and what concerns the current page comes first. Opens with `⌘K` / `Ctrl+K`. |
| Shortcuts | `g` then `h` `p` `s` `d` `j` `a` go to Home, Projects, Servers, Databases, Jobs, Activity; `?` lists them. They are inactive while typing in a field, with a modifier held or while a dialog is open. |
| Feedback | `sonner` toasts, inline errors next to the field, and a banner (`Notice`, on `Alert`) only for page-wide conditions. A `Notice` has three tones (danger, warning, info) that each colour the border, the icon and the text with their `-text` token. |
| Code and config | CodeMirror 6 for YAML and SQL, with a side-by-side diff for config changes. Monaco is avoided for its weight. |
| Charts | Small SVG sparklines and a light time-series chart for CPU and memory. No charting library until a screen needs one. |
| Data | Server components for the first paint. SSE for live status, logs and stats, with automatic reconnection and a visible "reconnecting" state. |

## Patterns

- **Lists** are dense tables with sticky headers, status dots, relative times (`3 min ago`) that show the absolute time on hover, copy buttons on digests and ids, truncation with a tooltip, and row actions in a menu.
- **Deployments** show a timeline of phases (pull, release steps, start, health, switch) with the live log beneath. The same component serves the history and the live view.
- **Forms** use one set of primitives (`components/forms/fields.tsx`): every field is a `FieldShell`/`TextField`/`SelectField`... with its label, help and error tied to the control by `aria-describedby` and `aria-invalid`. Mark the minority: in forms where nearly every field is needed (login, tokens, connections, a server) the exceptions say "(optional)", and in long configuration forms where most fields have a default the exceptions say "(required)". Fields validate as you type against the same rules as the agent, list every error at once on submit (`noValidate`, no browser bubbles), and never lose input on failure. Secrets are write-only: a "set" state with a replace action. Form and settings cards use `FormCard` (the default card padding).
- **Config changes** always go through a diff and a validation dry run before the Save button is enabled.
- **Empty states** (`EmptyState`) are titled "No <things> yet", say in one sentence what the thing is or how to get one, and offer at most one next action. Inside a card they stand as they are. Alone on a page or in a section they are `bordered`. A missing value inside a table cell or a definition is plain muted text, not a badge.
- **Responsive**: the sidebar collapses to a drawer under 1024 px. Tables become stacked cards under 640 px, keeping status and the primary action visible.
- **Layout primitives** (`components/layout.tsx`) replace local copies: `PageSection` (titled block with an action), `DefinitionItem`/`DefinitionList` (term and value), `SegmentedNav` (pills that navigate), `InlineLink` (the link style of running text and cells), `TableCard` (the one table card: edge-to-edge table, inset first and last cell, optional title row) and `FormCard`.
- **Loading and errors**: every page has a `loading.tsx` whose skeleton has the geometry of the real page (`TableCardSkeleton` is a `TableCard`). A skeleton root is `role="status"` with a label. The project and server tab groups have their own `error.tsx`, so a failing tab keeps the header and the tab bar. Pages about one named thing set `generateMetadata` (`lib/metadata.ts`), so browser tabs differ.

## Glossary and copy rules

Use one word per thing, in the UI, the docs, errors and the API.

| Term | Means |
|---|---|
| **Project** | Groups apps (and their jobs and databases) across servers. |
| **Environment** | A label on an app within a project: production, staging, pr-12. |
| **App** | A deployable unit. Never "service". |
| **Server** | A machine running a Keelson agent. |
| **Build server** | A server (or a connected computer) that builds images for an app that runs elsewhere; the UI says "Build on <server>". |
| **Variables** | The stored, write-only variables of an app. The YAML `env:` is "Static values in the file". |
| **Configuration** | The YAML-backed definition of an app, job or database ("Edit configuration"). |
| **Settings** | The Keelson-side connection or account of a server, or of the dashboard. |

Verbs:

- **Edit** for rows and pages, **Add** to create inside a container (Add app), **New** to create a top-level thing (New project).
- The three verbs of shipping mean the same everywhere (buttons, dialogs, toasts, palette, notifications, docs). **Deploy** puts a version into service: the latest commit of the linked branch, a chosen commit, or an image tag or digest. Where the app builds from source, the build is part of Deploy. **Roll back** is the verb ("rollback" only as a noun: the tab, the trigger). **Promote** deploys what serves in one environment to another.
- **Run now**, **Back up now**, **Restore**.
- **Remove** for things whose runtime survives (remove a server), **Delete** for data and files.

A server without a deploy secret is a **Read-only server**. The UI never says "needs the deploy secret". A deployment page draws the **pipeline** (Source, Build, Release, Switch, Soak, Live; each with its status and time, muted when not reached) above a log grouped by phase, and a failure says in one sentence what still serves.

Copy is in English, in sentence case, with no emojis and no trailing period on toasts and button labels. Status words come from one table in `lib/status.ts`. Times are always `RelativeTime`, with the absolute time on hover and focus.

## Checks before merging a screen

1. Look at it in a browser at 1440, 768 and 390 px wide, in light and dark themes.
2. Run an automated accessibility check (axe) on the page and go through its main flow with the keyboard only.
3. See the loading, empty, error and stream-lost states at least once.
4. Check there is no layout shift between skeleton and content (skeletons use the same `TableCard`, `FormCard` and `PageHeader` geometry as the page).

Formatters, state mapping and the signed actions have unit tests. Visuals are reviewed by eye and not pinned by tests.
