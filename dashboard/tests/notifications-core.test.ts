import { describe, expect, it } from "vitest";
import { HIDDEN, type NotificationsConfig } from "@/lib/agent-types";
import {
  channelLabel,
  channelsOf,
  DEFAULT_EVENTS,
  differences,
  draftOfTemplate,
  durationSeconds,
  eventsSummary,
  mergeTemplate,
  NEW_URL_TEXT,
  parseTemplate,
  sectionText,
  templateOfDraft,
  webhookUrlProblem,
  wouldChange,
  TEMPLATE_EVENTS_HELP,
  type NotificationsTemplate,
} from "@/lib/notifications-core";

/** A template that is the agent's own defaults: nothing is expected beyond them. */
const PLAIN: NotificationsTemplate = { events: [], diskPercent: 85, memoryPercent: 10, cooldown: "5m", telegram: null, webhooks: [] };
const withTemplate = (over: Partial<NotificationsTemplate>): NotificationsTemplate => ({ ...PLAIN, ...over });

/** A request body as the editor sends it, with something overridden. */
const raw = (over: Record<string, unknown> = {}) => ({ events: [], diskPercent: 85, memoryPercent: 10, cooldown: "5m", telegram: null, webhooks: [], ...over });

describe("durationSeconds", () => {
  it("reads a Go duration in seconds", () => {
    expect(durationSeconds("90s")).toBe(90);
    expect(durationSeconds("5m")).toBe(300);
    expect(durationSeconds("300s")).toBe(300);
    expect(durationSeconds("1h30m")).toBe(5400);
    expect(durationSeconds("1.5m")).toBe(90);
    expect(durationSeconds("250ms")).toBeCloseTo(0.25);
    expect(durationSeconds("  5m ")).toBe(300);
  });

  it("is null for what is not one", () => {
    for (const bad of ["", "5", "m", "5 m", "-5m", "5d", "1h 30m", "five minutes", "5m."]) expect(durationSeconds(bad), bad).toBeNull();
  });
});

