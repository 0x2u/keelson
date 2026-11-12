"use client";

import { ICONS } from "@/lib/icons";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";
import { saveNotificationsAction } from "@/app/config-actions";
import {
  DURATION_HINT,
  durationError,
  DurationField,
  fieldIssues,
  FixFieldsNotice,
  FormFooter,
  FormSection,
  focusFirstInvalid,
  integerError,
  optionalText,
  SaveProblems,
  SecretValueInput,
  sectionProblems,
  toInteger,
  useFieldErrors,
} from "@/components/config/FormParts";
import { CheckboxField, FieldShell, TextField } from "@/components/forms/fields";
import { useConfigSave } from "@/components/config/useConfigSave";
import { Button } from "@/components/ui/button";
import { HIDDEN, type ConfigIssue, type NotificationsConfig } from "@/lib/agent-types";
import { liveNotice } from "@/lib/app-config-core";
import { KNOWN_EVENTS } from "@/lib/notifications-core";
import { notificationsHref } from "@/lib/redirects-core";

interface WebhookDraft {
  url: string;
  /** The agent holds a URL for this position: HIDDEN keeps it. */
  stored: boolean;
  /** A webhook before this one was removed, so the agent's stored URL at this position is another webhook's. */
  reenter: boolean;
  secretFile: string;
}

interface NotificationsDraft {
  name: string;
  events: string[];
  webhooks: WebhookDraft[];
  botTokenFile: string;
  chatId: string;
  apiUrl: string;
  heartbeatUrl: string;
  heartbeatEvery: string;
  diskPercent: string;
  memoryPercent: string;
  cooldown: string;
}

export function draftFromNotifications(n: NotificationsConfig | undefined): NotificationsDraft {
  return {
    name: n?.name ?? "",
    events: n?.events ?? [],
    webhooks: (n?.webhooks ?? []).map((w) => ({ url: w.url, stored: w.url === HIDDEN, reenter: false, secretFile: w.secret_file ?? "" })),
    botTokenFile: n?.telegram?.bot_token_file ?? "",
    chatId: n?.telegram?.chat_id ?? "",
    apiUrl: n?.telegram?.api_url ?? "",
    heartbeatUrl: n?.heartbeat?.url ?? "",
    heartbeatEvery: n?.heartbeat?.every ?? "",
    diskPercent: n?.disk_alert_percent === undefined ? "" : String(n.disk_alert_percent),
    memoryPercent: n?.memory_alert_percent === undefined ? "" : String(n.memory_alert_percent),
    cooldown: n?.alert_cooldown ?? "",
  };
}

function hasTelegram(d: NotificationsDraft): boolean {
  return [d.botTokenFile, d.chatId, d.apiUrl].some((v) => v.trim() !== "");
}

function hasHeartbeat(d: NotificationsDraft): boolean {
  return d.heartbeatUrl !== "" || d.heartbeatEvery.trim() !== "";
}

/** The section to send: unused destinations and empty optional fields are left out. */
export function notificationsFromDraft(d: NotificationsDraft): NotificationsConfig {
  const out: NotificationsConfig = {};
  const name = optionalText(d.name);
  if (name) out.name = name;
  const known = KNOWN_EVENTS.map((e) => e.value).filter((e) => d.events.includes(e));
  const events = [...known, ...d.events.filter((e) => !known.includes(e))];
  if (events.length > 0) out.events = events;
  if (d.webhooks.length > 0) {
    out.webhooks = d.webhooks.map((w) => {
      const webhook: { url: string; secret_file?: string } = { url: w.url === HIDDEN ? HIDDEN : w.url.trim() };
      const secretFile = optionalText(w.secretFile);
      if (secretFile) webhook.secret_file = secretFile;
      return webhook;
    });
  }
  if (hasTelegram(d)) {
    out.telegram = { bot_token_file: d.botTokenFile.trim(), chat_id: d.chatId.trim() };
    const apiUrl = optionalText(d.apiUrl);
    if (apiUrl) out.telegram.api_url = apiUrl;
  }
  if (hasHeartbeat(d)) {
    out.heartbeat = { url: d.heartbeatUrl === HIDDEN ? HIDDEN : d.heartbeatUrl.trim() };
    const every = optionalText(d.heartbeatEvery);
    if (every) out.heartbeat.every = every;
  }
  const disk = toInteger(d.diskPercent);
  if (disk !== undefined) out.disk_alert_percent = disk;
  const memory = toInteger(d.memoryPercent);
  if (memory !== undefined) out.memory_alert_percent = memory;
  const cooldown = optionalText(d.cooldown);
  if (cooldown) out.alert_cooldown = cooldown;
  return out;
}

