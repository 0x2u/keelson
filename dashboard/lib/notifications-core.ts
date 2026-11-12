import { HIDDEN, type NotificationsConfig } from "@/lib/agent-types";

// The notification settings of the whole fleet, as pure functions. The truth stays on each agent (its apps file, saved through
// its signed API): nothing here is desired state. A *default* is a template the operator applies on demand; whether a server
// follows it is computed by comparing what the agent reports with the template, and what applying it would write is computed
// from the same two things. Secrets never enter: a webhook URL is asked for when the default is applied and goes to the agents
// only; a bot token and a signing secret are files on each agent that the dashboard never reads or writes (only their paths).

// ---- What the agent knows ---------------------------------------------------------------------------------------------

/** The events an agent can send, in the order the forms list them. */
export const KNOWN_EVENTS: { value: string; label: string }[] = [
  { value: "deployment.failed", label: "A deploy or a roll back failed" },
  { value: "deployment.rolled_back", label: "A deploy failed and was rolled back" },
  { value: "deployment.rollback_failed", label: "A deploy failed and the previous version could not be restored" },
  { value: "deployment.succeeded", label: "A deploy or a roll back succeeded" },
  { value: "app.down", label: "An app went down" },
  { value: "app.recovered", label: "An app recovered" },
  { value: "job.failed", label: "A job failed" },
  { value: "job.recovered", label: "A job recovered" },
  { value: "certificate.expiring", label: "A certificate is about to expire" },
  { value: "certificate.renewed", label: "A certificate was renewed" },
  { value: "proxy.drifted", label: "The proxy no longer served what the agent had applied" },
  { value: "dashboard.unreachable", label: "The server cannot reach the dashboard" },
  { value: "dashboard.recovered", label: "The server reaches the dashboard again" },
  { value: "job.missed", label: "Scheduled runs were missed (the agent was not running)" },
  { value: "engine.down", label: "The Docker engine stopped answering" },
  { value: "engine.recovered", label: "The Docker engine answers again" },
  { value: "disk.high", label: "A disk is nearly full" },
  { value: "disk.recovered", label: "A disk is back under its threshold" },
  { value: "memory.low", label: "Memory is low" },
  { value: "agent.started", label: "The agent started (a reboot or a crash loop shows)" },
];

/** What an agent sends when its file lists no events (its `DefaultEvents`). */
export const DEFAULT_EVENTS = [
  "deployment.failed",
  "deployment.rolled_back",
  "deployment.rollback_failed",
  "app.down",
  "app.recovered",
  "job.failed",
  "job.recovered",
  "certificate.expiring",
  "certificate.renewed",
  "proxy.drifted",
];

export const DEFAULT_DISK_PERCENT = 85;
export const DEFAULT_MEMORY_PERCENT = 10;
export const DEFAULT_COOLDOWN = "5m";
/** The bounds the agent enforces (and the forms check): disk 6..100, memory 1..95. */
export const DISK_RANGE = { min: 6, max: 100 } as const;
export const MEMORY_RANGE = { min: 1, max: 95 } as const;
export const MAX_WEBHOOK_SLOTS = 5;

const DURATION = /^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/;
const UNIT_SECONDS: Record<string, number> = { ns: 1e-9, us: 1e-6, µs: 1e-6, ms: 1e-3, s: 1, m: 60, h: 3600 };

/** A Go duration ("90s", "1h30m") in seconds, or null when it is not one. */
export function durationSeconds(text: string): number | null {
  const t = text.trim();
  if (!DURATION.test(t)) return null;
  let total = 0;
  for (const [, n, , unit] of t.matchAll(/(\d+(\.\d+)?)(ns|us|µs|ms|s|m|h)/g)) total += Number(n) * UNIT_SECONDS[unit];
  return total;
}

// ---- The default (template) -------------------------------------------------------------------------------------------

/**
 * The non-secret part of a server's notifications that the operator wants to be the same everywhere. A channel is expected
 * when it is listed: a Telegram chat (the bot token is a file on each server: only its path is shared) and webhook slots
 * (only the path of the signing-secret file: the URLs are secrets, asked for when the default is applied). The name, the
 * heartbeat and any webhook beyond the slots stay what each server has.
 */
export interface NotificationsTemplate {
  /** Empty: the agent's own default events. */
  events: string[];
  diskPercent: number;
  memoryPercent: number;
  cooldown: string;
  telegram: { botTokenFile: string; chatId: string; apiUrl: string } | null;
  webhooks: { secretFile: string }[];
}

/** What the template editor holds: text fields, as typed. */
export interface TemplateDraft {
  events: string[];
  diskPercent: string;
  memoryPercent: string;
  cooldown: string;
  telegram: boolean;
  botTokenFile: string;
  chatId: string;
  apiUrl: string;
  webhookSecretFiles: string[];
}

