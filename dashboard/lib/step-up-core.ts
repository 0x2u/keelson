import type { AppConfig, ConfigModel, DatabaseConfig, JobConfig, NotificationsConfig } from "@/lib/agent-types";

/**
 * Step-up: the dashboard holds root-equivalent access to every server, so what a stolen session could do is limited to what
 * is not dangerous until the operator proves, again and just now, the password and (when one is enrolled) the authenticator
 * code. This file is the policy, as pure functions: given what is stored and what is submitted, does the change need it?
 *
 * What needs it: anything that makes the server run something else or reach somewhere else (an app's image, command,
 * volumes, ports, network, release steps, build or inline variables; which host names and
 * ports route traffic to it; the repository it is built from; what a preview environment runs; a job's command, URL, headers,
 * body or bearer; where a database backs up to; where alerts go), and everything the raw editor, a restored version, stored
 * variables, servers, the address DNS records point at, and the places a build runs can do. What does not: schedules,
 * timeouts, drain and soak settings, labels (project, environment), thresholds, the events that alert. Deploying and rolling
 * back are day-to-day work and never need it.
 */
export type StepUp = { required: false } | { required: true; reason: string };

const NO: StepUp = { required: false };

function need(reason: string): StepUp {
  return { required: true, reason };
}

/** Stable text of a value: key order does not matter. */
function canon(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function changed(a: unknown, b: unknown): boolean {
  return canon(a) !== canon(b);
}

const APP_SENSITIVE: (keyof AppConfig)[] = [
  "image",
  "command",
  "volumes",
  "publish",
  "network",
  "env_file",
  "env",
  "release",
  "build",
  "database",
  "previews",
  "domains",
  "source",
  "port",
  "verify",
  "health_path",
];

/** An absent list or map and an empty one mean the same: a form that sends `domains: []` for an app without domains asks for nothing. */
function absentWhenEmpty(value: unknown): unknown {
  if (Array.isArray(value) && value.length === 0) return undefined;
  if (value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return undefined;
  return value;
}

/** An app saved (after is the submitted document; before the stored one, undefined for a new app). */
export function appChange(before: AppConfig | undefined, after: AppConfig): StepUp {
  if (before === undefined) return need(`Creating the app "${after.name}" decides what runs on the server.`);
  for (const key of APP_SENSITIVE) {
    if (changed(absentWhenEmpty(before[key]), absentWhenEmpty(after[key]))) return need(`The app's ${LABEL[key] ?? key} decides what runs on the server or where its traffic goes.`);
  }
  return NO;
}

/** A project created from a repository: its app is written and its variables set, in one go, and a retry runs the steps after that write again. */
export function projectCreation(name: string, withVariables: boolean): StepUp {
  return need(`Creating the project "${name}" writes an app${withVariables ? " and its variables" : ""}, which decide what runs on the server.`);
}

const LABEL: Partial<Record<keyof AppConfig, string>> = {
  image: "image",
  command: "command",
  volumes: "volumes",
  publish: "published ports",
  network: "network",
  env_file: "environment file",
  env: "inline variables",
  release: "release steps",
  build: "build",
  database: "managed database (where its backups go and who can decrypt them)",
  previews: "preview environments",
  domains: "domains",
  source: "source repository",
  port: "port",
  verify: "verification pages",
  health_path: "health path",
};

/** An app removed. */
export function appRemoval(name: string): StepUp {
  return need(`Removing the app "${name}" takes it off the server.`);
}

/** A project's own file removed: its apps leave the server. */
export function projectFileRemoval(project: string): StepUp {
  return need(`Removing the configuration file of the project "${project}" takes its apps off the server.`);
}

/** A project renamed: the label of every one of its apps, jobs and databases is rewritten, on every server that holds one. */
export function projectRename(from: string, to: string): StepUp {
  return need(`Renaming the project "${from}" to "${to}" rewrites the configuration of every server that holds it.`);
}

/** A job saved. */
export function jobChange(before: JobConfig | undefined, after: JobConfig): StepUp {
  if (before === undefined) return need(`Creating the job "${after.name}" makes the server run it.`);
  for (const key of ["http", "host", "dir", "container"] as const) {
    if (changed(before[key], after[key])) return need(`What the job does (${key === "http" ? "its request" : key}) is what the server runs.`);
  }
  return NO;
}

/** When and how long a backup runs and is kept: changing these does not change where the data goes. */
const BACKUP_TIMING = new Set(["schedule", "timezone", "keep", "keep_days", "keep_pre_deploy", "timeout", "alert_after", "paused"]);

/** A database entry saved: where it is, who it connects as, where its backups go and who can decrypt them. */
export function databaseChange(before: DatabaseConfig | undefined, after: DatabaseConfig): StepUp {
  if (before === undefined) return need(`Declaring the database "${after.name}" gives the agent a login to it.`);
  const strip = (d: DatabaseConfig) => ({
    ...d,
    backups: d.backups ? Object.fromEntries(Object.entries(d.backups).filter(([key]) => !BACKUP_TIMING.has(key))) : undefined,
  });
  if (changed(strip(before), strip(after))) return need("A database's connection, backup destination and recipients decide where its data goes.");
  return NO;
}

/** A database entry removed (its backup job goes with it). */
export function databaseRemoval(name: string): StepUp {
  return need(`Removing the database "${name}" ends its backups.`);
}

/** The notifications section saved: only where alerts go matters (the events, thresholds and cooldown do not). */
export function notificationsChange(before: NotificationsConfig | undefined, after: NotificationsConfig | null): StepUp {
  if (changed(before?.webhooks, after?.webhooks) || changed(before?.telegram, after?.telegram) || changed(before?.heartbeat, after?.heartbeat)) {
    return need("Where alerts are sent decides who hears about an outage.");
  }
  return NO;
}

/** A whole document written by hand, or an older version restored: anything can have changed. */
export function rawDocument(what: "editor" | "restore"): StepUp {
  return need(what === "editor" ? "The raw editor can change anything on the server." : "Restoring a version can change anything on the server.");
}

/** Stored variables: they are the secrets an app runs with. */
export function variables(): StepUp {
  return need("Variables are the secrets an app runs with.");
}

/** Servers: adding one hands the dashboard's credentials to it, removing one drops its access. */
export function servers(what: "add" | "update" | "delete" | "install" | "uninstall"): StepUp {
  const text: Record<typeof what, string> = {
    add: "A server added here receives deployments and secrets.",
    update: "A server's address and credentials decide who receives deployments and secrets.",
    delete: "Removing a server drops the dashboard's access to it.",
    install: "Installing the agent over SSH runs commands as root on the server.",
    uninstall: "Uninstalling the agent removes it from the server.",
  };
  return need(text[what]);
}

/** A new way to sign in (an authenticator, a passkey): a stolen session would add its own to stay. */
export function factorChange(what: string): StepUp {
  return need(`Adding ${what} adds a way to sign in that survives the end of this session.`);
}

/** The GitHub App: its key lets the dashboard read and build every repository it is installed on. */
export function githubApp(): StepUp {
  return need("The GitHub App's credentials decide which repositories the servers build.");
}

/** An app linked to a repository and branch (or pointed at another one): what its builds compile and deploy. */
export function repoLink(app: string, repo: string, branch: string): StepUp {
  return need(`Linking "${app}" to ${repo} (${branch}) decides which source its builds run.`);
}

/** Building an app on another server: that server is sent the repository's source and a GitHub installation token for it. */
export function buildServer(builder: string): StepUp {
  return need(`Building on the server "${builder}" sends it the repository's source and a GitHub token to read it.`);
}

/** The webhook secret: whoever holds it can make the dashboard believe a delivery came from GitHub. */
export function webhookSecret(): StepUp {
  return need("The webhook secret decides which GitHub deliveries the dashboard believes.");
}

/**
 * A DNS record written at Cloudflare. A record that is new, for a host name the server's agent declares, points that host at
 * the server: nothing existing changes, and declaring the host needed the unlock. Anything else needs it: replacing what is
 * there (traffic of a live host moves) or a host name the server does not declare (the dashboard's Cloudflare token would
 * write into any zone of the account).
 */
export function dnsRecord(host: string, ctx: { declared: boolean; replacing: boolean }): StepUp {
  if (ctx.replacing) return need(`Replacing the DNS record of ${host} moves its traffic.`);
  if (!ctx.declared) return need(`${host} is not a host name this server serves: a DNS record for it decides where its traffic goes.`);
  return NO;
}

/** The public address of a server: the address its DNS records point at. */
export function publicAddress(): StepUp {
  return need("A server's public address is where its DNS records point.");
}

/** Restoring a backup over the live database. */
export function liveRestore(): StepUp {
  return need("Restoring over the live database replaces its data.");
}

/** Downloading a copy of the dashboard's own database. */
export function dashboardCopy(): StepUp {
  return need("The copy holds every server's credentials (encrypted) and the sign-in data of this dashboard.");
}

/** Whichever of the sections of a model the submitted entity belongs to: used by the tests to look at a whole document. */
export function findApp(model: ConfigModel | null | undefined, name: string): AppConfig | undefined {
  return model?.apps?.find((a) => a.name === name);
}
export function findJob(model: ConfigModel | null | undefined, name: string): JobConfig | undefined {
  return model?.jobs?.find((j) => j.name === name);
}
export function findDatabase(model: ConfigModel | null | undefined, name: string): DatabaseConfig | undefined {
  return model?.databases?.find((d) => d.name === name);
}

/** What a session that has to be unlocked is told. */
export const STEP_UP_MESSAGE = "This is a sensitive change. Unlock changes first (the padlock in the top bar: your password and an authenticator code), then try again.";