function urlProblem(url: string, stored: boolean): string | undefined {
  if (url === HIDDEN) return stored ? undefined : "Enter the URL.";
  const text = url.trim();
  if (text === "") return "Enter the URL.";
  try {
    const parsed = new URL(text);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? undefined : "The URL must start with http:// or https://.";
  } catch {
    return "That is not a valid URL. Include the scheme, for example https://example.com/hook.";
  }
}

function validateNotifications(d: NotificationsDraft, heartbeatStored: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  d.webhooks.forEach((w, i) => {
    const problem = urlProblem(w.url, w.stored);
    if (problem) errors[`webhooks.${i}.url`] = problem;
  });
  if (hasTelegram(d)) {
    if (d.botTokenFile.trim() === "") errors.bot_token_file = "Enter the path of the file that holds the bot token.";
    if (d.chatId.trim() === "") errors.chat_id = "Enter the chat id.";
  }
  if (hasHeartbeat(d)) {
    const problem = urlProblem(d.heartbeatUrl, heartbeatStored);
    if (problem) errors.heartbeat_url = problem;
    const every = durationError(d.heartbeatEvery);
    if (every) errors.heartbeat_every = every;
  }
  const disk = integerError(d.diskPercent, "The disk threshold", 6, 100);
  if (disk) errors.disk_alert_percent = disk;
  const memory = integerError(d.memoryPercent, "The memory threshold", 1, 95);
  if (memory) errors.memory_alert_percent = memory;
  const cooldown = durationError(d.cooldown);
  if (cooldown) errors.alert_cooldown = cooldown;
  return errors;
}

interface Problems {
  issues: ConfigIssue[];
  message?: string;
}