/** The default's Events help: a new default starts with the agent's default events ticked, so it says so and what unticking all does. */
export const TEMPLATE_EVENTS_HELP =
  "Ticked: the events the agent sends by default. Untick the ones you do not want; with none ticked, each server keeps the agent's default events.";

export function draftOfTemplate(t: NotificationsTemplate | null): TemplateDraft {
  return {
    events: t ? t.events : [...DEFAULT_EVENTS],
    diskPercent: String(t?.diskPercent ?? DEFAULT_DISK_PERCENT),
    memoryPercent: String(t?.memoryPercent ?? DEFAULT_MEMORY_PERCENT),
    cooldown: t?.cooldown ?? DEFAULT_COOLDOWN,
    telegram: t?.telegram != null,
    botTokenFile: t?.telegram?.botTokenFile ?? "",
    chatId: t?.telegram?.chatId ?? "",
    apiUrl: t?.telegram?.apiUrl ?? "",
    webhookSecretFiles: t ? t.webhooks.map((w) => w.secretFile) : [],
  };
}

export type TemplateErrors = Record<string, string>;
export type TemplateParse = { ok: true; template: NotificationsTemplate } | { ok: false; errors: TemplateErrors };

const MAX_TEXT = 500;

function integerIn(value: unknown, what: string, min: number, max: number): { value: number } | { error: string } {
  const n = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n)) return { error: `${what} must be a whole number.` };
  if (n < min || n > max) return { error: `${what} must be between ${min} and ${max}.` };
  return { value: n };
}

const text = (v: unknown): string | null => (typeof v === "string" && v.length <= MAX_TEXT ? v.trim() : null);

/**
 * Validates and normalises a template (from the editor's fields, or a request: nothing about its shape is trusted). The rules
 * are the agent's: the same bounds, only known events, a Telegram chat needs both its token file and its chat id.
 */
export function parseTemplate(raw: unknown): TemplateParse {
  const errors: TemplateErrors = {};
  const o: Record<string, unknown> = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};

  const events = Array.isArray(o.events) && o.events.every((e) => typeof e === "string") ? (o.events as string[]) : null;
  if (events === null) errors.events = "The events must be a list.";
  else if (events.some((e) => !KNOWN_EVENTS.some((k) => k.value === e))) errors.events = "One of the events is not one the agent sends.";

  const disk = integerIn(o.diskPercent, "The disk threshold", DISK_RANGE.min, DISK_RANGE.max);
  if ("error" in disk) errors.diskPercent = disk.error;
  const memory = integerIn(o.memoryPercent, "The memory threshold", MEMORY_RANGE.min, MEMORY_RANGE.max);
  if ("error" in memory) errors.memoryPercent = memory.error;

  const cooldown = text(o.cooldown);
  if (cooldown === null || !DURATION.test(cooldown)) errors.cooldown = "Not a duration. A number and a unit, for example 90s, 5m or 1h30m.";

  let telegram: NotificationsTemplate["telegram"] = null;
  if (o.telegram !== null && o.telegram !== undefined) {
    const t = typeof o.telegram === "object" ? (o.telegram as Record<string, unknown>) : {};
    const botTokenFile = text(t.botTokenFile);
    const chatId = text(t.chatId);
    const apiUrl = text(t.apiUrl ?? "");
    if (!botTokenFile) errors.botTokenFile = "Enter the path of the file that holds the bot token.";
    if (!chatId) errors.chatId = "Enter the chat id.";
    if (apiUrl === null) errors.apiUrl = "That is not a valid URL.";
    else if (apiUrl !== "" && !/^https?:\/\/\S+$/.test(apiUrl)) errors.apiUrl = "The URL must start with http:// or https://.";
    if (botTokenFile && chatId && apiUrl !== null) telegram = { botTokenFile, chatId, apiUrl };
  }

  const slots = Array.isArray(o.webhooks) ? o.webhooks : null;
  const webhooks: { secretFile: string }[] = [];
  if (slots === null) errors.webhooks = "The webhooks must be a list.";
  else if (slots.length > MAX_WEBHOOK_SLOTS) errors.webhooks = `At most ${MAX_WEBHOOK_SLOTS} webhooks.`;
  else {
    slots.forEach((slot, i) => {
      const secretFile = text(typeof slot === "object" && slot !== null ? ((slot as Record<string, unknown>).secretFile ?? "") : null);
      if (secretFile === null) errors[`webhook.${i}`] = "That is not a valid path.";
      else webhooks.push({ secretFile });
    });
  }

  if (Object.keys(errors).length > 0 || events === null || "error" in disk || "error" in memory || cooldown === null) return { ok: false, errors };
  const known = KNOWN_EVENTS.map((e) => e.value).filter((e) => events.includes(e));
  return { ok: true, template: { events: known, diskPercent: disk.value, memoryPercent: memory.value, cooldown, telegram, webhooks } };
}

