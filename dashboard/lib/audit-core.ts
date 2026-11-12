import type { AuditEntry as AgentAuditEntry, ConfigVersion } from "@/lib/agent-types";
import type { AuditEntry as DashboardAuditEntry } from "@/lib/auth/store";
import { humanise } from "@/lib/labels-core";
import { notificationsHref } from "@/lib/redirects-core";
import type { Tone } from "@/lib/status";

// One humaniser for every audit line the dashboard shows: the agent's (per server) and the dashboard's own (sign-ins, tokens,
// integrations). Both turn a code into a sentence and a target, and say what kind of thing it was, so the Audit page, the
// Security page and the Activity feed read the same.

/** What an entry is about, for the Activity feed's filter. */
export type ActivityKind = "deployment" | "job" | "backup" | "change" | "security";

export const KIND_LABELS: Record<ActivityKind, string> = {
  deployment: "Deployments",
  job: "Jobs",
  backup: "Backups",
  change: "Config changes",
  security: "Security",
};

export interface Humanised {
  /** A short name for a badge: "Deployment". */
  label: string;
  tone: Tone;
  kind: ActivityKind;
  /** One line a person can read, without the actor: "Deployed web". */
  sentence: string;
  /** False for a code nobody named here: the label is the code, made readable. */
  known: boolean;
}

// ---- The agent's audit log --------------------------------------------------------------------------------------------

interface AgentAction {
  label: string;
  tone: Tone;
  kind: ActivityKind;
  /** The sentence for a request the agent acted on; `name` is the target ("" when there is none). */
  done: (name: string) => string;
  /** The sentence for one it refused or could not apply. */
  failed: (name: string) => string;
}

const named = (text: string, name: string) => (name === "" ? text : `${text} ${name}`);
function action(label: string, tone: Tone, kind: ActivityKind, done: string, failed: string): AgentAction {
  return { label, tone, kind, done: (n) => named(done, n), failed: (n) => named(failed, n) };
}