describe("parseTemplate", () => {
  it("normalises a valid template: whole numbers from text, trimmed, events in the order the forms list them without duplicates", () => {
    const parsed = parseTemplate(
      raw({
        events: ["app.down", "deployment.failed", "app.down"],
        diskPercent: "90",
        memoryPercent: 15,
        cooldown: " 10m ",
        telegram: { botTokenFile: " /etc/keelson/bot ", chatId: " -100 " },
        webhooks: [{ secretFile: " /etc/keelson/hook " }, {}],
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      template: {
        events: ["deployment.failed", "app.down"],
        diskPercent: 90,
        memoryPercent: 15,
        cooldown: "10m",
        telegram: { botTokenFile: "/etc/keelson/bot", chatId: "-100", apiUrl: "" },
        webhooks: [{ secretFile: "/etc/keelson/hook" }, { secretFile: "" }],
      },
    });
  });

  it("accepts the bounds and refuses what is one past them, with the agent's numbers", () => {
    for (const disk of [6, 100]) expect(parseTemplate(raw({ diskPercent: disk })).ok).toBe(true);
    for (const memory of [1, 95]) expect(parseTemplate(raw({ memoryPercent: memory })).ok).toBe(true);
    expect(parseTemplate(raw({ diskPercent: 5 }))).toEqual({ ok: false, errors: { diskPercent: "The disk threshold must be between 6 and 100." } });
    expect(parseTemplate(raw({ diskPercent: 101 }))).toEqual({ ok: false, errors: { diskPercent: "The disk threshold must be between 6 and 100." } });
    expect(parseTemplate(raw({ memoryPercent: 0 }))).toEqual({ ok: false, errors: { memoryPercent: "The memory threshold must be between 1 and 95." } });
    expect(parseTemplate(raw({ memoryPercent: "96" }))).toEqual({ ok: false, errors: { memoryPercent: "The memory threshold must be between 1 and 95." } });
  });

  it("wants whole numbers", () => {
    for (const bad of ["abc", "", "85.5", 85.5, null, undefined, {}, "-1"]) {
      expect(parseTemplate(raw({ diskPercent: bad })), String(bad)).toEqual({ ok: false, errors: { diskPercent: "The disk threshold must be a whole number." } });
    }
  });

  it("checks the cooldown is a duration", () => {
    const errors = { cooldown: "Not a duration. A number and a unit, for example 90s, 5m or 1h30m." };
    for (const bad of ["", "5", "soon", 300, null, "5m".repeat(300)]) expect(parseTemplate(raw({ cooldown: bad })), String(bad).slice(0, 8)).toEqual({ ok: false, errors });
    expect(parseTemplate(raw({ cooldown: "1h30m" })).ok).toBe(true);
  });

  it("refuses an event the agent does not send, and events that are not a list", () => {
    expect(parseTemplate(raw({ events: ["app.down", "app.exploded"] }))).toEqual({ ok: false, errors: { events: "One of the events is not one the agent sends." } });
    for (const bad of ["app.down", [1], null, undefined]) expect(parseTemplate(raw({ events: bad })), String(bad)).toEqual({ ok: false, errors: { events: "The events must be a list." } });
  });

  it("needs both the token file and the chat id for Telegram, and an http(s) API url when one is given", () => {
    expect(parseTemplate(raw({ telegram: { botTokenFile: "/t" } }))).toEqual({ ok: false, errors: { chatId: "Enter the chat id." } });
    expect(parseTemplate(raw({ telegram: { chatId: "1" } }))).toEqual({ ok: false, errors: { botTokenFile: "Enter the path of the file that holds the bot token." } });
    expect(parseTemplate(raw({ telegram: { botTokenFile: "  ", chatId: "" } }))).toEqual({
      ok: false,
      errors: { botTokenFile: "Enter the path of the file that holds the bot token.", chatId: "Enter the chat id." },
    });
    expect(parseTemplate(raw({ telegram: "yes" }))).toMatchObject({ ok: false, errors: { botTokenFile: expect.any(String), chatId: expect.any(String) } });
    expect(parseTemplate(raw({ telegram: { botTokenFile: "/t", chatId: "1", apiUrl: "ftp://t.example" } }))).toEqual({ ok: false, errors: { apiUrl: "The URL must start with http:// or https://." } });
    expect(parseTemplate(raw({ telegram: { botTokenFile: "/t", chatId: "1", apiUrl: 5 } }))).toEqual({ ok: false, errors: { apiUrl: "That is not a valid URL." } });
    expect(parseTemplate(raw({ telegram: { botTokenFile: "/t", chatId: "1", apiUrl: "https://t.example" } }))).toMatchObject({
      ok: true,
      template: { telegram: { botTokenFile: "/t", chatId: "1", apiUrl: "https://t.example" } },
    });
  });

  it("allows up to five webhook slots, each a path", () => {
    expect(parseTemplate(raw({ webhooks: Array.from({ length: 5 }, (_, i) => ({ secretFile: `/s${i}` })) })).ok).toBe(true);
    expect(parseTemplate(raw({ webhooks: Array.from({ length: 6 }, () => ({ secretFile: "" })) }))).toEqual({ ok: false, errors: { webhooks: "At most 5 webhooks." } });
    expect(parseTemplate(raw({ webhooks: "none" }))).toEqual({ ok: false, errors: { webhooks: "The webhooks must be a list." } });
    expect(parseTemplate(raw({ webhooks: [{ secretFile: "/ok" }, 5, { secretFile: 7 }] }))).toEqual({
      ok: false,
      errors: { "webhook.1": "That is not a valid path.", "webhook.2": "That is not a valid path." },
    });
  });

  it("trusts no shape: anything that is not an object has an error for every required field", () => {
    const all = {
      events: "The events must be a list.",
      diskPercent: "The disk threshold must be a whole number.",
      memoryPercent: "The memory threshold must be a whole number.",
      cooldown: "Not a duration. A number and a unit, for example 90s, 5m or 1h30m.",
      webhooks: "The webhooks must be a list.",
    };
    for (const bad of [null, undefined, "x", 5, [], true]) expect(parseTemplate(bad), String(bad)).toEqual({ ok: false, errors: all });
  });

  it("drops what it was not asked about", () => {
    const parsed = parseTemplate({ ...raw(), webhooks: [{ secretFile: "/s", url: "https://secret.example/x" }], extra: "x" });
    expect(parsed).toEqual({ ok: true, template: { ...PLAIN, webhooks: [{ secretFile: "/s" }] } });
    expect(JSON.stringify(parsed)).not.toContain("secret.example");
  });
});

describe("the editor's draft", () => {
  it("starts from the agent's defaults when there is no template", () => {
    expect(draftOfTemplate(null)).toEqual({
      events: DEFAULT_EVENTS,
      diskPercent: "85",
      memoryPercent: "10",
      cooldown: "5m",
      telegram: false,
      botTokenFile: "",
      chatId: "",
      apiUrl: "",
      webhookSecretFiles: [],
    });
    expect(templateOfDraft(draftOfTemplate(null))).toEqual({ ok: true, template: { ...PLAIN, events: DEFAULT_EVENTS } });
  });

  it("says what it starts with: the default events are ticked, unticking all keeps each server's own", () => {
    expect(draftOfTemplate(null).events).toEqual(DEFAULT_EVENTS);
    expect(TEMPLATE_EVENTS_HELP).toMatch(/^Ticked: /);
    expect(TEMPLATE_EVENTS_HELP).not.toMatch(/leave every box unchecked/i);
  });

  it("round-trips a template", () => {
    const t = withTemplate({
      events: ["deployment.failed", "disk.high"],
      diskPercent: 70,
      memoryPercent: 20,
      cooldown: "1h",
      telegram: { botTokenFile: "/t", chatId: "-5", apiUrl: "https://t.example" },
      webhooks: [{ secretFile: "/a" }, { secretFile: "" }],
    });
    expect(templateOfDraft(draftOfTemplate(t))).toEqual({ ok: true, template: t });
  });

  it("ignores the Telegram fields while Telegram is off, and reports them when it is on", () => {
    const draft = { ...draftOfTemplate(null), botTokenFile: "/t", chatId: "1" };
    expect(templateOfDraft(draft)).toMatchObject({ ok: true, template: { telegram: null } });
    expect(templateOfDraft({ ...draft, telegram: true, chatId: "" })).toEqual({ ok: false, errors: { chatId: "Enter the chat id." } });
  });

  it("reports the typed text that is not a number", () => {
    expect(templateOfDraft({ ...draftOfTemplate(null), diskPercent: "lots", memoryPercent: "99" })).toEqual({
      ok: false,
      errors: { diskPercent: "The disk threshold must be a whole number.", memoryPercent: "The memory threshold must be between 1 and 95." },
    });
  });
});

describe("channels and events in words", () => {
  it("reads which channels a section has", () => {
    expect(channelsOf(undefined)).toEqual({ telegram: false, webhooks: 0, heartbeat: false });
    expect(channelsOf({ webhooks: [{ url: HIDDEN }, { url: HIDDEN }], telegram: { bot_token_file: "/t", chat_id: "1" }, heartbeat: { url: HIDDEN } })).toEqual({ telegram: true, webhooks: 2, heartbeat: true });
  });

  it("labels them", () => {
    expect(channelLabel({ telegram: false, webhooks: 0, heartbeat: false })).toBe("None");
    expect(channelLabel({ telegram: false, webhooks: 0, heartbeat: true })).toBe("None");
    expect(channelLabel({ telegram: true, webhooks: 0, heartbeat: false })).toBe("Telegram");
    expect(channelLabel({ telegram: false, webhooks: 1, heartbeat: false })).toBe("Webhook");
    expect(channelLabel({ telegram: false, webhooks: 2, heartbeat: false })).toBe("2 webhooks");
    expect(channelLabel({ telegram: true, webhooks: 1, heartbeat: true })).toBe("Telegram + Webhook");
    expect(channelLabel({ telegram: true, webhooks: 3, heartbeat: false })).toBe("Telegram + 3 webhooks");
  });

  it("summarises the events: the agent's default when the file has none, otherwise a count", () => {
    expect(eventsSummary(undefined)).toEqual({ text: "Default (7)", list: [...DEFAULT_EVENTS].sort() });
    expect(eventsSummary({ disk_alert_percent: 90 })).toEqual({ text: "Default (7)", list: [...DEFAULT_EVENTS].sort() });
    expect(eventsSummary({ events: [] })).toEqual({ text: "None", list: [] });
    expect(eventsSummary({ events: ["job.failed"] })).toEqual({ text: "1 event", list: ["job.failed"] });
    expect(eventsSummary({ events: ["job.failed", "app.down", "app.down"] })).toEqual({ text: "2 events", list: ["app.down", "job.failed"] });
  });
});

describe("differences", () => {
  it("is empty for a server on the agent's defaults when the template is the defaults, however the defaults are written", () => {
    expect(differences(PLAIN, undefined)).toEqual([]);
    expect(differences(PLAIN, {})).toEqual([]);
    expect(differences(PLAIN, { disk_alert_percent: 85, memory_alert_percent: 10, alert_cooldown: "300s", events: [...DEFAULT_EVENTS].reverse() })).toEqual([]);
    expect(differences(PLAIN, { alert_cooldown: "4m60s" })).toEqual([]);
  });

  it("resolves a missing value to the agent's default before comparing", () => {
    expect(differences(withTemplate({ diskPercent: 90 }), undefined)).toEqual(["disk"]);
    expect(differences(withTemplate({ diskPercent: 90 }), { disk_alert_percent: 90 })).toEqual([]);
    expect(differences(PLAIN, { disk_alert_percent: 90, memory_alert_percent: 20 })).toEqual(["disk", "memory"]);
    expect(differences(withTemplate({ cooldown: "1h" }), { alert_cooldown: "60m" })).toEqual([]);
    expect(differences(withTemplate({ cooldown: "1h" }), undefined)).toEqual(["cooldown"]);
  });

  it("compares events as sets of what is sent: a template with none means the default list", () => {
    expect(differences(withTemplate({ events: ["app.down"] }), undefined)).toEqual(["events"]);
    expect(differences(withTemplate({ events: ["app.down"] }), { events: ["app.down"] })).toEqual([]);
    expect(differences(withTemplate({ events: ["app.down", "job.failed"] }), { events: ["job.failed", "app.down"] })).toEqual([]);
    expect(differences(PLAIN, { events: [] })).toEqual(["events"]);
    expect(differences(PLAIN, { events: ["app.down"] })).toEqual(["events"]);
    expect(differences(withTemplate({ events: [...DEFAULT_EVENTS] }), undefined)).toEqual([]);
  });

  it("wants the Telegram chat the template expects, and leaves one it does not", () => {
    const t = withTemplate({ telegram: { botTokenFile: "/t", chatId: "1", apiUrl: "" } });
    expect(differences(t, undefined)).toEqual(["telegram"]);
    expect(differences(t, { telegram: { bot_token_file: "/t", chat_id: "1" } })).toEqual([]);
    expect(differences(t, { telegram: { bot_token_file: "/t", chat_id: "2" } })).toEqual(["telegram"]);
    expect(differences(t, { telegram: { bot_token_file: "/other", chat_id: "1" } })).toEqual(["telegram"]);
    expect(differences(t, { telegram: { bot_token_file: "/t", chat_id: "1", api_url: "https://t.example" } })).toEqual(["telegram"]);
    expect(differences(withTemplate({ telegram: { botTokenFile: "/t", chatId: "1", apiUrl: "https://t.example" } }), { telegram: { bot_token_file: "/t", chat_id: "1", api_url: "https://t.example" } })).toEqual([]);
    expect(differences(PLAIN, { telegram: { bot_token_file: "/x", chat_id: "9" } })).toEqual([]);
  });

  it("wants a webhook at each slot with its secret file (the URL cannot be compared), and leaves the others", () => {
    const t = withTemplate({ webhooks: [{ secretFile: "/a" }, { secretFile: "/b" }] });
    expect(differences(t, undefined)).toEqual(["webhooks"]);
    expect(differences(t, { webhooks: [{ url: HIDDEN, secret_file: "/a" }] })).toEqual(["webhooks"]);
    expect(differences(t, { webhooks: [{ url: HIDDEN, secret_file: "/a" }, { url: HIDDEN, secret_file: "/b" }] })).toEqual([]);
    expect(differences(t, { webhooks: [{ url: HIDDEN, secret_file: "/a" }, { url: HIDDEN, secret_file: "/c" }] })).toEqual(["webhooks"]);
    expect(differences(t, { webhooks: [{ url: HIDDEN, secret_file: "/b" }, { url: HIDDEN, secret_file: "/a" }] })).toEqual(["webhooks"]);
    expect(differences(t, { webhooks: [{ url: HIDDEN, secret_file: "/a" }, { url: HIDDEN }] })).toEqual(["webhooks"]);
    expect(differences(t, { webhooks: [{ url: HIDDEN, secret_file: "/a" }, { url: HIDDEN, secret_file: "/b" }, { url: HIDDEN, secret_file: "/extra" }] })).toEqual([]);
    expect(differences(withTemplate({ webhooks: [{ secretFile: "" }] }), { webhooks: [{ url: HIDDEN }] })).toEqual([]);
    expect(differences(PLAIN, { webhooks: [{ url: HIDDEN, secret_file: "/whatever" }] })).toEqual([]);
  });

  it("lists every difference, in the order of the table", () => {
    const t = withTemplate({
      events: ["app.down"],
      diskPercent: 90,
      memoryPercent: 20,
      cooldown: "1h",
      telegram: { botTokenFile: "/t", chatId: "1", apiUrl: "" },
      webhooks: [{ secretFile: "/a" }],
    });
    expect(differences(t, undefined)).toEqual(["events", "disk", "memory", "cooldown", "telegram", "webhooks"]);
  });
});

describe("mergeTemplate", () => {
  const current: NotificationsConfig = {
    name: "web 1",
    events: ["app.down"],
    webhooks: [{ url: HIDDEN, secret_file: "/old" }, { url: HIDDEN }, { url: HIDDEN, secret_file: "/third" }],
    telegram: { bot_token_file: "/tg", chat_id: "7" },
    heartbeat: { url: HIDDEN, every: "1m" },
    disk_alert_percent: 50,
    memory_alert_percent: 50,
    alert_cooldown: "1m",
  };

  it("takes the template's events, thresholds and cooldown, and keeps the name, heartbeat, Telegram and the hidden URLs of a server", () => {
    const t = withTemplate({ events: ["job.failed", "app.down"], diskPercent: 90, memoryPercent: 20, cooldown: "10m", webhooks: [{ secretFile: "/s1" }] });
    const before = JSON.stringify(current);
    expect(mergeTemplate(current, t, [""])).toEqual({
      ok: true,
      config: {
        name: "web 1",
        events: ["job.failed", "app.down"],
        webhooks: [{ url: HIDDEN, secret_file: "/s1" }, { url: HIDDEN }, { url: HIDDEN, secret_file: "/third" }],
        telegram: { bot_token_file: "/tg", chat_id: "7" },
        heartbeat: { url: HIDDEN, every: "1m" },
        disk_alert_percent: 90,
        memory_alert_percent: 20,
        alert_cooldown: "10m",
      },
    });
    expect(JSON.stringify(current)).toBe(before);
  });

  it("sends the typed URL for a slot (trimmed) and only for that slot", () => {
    const t = withTemplate({ webhooks: [{ secretFile: "/s1" }, { secretFile: "" }] });
    const merged = mergeTemplate(current, t, ["  https://hooks.example/typed  ", ""]);
    expect(merged).toMatchObject({
      ok: true,
      config: { webhooks: [{ url: "https://hooks.example/typed", secret_file: "/s1" }, { url: HIDDEN }, { url: HIDDEN, secret_file: "/third" }] },
    });
    // A slot whose template has no secret file drops the server's secret file: the slot is what the template says.
    const dropped = mergeTemplate(current, withTemplate({ webhooks: [{ secretFile: "" }] }), ["https://hooks.example/typed"]);
    expect(dropped.ok && dropped.config.webhooks).toEqual([{ url: "https://hooks.example/typed" }, { url: HIDDEN }, { url: HIDDEN, secret_file: "/third" }]);
  });

  it("says which slot needs a URL when the server has none stored and none was typed", () => {
    const t = withTemplate({ webhooks: [{ secretFile: "/a" }, { secretFile: "/b" }] });
    expect(mergeTemplate(undefined, t, ["", ""])).toEqual({ ok: false, needsUrl: 1 });
    expect(mergeTemplate(undefined, t, ["https://a.example", ""])).toEqual({ ok: false, needsUrl: 2 });
    expect(mergeTemplate({ webhooks: [{ url: HIDDEN }] }, t, ["", ""])).toEqual({ ok: false, needsUrl: 2 });
    expect(mergeTemplate(undefined, t, ["https://a.example", "https://b.example"])).toEqual({
      ok: true,
      config: {
        webhooks: [
          { url: "https://a.example", secret_file: "/a" },
          { url: "https://b.example", secret_file: "/b" },
        ],
        disk_alert_percent: 85,
        memory_alert_percent: 10,
        alert_cooldown: "5m",
      },
    });
  });

  it("writes the template's Telegram chat, with the API url only when it has one", () => {
    expect(mergeTemplate(current, withTemplate({ telegram: { botTokenFile: "/t2", chatId: "9", apiUrl: "" } }), [])).toMatchObject({
      config: { telegram: { bot_token_file: "/t2", chat_id: "9" } },
    });
    const withApi = mergeTemplate(undefined, withTemplate({ telegram: { botTokenFile: "/t2", chatId: "9", apiUrl: "https://t.example" } }), []);
    expect(withApi).toMatchObject({ config: { telegram: { bot_token_file: "/t2", chat_id: "9", api_url: "https://t.example" } } });
    const plain = mergeTemplate(undefined, withTemplate({ telegram: { botTokenFile: "/t2", chatId: "9", apiUrl: "" } }), []);
    expect(plain.ok && plain.config.telegram).toEqual({ bot_token_file: "/t2", chat_id: "9" });
  });

  it("leaves out what neither side has: no events for a template with none, no webhooks, no name", () => {
    const merged = mergeTemplate({ events: ["app.down"] }, PLAIN, []);
    expect(merged).toEqual({ ok: true, config: { disk_alert_percent: 85, memory_alert_percent: 10, alert_cooldown: "5m" } });
    expect(merged.ok && "events" in merged.config).toBe(false);
  });

  it("keeps the webhooks of a server when the template has no slots", () => {
    expect(mergeTemplate({ webhooks: [{ url: HIDDEN, secret_file: "/x" }] }, PLAIN, [])).toMatchObject({ config: { webhooks: [{ url: HIDDEN, secret_file: "/x" }] } });
  });
});

describe("wouldChange", () => {
  const t = withTemplate({ diskPercent: 90, webhooks: [{ secretFile: "/a" }] });
  const following: NotificationsConfig = { disk_alert_percent: 90, webhooks: [{ url: HIDDEN, secret_file: "/a" }] };

  it("is false for a server that follows the template when no URL is typed", () => {
    expect(wouldChange(t, following, [""])).toBe(false);
    expect(wouldChange(t, following, ["   "])).toBe(false);
    expect(wouldChange(t, following, [])).toBe(false);
  });

  it("is true when something differs, or when a URL is typed for a slot", () => {
    expect(wouldChange(t, { ...following, disk_alert_percent: 80 }, [""])).toBe(true);
    expect(wouldChange(t, following, ["https://hooks.example/new"])).toBe(true);
    expect(wouldChange(PLAIN, undefined, [])).toBe(false);
  });
});

describe("sectionText", () => {
  it("is empty for no section", () => {
    expect(sectionText(undefined)).toBe("");
    expect(sectionText({})).toBe("\n");
  });

  it("writes the whole section as the agent would show it", () => {
    const n: NotificationsConfig = {
      name: "web 1",
      events: ["app.down"],
      webhooks: [{ url: HIDDEN, secret_file: "/etc/s" }, { url: NEW_URL_TEXT }],
      telegram: { bot_token_file: "/t", chat_id: "-1", api_url: "https://t.example" },
      heartbeat: { url: HIDDEN, every: "1m" },
      disk_alert_percent: 90,
      memory_alert_percent: 5,
      alert_cooldown: "10m",
    };
    expect(sectionText(n)).toBe(
      [
        'name: "web 1"',
        "events:",
        "  - app.down",
        "webhooks:",
        "  - url: <hidden>",
        '    secret_file: "/etc/s"',
        "  - url: <new URL, write-only>",
        "telegram:",
        '  bot_token_file: "/t"',
        '  chat_id: "-1"',
        '  api_url: "https://t.example"',
        "heartbeat:",
        "  url: <hidden>",
        '  every: "1m"',
        "disk_alert_percent: 90",
        "memory_alert_percent: 5",
        'alert_cooldown: "10m"',
        "",
      ].join("\n"),
    );
    expect(sectionText({ events: [] })).toBe("events: []\n");
  });

  it("never prints a URL: a real one (a typed webhook, a heartbeat) is shown as <hidden>", () => {
    const text = sectionText({
      webhooks: [{ url: "https://hooks.example/T0K3N" }, { url: HIDDEN }],
      heartbeat: { url: "https://beat.example/PING" },
    });
    expect(text).toBe("webhooks:\n  - url: <hidden>\n  - url: <hidden>\nheartbeat:\n  url: <hidden>\n");
    expect(text).not.toMatch(/example|T0K3N|PING/);
  });
});

describe("webhookUrlProblem", () => {
  it("accepts an empty URL (keep what each server has) and an http(s) one", () => {
    for (const ok of ["", "   ", "https://example.com/hook", "http://10.0.0.2:8080/x?y=1"]) expect(webhookUrlProblem(ok), ok).toBeUndefined();
  });

  it("says why not", () => {
    expect(webhookUrlProblem("ftp://example.com/x")).toBe("The URL must start with http:// or https://.");
    expect(webhookUrlProblem("javascript:alert(1)")).toBe("The URL must start with http:// or https://.");
    expect(webhookUrlProblem("example.com/hook")).toBe("That is not a valid URL. Include the scheme, for example https://example.com/hook.");
    expect(webhookUrlProblem(`https://example.com/${"a".repeat(2000)}`)).toBe("That URL is too long.");
  });
});