/** The template the editor's fields describe, or what is wrong with them. */
export function templateOfDraft(d: TemplateDraft): TemplateParse {
  return parseTemplate({
    events: d.events,
    diskPercent: d.diskPercent,
    memoryPercent: d.memoryPercent,
    cooldown: d.cooldown,
    telegram: d.telegram ? { botTokenFile: d.botTokenFile, chatId: d.chatId, apiUrl: d.apiUrl } : null,
    webhooks: d.webhookSecretFiles.map((secretFile) => ({ secretFile })),
  });
}

/** Why a webhook URL typed for the apply is not acceptable, or undefined. Empty is allowed here: it keeps what each server has. */
export function webhookUrlProblem(url: string): string | undefined {
  const t = url.trim();
  if (t === "") return undefined;
  if (t.length > 2000) return "That URL is too long.";
  try {
    const parsed = new URL(t);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? undefined : "The URL must start with http:// or https://.";
  } catch {
    return "That is not a valid URL. Include the scheme, for example https://example.com/hook.";
  }
}

// ---- Reading a server's section ---------------------------------------------------------------------------------------

export interface Channels {
  telegram: boolean;
  webhooks: number;
  heartbeat: boolean;
}

export const channelsOf = (n: NotificationsConfig | undefined): Channels => ({
  telegram: n?.telegram !== undefined,
  webhooks: n?.webhooks?.length ?? 0,
  heartbeat: n?.heartbeat !== undefined,
});

/** Whether anything is set up that can say an alert (a heartbeat only pings an external switch). */
export const hasAlertChannel = (c: Channels): boolean => c.telegram || c.webhooks > 0;

/** "None", "Telegram", "Webhook", "2 webhooks", "Telegram + Webhook". */
export function channelLabel(c: Channels): string {
  const parts = [...(c.telegram ? ["Telegram"] : []), ...(c.webhooks === 0 ? [] : [c.webhooks === 1 ? "Webhook" : `${c.webhooks} webhooks`])];
  return parts.length === 0 ? "None" : parts.join(" + ");
}

const sortedEvents = (events: readonly string[]): string[] => [...new Set(events)].sort();

/** The events a server really sends: its list, or the agent's default when the file has none. */
export const effectiveEvents = (n: NotificationsConfig | undefined): string[] => sortedEvents(n?.events ?? DEFAULT_EVENTS);

/** The events of a section in a few words: "Default (7)", "4 events", "None". */
export function eventsSummary(n: NotificationsConfig | undefined): { text: string; list: string[] } {
  const list = effectiveEvents(n);
  if (n?.events === undefined) return { text: `Default (${list.length})`, list };
  return { text: list.length === 0 ? "None" : `${list.length} ${list.length === 1 ? "event" : "events"}`, list };
}

// ---- Differences ------------------------------------------------------------------------------------------------------

export type Difference = "events" | "disk" | "memory" | "cooldown" | "telegram" | "webhooks";

export const DIFFERENCE_LABEL: Record<Difference, string> = {
  events: "events",
  disk: "disk threshold",
  memory: "memory threshold",
  cooldown: "cooldown",
  telegram: "Telegram",
  webhooks: "webhooks",
};

/**
 * How a server's real section differs from the template, compared on what the agent would do (a missing value is its
 * default, "300s" is "5m"). A channel the template does not expect is left alone; one it expects must be there and match.
 * Webhook URLs cannot be compared (the agent never says them): only that a webhook is there and which secret file it uses.
 */
export function differences(template: NotificationsTemplate, n: NotificationsConfig | undefined): Difference[] {
  const out: Difference[] = [];
  const wanted = sortedEvents(template.events.length > 0 ? template.events : DEFAULT_EVENTS);
  if (effectiveEvents(n).join() !== wanted.join()) out.push("events");
  if ((n?.disk_alert_percent ?? DEFAULT_DISK_PERCENT) !== template.diskPercent) out.push("disk");
  if ((n?.memory_alert_percent ?? DEFAULT_MEMORY_PERCENT) !== template.memoryPercent) out.push("memory");
  if (durationSeconds(n?.alert_cooldown ?? DEFAULT_COOLDOWN) !== durationSeconds(template.cooldown)) out.push("cooldown");
  const t = template.telegram;
  if (t && !(n?.telegram && n.telegram.bot_token_file === t.botTokenFile && n.telegram.chat_id === t.chatId && (n.telegram.api_url ?? "") === t.apiUrl)) out.push("telegram");
  if (template.webhooks.some((slot, i) => !n?.webhooks?.[i] || (n.webhooks[i].secret_file ?? "") !== slot.secretFile)) out.push("webhooks");
  return out;
}