/** Edit the whole notifications section. Removing it entirely is the page's danger zone. */
export function NotificationsForm({
  serverId,
  baseHash,
  notifications,
}: {
  serverId: string;
  baseHash: string;
  /** The current section; absent when the server has none yet. */
  notifications?: NotificationsConfig;
}) {
  const router = useRouter();
  const save = useConfigSave();
  const base = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState<NotificationsDraft>(() => draftFromNotifications(notifications));
  const [problems, setProblems] = useState<Problems | null>(null);
  const heartbeatStored = notifications?.heartbeat?.url === HIDDEN;

  const errors = validateNotifications(draft, heartbeatStored);
  const server = problems ? fieldIssues(problems.issues, "notifications") : {};
  const fe = useFieldErrors(errors, server);
  const errorCount = Object.keys(errors).length;

  function set<K extends keyof NotificationsDraft>(key: K, value: NotificationsDraft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function setWebhook(index: number, patch: Partial<WebhookDraft>) {
    set(
      "webhooks",
      draft.webhooks.map((w, i) => (i === index ? { ...w, ...patch } : w)),
    );
  }

  /** The agent matches stored URLs by position, so what follows a removed webhook has to be entered again. */
  function removeWebhook(index: number) {
    set(
      "webhooks",
      draft.webhooks
        .filter((_, i) => i !== index)
        .map((w, i) => {
          if (i < index) return w;
          const lostUrl = w.url === HIDDEN;
          return { ...w, url: lostUrl ? "" : w.url, stored: false, reenter: w.reenter || lostUrl };
        }),
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    fe.touchAll();
    if (errorCount > 0) {
      focusFirstInvalid(formRef.current);
      return;
    }
    const config = notificationsFromDraft(draft);
    const { saved, result } = await save.run(
      "notifications",
      ({ force }) => saveNotificationsAction(serverId, config, { base_hash: baseHash, force }),
      liveNotice("Notifications"),
    );
    if (saved) {
      router.push(notificationsHref());
      return;
    }
    if (!result.ok && result.kind === "invalid") {
      setProblems({ issues: result.issues, message: result.message });
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  const id = (field: string) => `${base}-${field}`;
  const touch = (field: string) => () => fe.touch(field);
  const unknownEvents = draft.events.filter((e) => !KNOWN_EVENTS.some((k) => k.value === e));
  const eventOptions = [...KNOWN_EVENTS, ...unknownEvents.map((value) => ({ value, label: value }))];

  return (
    <form ref={formRef} onSubmit={onSubmit} noValidate className="max-w-3xl space-y-6">
      {problems && <SaveProblems issues={problems.issues} message={problems.message} />}
      {fe.submitted && errorCount > 0 && <FixFieldsNotice count={errorCount} />}

      <FormSection
        title="General"
        description="Webhook URLs and bot tokens are secrets. URLs are write-only here: once saved they show as Set and are never displayed again. Bot tokens are read from files on the server and never pass through the dashboard."
        flagged={sectionProblems(server, ["name", "events"]) !== undefined}
      >
        <TextField
          id={id("name")}
          label="Server display name"
          help="How this server is named in messages. Leave empty to use the agent's own name."
          error={fe.error("name")}
          value={draft.name}
          onChange={(v) => set("name", v)}
          placeholder="production"
        />
        <FieldShell
          id={id("events")}
          label="Events"
          group
          help="Leave every box unchecked to use the agent's default events."
          error={fe.error("events")}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {eventOptions.map((event) => (
              <CheckboxField
                key={event.value}
                id={id(`event-${event.value}`)}
                label={event.label}
                help={<span className="font-mono">{event.value}</span>}
                checked={draft.events.includes(event.value)}
                onChange={(checked) =>
                  set("events", checked ? [...draft.events, event.value] : draft.events.filter((e) => e !== event.value))
                }
              />
            ))}
          </div>
        </FieldShell>
      </FormSection>

      <FormSection
        title="Webhooks"
        description="Each event is posted as JSON to every webhook."
        problems={sectionProblems(server, ["webhooks"])}
      >
        {draft.webhooks.length === 0 && <p className="text-sm text-muted-foreground">No webhooks.</p>}
        {draft.webhooks.map((webhook, i) => (
          <fieldset key={i} className="space-y-4 rounded-lg border p-4">
            <legend className="sr-only">Webhook {i + 1}</legend>
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium" aria-hidden>
                Webhook {i + 1}
              </p>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove webhook ${i + 1}`} onClick={() => removeWebhook(i)}>
                <ICONS.remove />
              </Button>
            </div>
            <FieldShell
              id={id(`webhook-${i}-url`)}
              label="URL"
              required
              help={
                webhook.reenter
                  ? "Webhooks are matched by position and a webhook before this one was removed, so enter this URL again."
                  : "Treated as a secret: it is never displayed again after saving."
              }
              error={fe.error(`webhooks.${i}.url`)}
            >
              <SecretValueInput
                id={id(`webhook-${i}-url`)}
                label={`URL of webhook ${i + 1}`}
                value={webhook.url}
                onChange={(url) => setWebhook(i, { url })}
                onBlur={touch(`webhooks.${i}.url`)}
                stored={webhook.stored}
                invalid={Boolean(fe.error(`webhooks.${i}.url`))}
                describedBy={`${id(`webhook-${i}-url`)}-help${fe.error(`webhooks.${i}.url`) ? ` ${id(`webhook-${i}-url`)}-error` : ""}`}
                placeholder="https://hooks.example.com/…"
              />
            </FieldShell>
            <TextField
              id={id(`webhook-${i}-secret`)}
              label="Signing secret file"
              help="Optional: path of a file on the server that holds the secret used to sign each request."
              value={webhook.secretFile}
              onChange={(secretFile) => setWebhook(i, { secretFile })}
              placeholder="/etc/acme/webhook.secret"
              mono
            />
          </fieldset>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => set("webhooks", [...draft.webhooks, { url: "", stored: false, reenter: false, secretFile: "" }])}
        >
          <ICONS.add />
          Add webhook
        </Button>
      </FormSection>

      <FormSection
        title="Telegram"
        description="Send events to a Telegram chat. Leave every field empty to turn it off."
        problems={sectionProblems(server, ["telegram"])}
      >
        <TextField
          id={id("bot_token_file")}
          label="Bot token file"
          help="Path of a file on the server that holds the bot token. The token itself is never entered here."
          error={fe.error("bot_token_file")}
          value={draft.botTokenFile}
          onChange={(v) => set("botTokenFile", v)}
          onBlur={touch("bot_token_file")}
          placeholder="/etc/acme/telegram.token"
          mono
        />
        <div className="grid gap-5 sm:grid-cols-2">
          <TextField
            id={id("chat_id")}
            label="Chat id"
            error={fe.error("chat_id")}
            value={draft.chatId}
            onChange={(v) => set("chatId", v)}
            onBlur={touch("chat_id")}
            placeholder="-1001234567890"
            mono
          />
          <TextField
            id={id("api_url")}
            label="API URL"
            help="Optional: leave empty for the public Telegram API."
            value={draft.apiUrl}
            onChange={(v) => set("apiUrl", v)}
            placeholder="https://api.telegram.org"
            mono
          />
        </div>
      </FormSection>

      <FormSection
        title="Thresholds"
        description="When the disk and memory events (listed above) fire, and how long a flapping app waits between alerts. All optional."
        problems={sectionProblems(server, ["disk_alert_percent", "memory_alert_percent", "alert_cooldown"])}
      >
        <div className="grid gap-5 sm:grid-cols-3">
          <TextField
            id={id("disk_alert_percent")}
            label="Disk full at (%)"
            help="disk.high fires when a filesystem the agent uses is this full, and ends 5 points below. Default 85."
            error={fe.error("disk_alert_percent")}
            value={draft.diskPercent}
            onChange={(v) => set("diskPercent", v)}
            onBlur={touch("disk_alert_percent")}
            inputMode="numeric"
            placeholder="85"
            mono
          />
          <TextField
            id={id("memory_alert_percent")}
            label="Memory low under (%)"
            help="memory.low fires when less than this share of memory is available. Default 10."
            error={fe.error("memory_alert_percent")}
            value={draft.memoryPercent}
            onChange={(v) => set("memoryPercent", v)}
            onBlur={touch("memory_alert_percent")}
            inputMode="numeric"
            placeholder="10"
            mono
          />
          <DurationField
            id={id("alert_cooldown")}
            label="App alert cooldown"
            help={`An app that went down and came back waits this long before it can alert again. Default 5m, 0s turns it off. ${DURATION_HINT}`}
            error={fe.error("alert_cooldown")}
            value={draft.cooldown}
            onChange={(v) => set("cooldown", v)}
            onBlur={touch("alert_cooldown")}
            placeholder="5m"
          />
        </div>
      </FormSection>

      <FormSection
        title="Heartbeat"
        description="Ping a URL at a regular interval so an outside service notices when this server goes silent. Leave empty to turn it off."
        problems={sectionProblems(server, ["heartbeat"])}
      >
        <FieldShell
          id={id("heartbeat_url")}
          label="URL"
          help="Treated as a secret: it is never displayed again after saving."
          error={fe.error("heartbeat_url")}
        >
          <SecretValueInput
            id={id("heartbeat_url")}
            label="heartbeat URL"
            value={draft.heartbeatUrl}
            onChange={(v) => set("heartbeatUrl", v)}
            onBlur={touch("heartbeat_url")}
            stored={heartbeatStored}
            invalid={Boolean(fe.error("heartbeat_url"))}
            describedBy={`${id("heartbeat_url")}-help${fe.error("heartbeat_url") ? ` ${id("heartbeat_url")}-error` : ""}`}
            placeholder="https://uptime.example.com/ping/…"
          />
        </FieldShell>
        <DurationField
          id={id("heartbeat_every")}
          label="Every"
          help={`Optional: how often to ping. ${DURATION_HINT}`}
          error={fe.error("heartbeat_every")}
          value={draft.heartbeatEvery}
          onChange={(v) => set("heartbeatEvery", v)}
          onBlur={touch("heartbeat_every")}
          placeholder="5m"
        />
      </FormSection>

      <FormFooter pending={save.pending} saveLabel="Save notifications" cancelHref={`/servers/${serverId}`} />
      {save.dialogs}
    </form>
  );
}