/** Every action code the agent writes (agent/internal/api/audit.go, deploy/previews.go and api/enroll.go): a test keeps this complete. */
export const AGENT_ACTIONS: Record<string, AgentAction> = {
  deploy: action("Deployment", "info", "deployment", "Deployed", "Could not deploy"),
  rollback: action("Rollback", "info", "deployment", "Rolled back", "Could not roll back"),
  build: action("Build", "info", "deployment", "Built and deployed", "Could not build"),
  "image.export": action("Image sent", "info", "deployment", "Gave an image to another server", "Could not give an image to another server"),
  "image.import": action("Image received", "info", "deployment", "Received an image from another server", "Could not receive an image from another server"),
  "job.run": action("Job run", "muted", "job", "Ran job", "Could not run job"),
  "config.update": action("Configuration edited", "warning", "change", "Edited the configuration file", "Could not edit the configuration file"),
  "config.restore": {
    label: "Configuration restored",
    tone: "warning",
    kind: "change",
    done: (n) => (n === "" ? "Restored a configuration version" : `Restored configuration ${n}`),
    failed: (n) => (n === "" ? "Could not restore a configuration version" : `Could not restore configuration ${n}`),
  },
  "app.save": action("App saved", "warning", "change", "Saved app", "Could not save app"),
  "app.delete": action("App deleted", "warning", "change", "Deleted app", "Could not delete app"),
  "job.save": action("Job saved", "warning", "change", "Saved job", "Could not save job"),
  "job.delete": action("Job deleted", "warning", "change", "Deleted job", "Could not delete job"),
  "notifications.save": { label: "Notifications saved", tone: "warning", kind: "change", done: () => "Saved the notification settings", failed: () => "Could not save the notification settings" },
  "database.save": action("Database saved", "warning", "change", "Saved database", "Could not save database"),
  "database.delete": action("Database deleted", "warning", "change", "Deleted database", "Could not delete database"),
  "database.restore": action("Database restore", "warning", "backup", "Restored database", "Could not restore database"),
  "postgres.create": action("Managed database created", "warning", "change", "Created the managed database", "Could not create the managed database"),
  "postgres.drop": action("Managed database dropped", "warning", "change", "Dropped the managed database", "Could not drop the managed database"),
  "postgres.password": action("Database password rotated", "warning", "security", "Rotated the password of the managed database", "Could not rotate the password of the managed database"),
  "project.save": action("Project file saved", "warning", "change", "Saved the configuration file of project", "Could not save the configuration file of project"),
  "project.delete": action("Project file deleted", "warning", "change", "Deleted the configuration file of project", "Could not delete the configuration file of project"),
  "project.split": action("Project file created", "warning", "change", "Gave its own file to project", "Could not give its own file to project"),
  "preview.deploy": action("Preview deployed", "info", "deployment", "Deployed preview", "Could not deploy preview"),
  "preview.remove": action("Preview removed", "muted", "change", "Removed preview", "Could not remove preview"),
  "preview.save": action("Previews saved", "warning", "change", "Saved the previews of", "Could not save the previews of"),
  "preview.delete": action("Previews deleted", "warning", "change", "Deleted the previews of", "Could not delete the previews of"),
  "preview.evict": action("Preview evicted", "muted", "change", "Evicted preview", "Could not evict preview"),
  "preview.expire": action("Preview expired", "muted", "change", "Removed expired preview", "Could not remove expired preview"),
  enroll: action("Dashboard enrolment", "warning", "security", "Enrolled a dashboard with this agent", "Refused a dashboard's enrolment"),
  "container.start": action("Container started", "info", "change", "Started container", "Could not start container"),
  "env.set": action("Variables set", "warning", "change", "Set the environment variables of", "Could not set the environment variables of"),
  "env.unset": action("Variables removed", "warning", "change", "Removed environment variables of", "Could not remove environment variables of"),
  "env.delete": action("Variables deleted", "warning", "change", "Deleted every environment variable of", "Could not delete the environment variables of"),
  "build_vars.set": action("Build variables set", "warning", "change", "Set the build variables of", "Could not set the build variables of"),
  "build_vars.remove": action("Build variables removed", "warning", "change", "Removed build variables of", "Could not remove build variables of"),
  "database.verify_key": action("Key proof", "info", "backup", "Checked the backup key of", "Could not check the backup key of"),
  "database.restore_test": action("Restore test", "info", "backup", "Tested a restore of", "Could not test a restore of"),
  "notifications.test": { label: "Test alert", tone: "info", kind: "change", done: () => "Sent a test alert", failed: () => "Could not send a test alert" },
  "container.restart": action("Container restarted", "info", "change", "Restarted container", "Could not restart container"),
};

/** Codes may arrive with an underscore (container_start) or a dot (container.start): both name the same action. */
function agentActionOf(code: string): AgentAction | undefined {
  return AGENT_ACTIONS[code] ?? AGENT_ACTIONS[code.replace("_", ".")];
}

export interface AuditOutcome {
  ok: boolean;
  label: string;
  tone: Tone;
}

/** Whether the agent accepted the request, and if not, how to say so: 409 is valid but not applied, 400 invalid. */
export function auditOutcome(status: number): AuditOutcome {
  if (status < 400) return { ok: true, label: "OK", tone: "success" };
  if (status === 401 || status === 403) return { ok: false, label: "Refused", tone: "danger" };
  if (status === 409) return { ok: false, label: "Not applied", tone: "warning" };
  if (status === 400) return { ok: false, label: "Rejected", tone: "warning" };
  return { ok: false, label: "Failed", tone: "danger" };
}

export interface AuditTarget {
  /** The app, job, database or container the request was about; empty when it is the configuration as a whole. */
  text: string;
  href?: string;
  /** What else the entry says, in words. */
  note?: string;
  /** The configuration version the change created, in the version history. */
  versionHref?: string;
  /** What the target is, when the request path says. */
  kind?: "app" | "job" | "database" | "container" | "preview" | "version" | "project";
}