// ---- Applying the template to one server ------------------------------------------------------------------------------

/** Stands for a webhook URL the operator typed, in what the dashboard shows (the URL itself is never shown, kept or logged). */
export const NEW_URL_TEXT = "<new URL, write-only>";

export type Merge = { ok: true; config: NotificationsConfig } | { ok: false; needsUrl: number };

/**
 * The section to save on a server so that it follows the template: the template's events, thresholds and cooldown, its
 * Telegram chat and its webhook slots; everything else of the server's section stays (its name, its heartbeat, a webhook
 * beyond the slots, a Telegram chat when the template expects none). `urls[i]` is the URL for webhook slot i; empty keeps
 * the URL the server stores for that position, and a slot with neither is `needsUrl` (the 1-based slot).
 */
export function mergeTemplate(current: NotificationsConfig | undefined, template: NotificationsTemplate, urls: readonly string[]): Merge {
  const out: NotificationsConfig = {};
  if (current?.name) out.name = current.name;
  if (template.events.length > 0) out.events = [...template.events];
  const existing = current?.webhooks ?? [];
  if (template.webhooks.length > 0 || existing.length > 0) {
    const webhooks: { url: string; secret_file?: string }[] = existing.map((w) => ({ ...w }));
    for (let i = 0; i < template.webhooks.length; i++) {
      const url = urls[i]?.trim() || existing[i]?.url;
      if (!url) return { ok: false, needsUrl: i + 1 };
      const hook: { url: string; secret_file?: string } = { url };
      if (template.webhooks[i].secretFile) hook.secret_file = template.webhooks[i].secretFile;
      webhooks[i] = hook;
    }
    out.webhooks = webhooks;
  }
  const t = template.telegram;
  if (t) out.telegram = { bot_token_file: t.botTokenFile, chat_id: t.chatId, ...(t.apiUrl ? { api_url: t.apiUrl } : {}) };
  else if (current?.telegram) out.telegram = { ...current.telegram };
  if (current?.heartbeat) out.heartbeat = { ...current.heartbeat };
  out.disk_alert_percent = template.diskPercent;
  out.memory_alert_percent = template.memoryPercent;
  out.alert_cooldown = template.cooldown;
  return { ok: true, config: out };
}

/** Whether applying the template with these URLs (one per slot, empty = keep) writes anything on a server that has `current`. */
export const wouldChange = (template: NotificationsTemplate, current: NotificationsConfig | undefined, urls: readonly string[]): boolean =>
  differences(template, current).length > 0 || template.webhooks.some((_, i) => (urls[i] ?? "").trim() !== "");

/** A section as text, for the diff. Secrets are what the agent shows (`<hidden>`), never more. */
export function sectionText(n: NotificationsConfig | undefined): string {
  if (n === undefined) return "";
  const q = (v: string | number) => (typeof v === "number" ? String(v) : JSON.stringify(v));
  const lines: string[] = [];
  if (n.name !== undefined) lines.push(`name: ${q(n.name)}`);
  if (n.events !== undefined) lines.push(n.events.length === 0 ? "events: []" : "events:", ...n.events.map((e) => `  - ${e}`));
  if (n.webhooks?.length) {
    lines.push("webhooks:");
    for (const w of n.webhooks) lines.push(`  - url: ${w.url === HIDDEN || w.url === NEW_URL_TEXT ? w.url : HIDDEN}`, ...(w.secret_file ? [`    secret_file: ${q(w.secret_file)}`] : []));
  }
  if (n.telegram) lines.push("telegram:", `  bot_token_file: ${q(n.telegram.bot_token_file)}`, `  chat_id: ${q(n.telegram.chat_id)}`, ...(n.telegram.api_url ? [`  api_url: ${q(n.telegram.api_url)}`] : []));
  if (n.heartbeat) lines.push("heartbeat:", `  url: ${HIDDEN}`, ...(n.heartbeat.every ? [`  every: ${q(n.heartbeat.every)}`] : []));
  if (n.disk_alert_percent !== undefined) lines.push(`disk_alert_percent: ${n.disk_alert_percent}`);
  if (n.memory_alert_percent !== undefined) lines.push(`memory_alert_percent: ${n.memory_alert_percent}`);
  if (n.alert_cooldown !== undefined) lines.push(`alert_cooldown: ${q(n.alert_cooldown)}`);
  return `${lines.join("\n")}\n`;
}
