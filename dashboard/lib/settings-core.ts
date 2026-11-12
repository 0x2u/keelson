import type { ConfigDocument, NotificationsConfig } from "@/lib/agent-types";
import type { TokenStatus } from "@/lib/api-tokens-core";
import type { Loaded } from "@/lib/data";
import { spanText } from "@/lib/attention-core";
import type { ReadinessItem } from "@/lib/readiness-core";
import type { Tone } from "@/lib/status";

// What the Settings index says about each section in one line: is it set up, and how. Pure: the page reads the stores and
// the agents, this words it.

export interface SettingsStatus {
  tone: Tone;
  label: string;
}

export interface SettingsCard {
  id: "security" | "backup" | "api-tokens" | "github" | "cloudflare";
  title: string;
  href: string;
  description: string;
  status: SettingsStatus;
}

export interface SettingsInput {
  totp: boolean;
  passkeys: number;
  tokens: TokenStatus[];
  /** The GitHub App, when one is connected (by its name, or its slug, or its id). */
  githubApp: { label: string } | null;
  /** The personal token's GitHub account, when one is connected. */
  githubAccount: string | null;
  cloudflare: { expiresOn: string | null } | null;
  /** The readiness item of the dashboard's own backup (see lib/readiness-core): the settings card says what the checklist says. */
  backup: ReadinessItem;
  now: number;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** "2FA on: an authenticator app and 2 passkeys", or the warning that a password is all there is. */
export function securityStatus(totp: boolean, passkeys: number): SettingsStatus {
  if (!totp && passkeys === 0) return { tone: "warning", label: "2FA off: a password is all that protects this dashboard" };
  const parts = [totp ? "an authenticator app" : null, passkeys > 0 ? plural(passkeys, "passkey") : null].filter((p) => p !== null);
  return { tone: "success", label: `2FA on: ${parts.join(" and ")}` };
}

/** Whether a copy of the dashboard's own state exists, and how old it is: the readiness item of it, in one line. */
export function backupStatus(item: ReadinessItem, now: number): SettingsStatus {
  if (item.since === undefined) return { tone: "warning", label: "No copy downloaded yet" };
  const age = `Last copy downloaded ${spanText(now - Date.parse(item.since))} ago`;
  return item.state === "ok" ? { tone: "success", label: age } : { tone: "warning", label: `${age}: it is out of date` };
}

export function tokensStatus(tokens: TokenStatus[]): SettingsStatus {
  const active = tokens.filter((t) => t === "active").length;
  const expired = tokens.filter((t) => t === "expired").length;
  if (active === 0) return { tone: "muted", label: expired > 0 ? `No active token (${expired} expired)` : "No API token" };
  return { tone: "success", label: `${plural(active, "active token")}${expired > 0 ? `, ${expired} expired` : ""}` };
}

export function githubStatus(app: SettingsInput["githubApp"], account: string | null): SettingsStatus {
  if (app) return { tone: "success", label: `Connected: GitHub App ${app.label}` };
  if (account) return { tone: "success", label: `Connected as ${account} (personal token)` };
  return { tone: "muted", label: "Not connected" };
}

export function cloudflareStatus(connection: SettingsInput["cloudflare"]): SettingsStatus {
  if (!connection) return { tone: "muted", label: "Not connected" };
  return { tone: "success", label: connection.expiresOn ? `Connected, token expires ${connection.expiresOn.slice(0, 10)}` : "Connected" };
}

/** The cards of the index, in the order they are shown. */
export function settingsCards(input: SettingsInput): SettingsCard[] {
  return [
    {
      id: "security",
      title: "Security",
      href: "/settings/security",
      description: "Second factor, passkeys, recovery codes, signed-in sessions and the sign-in audit log.",
      status: securityStatus(input.totp, input.passkeys),
    },
    {
      id: "backup",
      title: "Backup",
      href: "/settings/backup",
      description: "A copy of this dashboard's own state: its servers, tokens and settings, without the key that decrypts them.",
      status: backupStatus(input.backup, input.now),
    },
    {
      id: "api-tokens",
      title: "API tokens",
      href: "/settings/api-tokens",
      description: "Access for machines: the REST API and the MCP server, each with a scope and an expiry.",
      status: tokensStatus(input.tokens),
    },
    {
      id: "github",
      title: "GitHub",
      href: "/settings/integrations",
      description: "The App that lists repositories, builds and deploys on push, and answers webhooks.",
      status: githubStatus(input.githubApp, input.githubAccount),
    },
    {
      id: "cloudflare",
      title: "Cloudflare",
      href: "/settings/integrations",
      description: "DNS records for the domains of new apps, and live domain checks.",
      status: cloudflareStatus(input.cloudflare),
    },
  ];
}

/** What one server's notifications are, as the dashboard learned it from the agent. */
export type NotificationState =
  | { kind: "configured"; channels: string[] }
  | { kind: "none" }
  /** The agent has no apps file: nothing to configure. */
  | { kind: "read-only" }
  /** The configuration could not be read (the agent did not answer, or its file is invalid): not "none". */
  | { kind: "unknown"; reason: string };

/** Where the notifications of a configuration go: "2 webhooks, Telegram, heartbeat". */
export function notificationChannels(n: NotificationsConfig | undefined): string[] {
  if (!n) return [];
  const channels: string[] = [];
  if (n.webhooks && n.webhooks.length > 0) channels.push(plural(n.webhooks.length, "webhook"));
  if (n.telegram) channels.push("Telegram");
  if (n.heartbeat) channels.push("heartbeat");
  return channels;
}

/** The state of a server's notifications from what its agent answered about its configuration. */
export function notificationState(config: Loaded<ConfigDocument | null>): NotificationState {
  if (config.error !== undefined) return { kind: "unknown", reason: config.error };
  if (config.data === null) return { kind: "read-only" };
  if (config.data.error) return { kind: "unknown", reason: "its configuration file is invalid" };
  const channels = notificationChannels(config.data.model.notifications);
  return channels.length > 0 ? { kind: "configured", channels } : { kind: "none" };
}

export function notificationStatus(state: NotificationState): SettingsStatus {
  switch (state.kind) {
    case "configured":
      return { tone: "success", label: state.channels.join(", ") };
    case "none":
      return { tone: "muted", label: "Not configured" };
    case "read-only":
      return { tone: "muted", label: "Read-only server: nothing to configure" };
    case "unknown":
      return { tone: "warning", label: `Can't tell: ${state.reason}` };
  }
}