/** The pieces of a request path that name a target. */
const PATHS: { pattern: RegExp; kind: NonNullable<AuditTarget["kind"]> }[] = [
  { pattern: /^\/v1\/apps\/([^/]+)\//, kind: "app" },
  { pattern: /^\/v1\/config\/apps\/([^/]+)$/, kind: "app" },
  { pattern: /^\/v1\/jobs\/([^/]+)\//, kind: "job" },
  { pattern: /^\/v1\/config\/jobs\/([^/]+)$/, kind: "job" },
  { pattern: /^\/v1\/config\/databases\/([^/]+)$/, kind: "database" },
  { pattern: /^\/v1\/databases\/([^/]+)\//, kind: "database" },
  { pattern: /^\/v1\/containers\/([^/]+)\//, kind: "container" },
  { pattern: /^\/v1\/previews\/([^/]+)\/(\d+)$/, kind: "preview" },
  { pattern: /^\/v1\/config\/versions\/(\d+)\/restore$/, kind: "version" },
  { pattern: /^\/v1\/config\/previews\/([^/]+)$/, kind: "app" },
  { pattern: /^\/v1\/projects\/([^/]+)\/(?:config|split)$/, kind: "project" },
];

/** "hash 1a2b3c" (a configuration change), or "shop hash 1a2b3c" (a project's file: the name comes first). */
const HASH_DETAIL = /^(?:[a-z0-9][a-z0-9_-]* )?hash ([0-9a-f]{6,64})$/;

/**
 * What an audit entry was about. The agent's detail is not always a name: a configuration change carries the hash of the
 * file it wrote, so the name is read from the request path, and the hash is turned into the version it created when the
 * version list is at hand.
 */
export function auditTarget(entry: Pick<AgentAuditEntry, "path" | "action" | "detail">, serverId: string, versions: ConfigVersion[] = []): AuditTarget {
  const hash = HASH_DETAIL.exec(entry.detail ?? "")?.[1];
  let name = "";
  let kind: AuditTarget["kind"];
  for (const p of PATHS) {
    const m = p.pattern.exec(entry.path);
    if (m) {
      name = decodeURIComponent(m[1]);
      kind = p.kind;
      if (p.kind === "preview") name = `${name} #${m[2]}`;
      break;
    }
  }

  const base = `/servers/${serverId}`;
  let href: string | undefined;
  switch (kind) {
    case "app":
      href = `${base}/apps/${encodeURIComponent(name)}`;
      break;
    case "job":
      href = `${base}/jobs/${encodeURIComponent(name)}`;
      break;
    case "database":
      href = `${base}/databases/${encodeURIComponent(name)}`;
      break;
    case "container":
      href = `${base}/containers/${encodeURIComponent(name)}`;
      break;
    case "project":
      href = `/projects/${encodeURIComponent(name)}/config#config-${serverId}`;
      break;
  }
  // Deleting something leaves no page to open.
  if (entry.action.endsWith(".delete") || entry.action.endsWith(".remove")) href = undefined;

  if (hash !== undefined) {
    const version = versions.find((v) => v.hash.startsWith(hash));
    const short = hash.slice(0, 12);
    const subject = entry.action.startsWith("config.") || entry.action === "notifications.save" ? "configuration file" : entry.action.startsWith("project.") ? "project file" : "apps file";
    const note = `${subject} changed (version ${version ? version.id : short})`;
    const from = kind === "version" ? `version ${name}` : name;
    const notifications = entry.action === "notifications.save";
    return {
      text: notifications ? "notifications" : from,
      href: notifications ? notificationsHref(serverId) : kind === "version" ? undefined : href,
      note,
      versionHref: version ? `${base}/config/versions#version-${version.id}` : undefined,
      kind,
    };
  }
  if (kind === "version") return { text: `version ${name}`, href: `${base}/config/versions#version-${name}`, kind };
  if (kind === "preview") {
    // The agent's own removals say "shop-pr-12: expired 5m ago"; a deployment says "shop-pr-12 tag=x": drop the instance name.
    const detail = entry.detail ?? "";
    const instance = detail.split(" ")[0] ?? "";
    const rest = instance === "" ? "" : detail.slice(instance.length).replace(/^:/, "").trim();
    return { text: name, href, note: rest || undefined, kind };
  }
  if (kind === undefined) {
    const detail = entry.detail ?? "";
    if (entry.action === "enroll") return { text: "", note: detail.replace(/^code \S+ /, "") || undefined };
    if (entry.action === "config.update" || entry.action === "config.restore") return { text: "", note: detail || undefined };
    if (entry.action === "notifications.save") return { text: "", href: notificationsHref(serverId), note: "notifications" };
    return { text: detail.split(" ")[0] ?? "" };
  }
  // "web sha=abc123" (a build): the app is the name, the rest is a note.
  const extra = entry.detail && entry.detail !== name ? entry.detail.replace(name, "").trim() : "";
  return { text: name, href, note: extra || undefined, kind };
}

export interface AgentAuditLine extends Humanised {
  target: AuditTarget;
  outcome: AuditOutcome;
}

/** One agent audit entry in words: the badge label, the sentence ("Deployed web"), the target to link, and what came of it. */
export function describeAgentAudit(entry: Pick<AgentAuditEntry, "action" | "path" | "detail" | "status">, serverId: string, versions: ConfigVersion[] = []): AgentAuditLine {
  const known = agentActionOf(entry.action);
  const target = auditTarget(entry, serverId, versions);
  const outcome = auditOutcome(entry.status);
  if (!known) {
    const label = humanise(entry.action);
    return { label, tone: "warning", kind: "change", sentence: outcome.ok ? label : `${label} (${outcome.label.toLowerCase()})`, known: false, target, outcome };
  }
  // An enrolment's sentence is its own outcome ("redeemed", "rejected (expired)"): the target is the code, never shown.
  const name = entry.action === "enroll" ? "" : target.text;
  return { label: known.label, tone: known.tone, kind: known.kind, sentence: outcome.ok ? known.done(name) : known.failed(name), known: true, target, outcome };
}

// ---- The dashboard's own audit log ------------------------------------------------------------------------------------

interface DashboardEvent {
  label: string;
  tone: Tone;
  kind: ActivityKind;
  /** The sentence; `detail` is what the dashboard recorded (never a secret). */
  sentence: (detail: string) => string;
  /** Whether the Activity feed lists it: sign-outs, webhook deliveries and what another line already says are left out. */
  feed: boolean;
}

function event(label: string, tone: Tone, kind: ActivityKind, sentence: string | ((detail: string) => string), feed = true): DashboardEvent {
  return { label, tone, kind, sentence: typeof sentence === "string" ? () => sentence : sentence, feed };
}
const withDetail = (text: string) => (d: string) => (d === "" ? text : `${text}: ${d}`);

/**
 * Every event code the dashboard records. A test scans the source for `audit(` and `record(` calls, so a new code cannot
 * be added without a sentence here.
 */
export const DASHBOARD_EVENTS: Record<string, DashboardEvent> = {
  login: event("Signed in", "success", "security", (d) => (d === "" ? "Signed in" : `Signed in (${d.replace(/\+/g, " + ")})`)),
  login_failed: event("Failed sign-in", "danger", "security", (d) => (d === "" ? "A sign-in failed" : `A sign-in failed (${d})`)),
  logout: event("Signed out", "muted", "security", "Signed out", false),
  setup_completed: event("Setup completed", "success", "security", "Finished the first-run setup and set the admin password"),
  setup_failed: event("Setup token refused", "danger", "security", (d) => (d === "" ? "The first-run setup refused a token" : `The first-run setup refused a token (${d})`)),
  recovery_file_downloaded: event("Recovery file downloaded", "warning", "security", "Downloaded the recovery file with the master key"),
  totp_enabled: event("Authenticator enabled", "info", "security", "Turned on the authenticator app"),
  totp_disabled: event("Authenticator disabled", "warning", "security", "Turned off the authenticator app"),
  passkey_added: event("Passkey added", "info", "security", "Added a passkey"),
  passkey_removed: event("Passkey removed", "warning", "security", "Removed a passkey"),
  recovery_codes_regenerated: event("Recovery codes regenerated", "warning", "security", "Generated new recovery codes"),
  recovery_code_used: event("Recovery code used", "warning", "security", (d) => (d === "" ? "Signed in with a recovery code" : `Signed in with a recovery code (${d})`)),
  session_revoked: event("Session signed out", "warning", "security", "Signed a session out"),
  sessions_revoked: event("Other sessions signed out", "warning", "security", (d) => (d === "" ? "Signed the other sessions out" : `Signed out ${d}`)),
  step_up_granted: event("Changes unlocked", "warning", "security", (d) => (d === "" ? "Unlocked sensitive changes for ten minutes" : `Unlocked sensitive changes for ten minutes (signed in with ${d.replace(/\+/g, " + ")})`)),
  step_up_failed: event("Unlock failed", "danger", "security", (d) => (d === "" ? "An attempt to unlock sensitive changes failed" : `An attempt to unlock sensitive changes failed (${d})`)),
  step_up_required: event("Unlock asked for", "info", "security", (d) => (d === "" ? "A sensitive change asked the session to unlock" : `Asked to unlock for: ${d}`), false),
  security_confirm_failed: event("Password confirmation failed", "danger", "security", "A password confirmation failed"),
  api_token_created: event("API token created", "info", "security", (d) => (d === "" ? "Created an API token" : `Created API token ${d}`)),
  api_token_revoked: event("API token revoked", "warning", "security", (d) => (d === "" ? "Revoked an API token" : `Revoked API token ${d}`)),
  api_denied: event("API call refused", "danger", "security", (d) => (d === "" ? "An API call was refused" : `An API call was refused: ${d}`)),
  // An accepted call is a deployment or a run of its own, named after the token by the agent's audit log: only what the agent never saw is listed here.
  api_deploy: event("Deploy by API token", "info", "deployment", (d) => apiSentence("deploy", d), true),
  api_rollback: event("Rollback by API token", "warning", "deployment", (d) => apiSentence("roll back", d), true),
  api_build: event("Build by API token", "info", "deployment", (d) => apiSentence("build", d), true),
  api_job_run: event("Job run by API token", "info", "job", (d) => apiSentence("run", d), true),
  container_start: event("Container started", "info", "change", withDetail("Started a container"), false),
  container_start_failed: event("Container start failed", "danger", "change", (d) => withDetail("Could not start a container")(d)),
  container_restart: event("Container restarted", "warning", "change", withDetail("Restarted a container"), false),
  container_restart_failed: event("Container restart failed", "danger", "change", (d) => withDetail("Could not restart a container")(d)),
  // Managed variables: the detail lists names, never values. The agent writes its own entry for each, so none is in the feed twice.
  env_set: event("Variables set", "warning", "change", withDetail("Set environment variables"), false),
  env_set_failed: event("Setting variables failed", "danger", "change", withDetail("Could not set environment variables")),
  env_unset: event("Variables removed", "warning", "change", withDetail("Removed environment variables"), false),
  env_build: event("Build-time flag changed", "warning", "change", withDetail("Changed what is available at build time"), false),
  env_delete: event("Variables deleted", "warning", "change", withDetail("Deleted every environment variable of a scope"), false),
  env_delete_failed: event("Deleting variables failed", "danger", "change", withDetail("Could not delete environment variables")),
  // Build variables kept on a builder for an app it builds for another server: the detail lists names, never values.
  build_vars_set: event("Build variables set", "warning", "change", withDetail("Set build variables"), false),
  build_vars_unset: event("Build variables removed", "warning", "change", withDetail("Removed build variables"), false),
  build_vars_delete: event("Build variables deleted", "warning", "change", withDetail("Deleted every build variable of an app"), false),
  build_vars_failed: event("Build variables failed", "danger", "change", withDetail("Could not change build variables")),
  server_enrol: event("Server added", "info", "change", (d) => (d === "" ? "Added a server" : `Added server ${d}`)),
  relay_enrol: event("Build machine connected", "info", "change", (d) => (d === "" ? "A machine connected to this dashboard" : `Machine ${d} connected to this dashboard`)),
  relay_enrol_server: event("Server connected", "info", "change", (d) => (d === "" ? "A server connected to this dashboard" : `Server ${d} connected to this dashboard`)),
  agent_uninstalled: event("Agent uninstalled", "warning", "change", (d) => (d === "" ? "Uninstalled an agent" : `Uninstalled the agent of ${d}`)),
  github_connected: event("GitHub connected", "info", "change", (d) => (d === "" ? "Connected GitHub" : `Connected GitHub as ${d}`)),
  github_disconnected: event("GitHub disconnected", "warning", "change", "Disconnected GitHub"),
  github_app_saved: event("GitHub App saved", "info", "change", (d) => (d === "" ? "Saved a GitHub App" : `Saved ${d}`)),
  github_app_removed: event("GitHub App removed", "warning", "change", (d) => (d === "" ? "Removed the GitHub App" : `Removed ${d}`)),
  github_app_connect_started: event("GitHub App setup started", "info", "change", (d) => (d === "" ? "Started creating a GitHub App" : `Started creating a GitHub App (${d})`)),
  github_app_created: event("GitHub App created", "info", "change", (d) => (d === "" ? "Created a GitHub App" : `Created ${d}`)),
  github_app_connect_failed: event("GitHub App setup failed", "danger", "change", (d) => (d === "" ? "Creating the GitHub App failed" : `Creating the GitHub App failed: ${d}`)),
  github_app_callback_refused: event("GitHub callback refused", "danger", "security", (d) => (d === "" ? "Refused a GitHub callback" : `Refused a GitHub callback (${d})`)),
  dashboard_backup: event("Dashboard copy downloaded", "info", "security", (d) => (d === "" ? "Downloaded a copy of the dashboard's database" : `Downloaded a copy of the dashboard's database (${d})`)),
  notifications_default_saved: event("Notification default saved", "info", "change", "Saved the default notification settings"),
  notifications_default_applied: event("Notification default applied", "warning", "change", (d) => (d === "" ? "Applied the default notification settings to servers" : `Applied the default notification settings: ${d}`)),
  webhook_delivery: event("Webhook delivery", "muted", "change", withDetail("Handled a GitHub webhook"), false),
  webhook_secret_removed: event("Webhook secret removed", "warning", "security", "Removed the GitHub webhook secret"),
  repo_linked: event("Repository linked", "info", "change", (d) => (d === "" ? "Linked a repository" : `Linked ${d}`)),
  repo_unlinked: event("Repository unlinked", "warning", "change", (d) => (d === "" ? "Unlinked a repository" : `Unlinked ${d}`)),
  build_modes: event("Build settings changed", "info", "change", (d) => (d === "" ? "Changed build settings" : `Changed build settings of ${d}`)),
  auto_deploy_on: event("Auto-deploy on", "info", "change", (d) => (d === "" ? "Turned auto-deploy on" : `Turned auto-deploy on for ${d}`)),
  auto_deploy_off: event("Auto-deploy off", "warning", "change", (d) => (d === "" ? "Turned auto-deploy off" : `Turned auto-deploy off for ${d}`)),
  previews_on: event("Previews on", "info", "change", (d) => (d === "" ? "Turned previews on" : `Turned previews on for ${d}`)),
  previews_off: event("Previews off", "warning", "change", (d) => (d === "" ? "Turned previews off" : `Turned previews off for ${d}`)),
  preview_removed: event("Preview removed", "warning", "change", (d) => (d === "" ? "Removed a preview" : `Removed preview ${d}`)),
  app_created_from_repo: event("App created", "info", "change", (d) => (d === "" ? "Created an app from a repository" : `Created app ${d}`)),
  app_created_from_image: event("App created", "info", "change", (d) => (d === "" ? "Created an app from an image" : `Created app ${d}`)),
  first_deploy_started: event("First deployment started", "info", "deployment", (d) => (d === "" ? "Started a first deployment" : `Started a first deployment: ${d}`)),
  apps_domain_set: event("Apps domain set", "info", "change", (d) => (d === "" ? "Set a server's apps domain" : `Set the apps domain: ${d}`)),
  server_public_ip_set: event("Public address set", "info", "change", (d) => (d === "" ? "Set a server's public address" : `Set the public address: ${d}`)),
  database_created: event("Database created", "info", "change", (d) => (d === "" ? "Created a database for a new app" : `Created a database: ${d}`)),
  first_build_started: event("First build started", "info", "change", (d) => (d === "" ? "Started a first build" : `Started a first build: ${d}`)),
  build_started: event("Build started", "info", "change", (d) => (d === "" ? "Started a build" : `Started a build: ${d}`)),
  build_transferred: event("Image sent and deployed", "info", "deployment", (d) => (d === "" ? "Sent a built image to its server and deployed it" : `Sent a built image to its server and deployed it: ${d}`)),
  build_transfer_failed: event("Image transfer failed", "warning", "deployment", (d) => (d === "" ? "A built image did not reach its server" : `A built image did not reach its server: ${d}`)),
  relay_code_created: event("Machine code created", "info", "change", "Made a code for a machine that connects to this dashboard"),
  build_server_set: event("Build server changed", "info", "change", (d) => (d === "" ? "Changed where an app is built" : `Changed where an app is built: ${d}`)),
  cloudflare_connected: event("Cloudflare connected", "info", "change", (d) => (d === "" ? "Connected Cloudflare" : `Connected Cloudflare (${d.replace(/, token \S+$/, "")})`)),
  cloudflare_disconnected: event("Cloudflare disconnected", "warning", "change", "Disconnected Cloudflare"),
  dns_record_created: event("DNS record created", "info", "change", (d) => (d === "" ? "Created a DNS record" : `Created DNS record ${d}`)),
  dns_record_replaced: event("DNS record replaced", "warning", "change", (d) => (d === "" ? "Replaced a DNS record" : `Replaced DNS record ${d}`)),
};

const API_DETAIL = /^server=(.*?) (app|job)=(\S+)(?: ref=(\S+))? outcome=(.*)$/;

/** What an API call recorded: the app or job, the server, and what came of it ("accepted deployment_id=…", "refused (409): …"). */
export function parseApiCall(detail: string): { server: string; subject: string; ref?: string; outcome: string; accepted: boolean } | null {
  const m = API_DETAIL.exec(detail);
  if (!m) return null;
  const outcome = m[5];
  return { server: m[1], subject: m[3], ref: m[4], outcome, accepted: outcome.startsWith("accepted") };
}

function apiSentence(verb: string, detail: string): string {
  const call = parseApiCall(detail);
  if (!call) return `Could not ${verb}`;
  const what = call.accepted ? `${verb === "deploy" ? "Deployed" : verb === "roll back" ? "Rolled back" : verb === "build" ? "Started a build of" : "Ran job"} ${call.subject}` : `Could not ${verb} ${call.subject}`;
  return call.accepted ? what : `${what}: ${call.outcome}`;
}

export interface DashboardAuditLine extends Humanised {
  /** In the Activity feed. */
  feed: boolean;
  /** An API call that was accepted: its deployment or run has a row of its own. */
  accepted: boolean;
}

/** One dashboard audit entry in words. Never prints the raw code, except for a code it does not know, made readable. */
export function describeDashboardAudit(entry: Pick<DashboardAuditEntry, "event" | "detail">): DashboardAuditLine {
  const detail = entry.detail ?? "";
  const known = DASHBOARD_EVENTS[entry.event];
  const api = entry.event.startsWith("api_") && entry.event !== "api_denied" && !entry.event.startsWith("api_token") ? parseApiCall(detail) : null;
  const accepted = api?.accepted ?? false;
  if (!known) {
    const label = humanise(entry.event);
    return { label, tone: "muted", kind: "change", sentence: detail === "" ? label : `${label}: ${detail}`, known: false, feed: false, accepted: false };
  }
  return {
    label: known.label,
    tone: api !== null && !accepted ? "danger" : known.tone,
    kind: known.kind,
    sentence: known.sentence(detail),
    known: true,
    // An accepted API call is the deployment or run itself, listed by the agent's side: not twice.
    feed: known.feed && !accepted,
    accepted,
  };
}

const INTEGRATION_EVENT = /^(github_|webhook_|repo_|build_modes|build_started|build_transfer|build_server_|auto_deploy_|previews_|preview_removed|cloudflare_|dns_|app_created_from_repo|first_build_started)/;

/** The settings page where a dashboard event can be looked into; none for what has no page of its own. */
export function dashboardAuditHref(event: string): string | undefined {
  if (event === "api_denied" || event.startsWith("api_token")) return "/settings/api-tokens";
  if (event.startsWith("api_")) return undefined;
  if (INTEGRATION_EVENT.test(event)) return "/settings/integrations";
  if (event === "dashboard_backup") return "/settings/backup";
  if (event.startsWith("notifications_default_")) return "/settings/notifications";
  if (event === "server_enrol" || event === "relay_enrol" || event === "relay_enrol_server" || event === "agent_uninstalled") return "/servers";
  if (event.startsWith("container_")) return undefined;
  return DASHBOARD_EVENTS[event]?.kind === "security" ? "/settings/security" : undefined;
}
