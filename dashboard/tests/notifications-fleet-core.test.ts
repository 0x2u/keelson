import { describe, expect, it } from "vitest";
import { HIDDEN, type NotificationsConfig } from "@/lib/agent-types";
import { DEFAULT_EVENTS, NEW_URL_TEXT, type NotificationsTemplate } from "@/lib/notifications-core";
import {
  countsByFilter,
  differingIds,
  FILTERS,
  notificationsRow,
  paginate,
  planApply,
  planCounts,
  READ_ONLY_REASONS,
  selectableIds,
  testFact,
  visibleRows,
  type ConfigFact,
  type Filter,
  type NotificationsRow,
  type ServerFacts,
} from "@/lib/notifications-fleet-core";

const PLAIN: NotificationsTemplate = { events: [], diskPercent: 85, memoryPercent: 10, cooldown: "5m", telegram: null, webhooks: [] };
const DISK_90: NotificationsTemplate = { ...PLAIN, diskPercent: 90 };

const facts = (name: string, config: ConfigFact, over: Partial<ServerFacts> = {}): ServerFacts => ({ id: `id-${name}`, name, canDeploy: true, config, test: { kind: "never" }, ...over });
const ok = (notifications?: NotificationsConfig, hash = "h1"): ConfigFact => ({ kind: "ok", hash, ...(notifications ? { notifications } : {}) });
const TELEGRAM: NotificationsConfig = { telegram: { bot_token_file: "/t", chat_id: "1" } };
const row = (name: string, config: ConfigFact, template: NotificationsTemplate | null = DISK_90, over: Partial<ServerFacts> = {}) => notificationsRow(facts(name, config, over), template);
const names = (rows: NotificationsRow[]) => rows.map((r) => r.name);

describe("notificationsRow", () => {
  it("describes a server that was read and can be changed", () => {
    const n: NotificationsConfig = { events: ["app.down"], webhooks: [{ url: HIDDEN }], telegram: { bot_token_file: "/t", chat_id: "1" }, heartbeat: { url: HIDDEN }, disk_alert_percent: 90, memory_alert_percent: 5 };
    expect(row("a", ok(n, "abc"), DISK_90, { test: { kind: "at", at: "2026-11-01T00:00:00Z" } })).toEqual({
      id: "id-a",
      name: "a",
      state: "ok",
      hash: "abc",
      notifications: n,
      read: true,
      channels: { telegram: true, webhooks: 1, heartbeat: true },
      events: { text: "1 event", list: ["app.down"] },
      disk: 90,
      memory: 5,
      differs: ["events", "memory"],
      test: { kind: "at", at: "2026-11-01T00:00:00Z" },
    });
  });

  it("has no thresholds and no section for a file without notifications, and no differences without a default", () => {
    const r = row("a", ok(), null);
    expect(r).toEqual({
      id: "id-a",
      name: "a",
      state: "ok",
      hash: "h1",
      read: true,
      channels: { telegram: false, webhooks: 0, heartbeat: false },
      events: { text: `Default (${DEFAULT_EVENTS.length})`, list: expect.any(Array) },
      differs: [],
      test: { kind: "never" },
    });
    expect("notifications" in r || "disk" in r || "memory" in r || "reason" in r).toBe(false);
    expect(row("a", ok(), DISK_90).differs).toEqual(["disk"]);
  });

  it("is read-only, though read, when the dashboard cannot sign", () => {
    expect(row("a", ok(TELEGRAM), DISK_90, { canDeploy: false })).toMatchObject({
      state: "read-only",
      reason: READ_ONLY_REASONS.noSecret,
      hash: "h1",
      read: true,
      channels: { telegram: true, webhooks: 0, heartbeat: false },
      differs: ["disk"],
    });
  });

  it("is read-only and unread for an agent without an apps file, or with an invalid one (whether or not the dashboard can sign)", () => {
    expect(row("a", { kind: "no-file" })).toEqual({ id: "id-a", name: "a", state: "read-only", reason: READ_ONLY_REASONS.noFile, read: false, differs: [], test: { kind: "never" } });
    expect(row("a", { kind: "invalid" }, DISK_90, { canDeploy: false })).toEqual({ id: "id-a", name: "a", state: "read-only", reason: READ_ONLY_REASONS.invalid, read: false, differs: [], test: { kind: "never" } });
  });

  it("is unreachable, with the reason, for an agent that did not answer; never a row of blanks that looks like nothing set up", () => {
    const r = row("a", { kind: "failed", reason: "cannot reach the agent: connection refused" }, DISK_90, { canDeploy: false });
    expect(r).toEqual({ id: "id-a", name: "a", state: "unreachable", reason: "cannot reach the agent: connection refused", read: false, differs: [], test: { kind: "never" } });
    expect("channels" in r).toBe(false);
  });
});

describe("filters, search and order", () => {
  // One row of each kind, under a default that wants a 90% disk threshold.
  const rows = [
    row("srv-1", ok({ ...TELEGRAM, disk_alert_percent: 90 })), // follows
    row("srv-2", ok(TELEGRAM)), // differs
    row("srv-3", ok()), // no channel (and differs)
    row("srv-10", ok({ heartbeat: { url: HIDDEN }, disk_alert_percent: 90 })), // only a heartbeat: no channel
    row("srv-4", { kind: "failed", reason: "down" }), // unreachable
    row("srv-5", { kind: "no-file" }), // read-only
    row("srv-6", ok({ webhooks: [{ url: HIDDEN }], disk_alert_percent: 90 }), DISK_90, { canDeploy: false }), // read-only, follows
    row("srv-7", ok(TELEGRAM), DISK_90, { canDeploy: false }), // read-only and differs
  ];

  it("has the five filters in order", () => {
    expect(FILTERS.map((f) => f.id)).toEqual(["all", "no-channel", "differs", "unreachable", "read-only"]);
  });

  it("counts each filter", () => {
    expect(countsByFilter(rows)).toEqual({ all: 8, "no-channel": 2, differs: 3, unreachable: 1, "read-only": 3 });
    expect(countsByFilter([])).toEqual({ all: 0, "no-channel": 0, differs: 0, unreachable: 0, "read-only": 0 });
  });

  it("lists what each filter matches, and the counts are the lengths of the lists", () => {
    const by = (filter: Filter) => names(visibleRows(rows, filter, ""));
    expect(by("no-channel")).toEqual(["srv-3", "srv-10"]);
    expect(by("differs")).toEqual(["srv-3", "srv-2", "srv-7"]);
    expect(by("unreachable")).toEqual(["srv-4"]);
    expect(by("read-only")).toEqual(["srv-7", "srv-5", "srv-6"]);
    const counts = countsByFilter(rows);
    for (const { id } of FILTERS) expect(by(id).length).toBe(counts[id]);
  });

  it("orders problems first: unreachable, no channel, differs, read-only, then the rest; by natural name within each", () => {
    expect(names(visibleRows(rows, "all", ""))).toEqual(["srv-4", "srv-3", "srv-10", "srv-2", "srv-7", "srv-5", "srv-6", "srv-1"]);
  });

  it("sorts names the way people count, ignoring case, and falls back to the id", () => {
    const same = [row("srv-10", ok(TELEGRAM)), row("srv-2", ok(TELEGRAM)), row("SRV-3", ok(TELEGRAM)), row("srv-1", ok(TELEGRAM)), row("srv-1", ok(TELEGRAM), DISK_90, { id: "id-0" })];
    expect(visibleRows(same, "all", "").map((r) => r.id)).toEqual(["id-0", "id-srv-1", "id-srv-2", "id-SRV-3", "id-srv-10"]);
  });

  it("searches by name or id, ignoring case and surrounding spaces, within the filter", () => {
    expect(names(visibleRows(rows, "all", "SRV-1"))).toEqual(["srv-10", "srv-1"]);
    expect(names(visibleRows(rows, "all", "  id-srv-6 "))).toEqual(["srv-6"]);
    expect(names(visibleRows(rows, "differs", "srv-1"))).toEqual([]);
    expect(names(visibleRows(rows, "all", "nothing like it"))).toEqual([]);
    expect(visibleRows(rows, "all", "   ")).toHaveLength(8);
  });

  it("does not reorder the rows it is given", () => {
    const before = names(rows);
    visibleRows(rows, "all", "");
    expect(names(rows)).toEqual(before);
  });
});

describe("paginate", () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);

  it("splits 100 rows into 4 pages of 25", () => {
    const first = paginate(hundred, 1);
    expect(first).toMatchObject({ page: 1, pages: 4, total: 100, from: 1, to: 25 });
    expect(first.items).toEqual(hundred.slice(0, 25));
    expect(paginate(hundred, 4)).toMatchObject({ page: 4, pages: 4, from: 76, to: 100, items: hundred.slice(75) });
  });

  it("keeps the page within the pages that exist", () => {
    expect(paginate(hundred, 9).page).toBe(4);
    for (const bad of [0, -3, Number.NaN, Number.NEGATIVE_INFINITY]) expect(paginate(hundred, bad).page, String(bad)).toBe(1);
    expect(paginate(hundred, 2.7).page).toBe(2);
  });

  it("handles a short last page, an empty list and another size", () => {
    expect(paginate(Array.from({ length: 26 }, (_, i) => i), 2)).toEqual({ items: [25], page: 2, pages: 2, total: 26, from: 26, to: 26 });
    expect(paginate([], 3)).toEqual({ items: [], page: 1, pages: 1, total: 0, from: 0, to: 0 });
    expect(paginate(hundred, 3, 10)).toMatchObject({ pages: 10, from: 21, to: 30 });
  });
});

describe("selecting servers", () => {
  const rows = [
    row("a", ok(TELEGRAM)), // differs
    row("b", ok({ ...TELEGRAM, disk_alert_percent: 90 })), // follows
    row("c", { kind: "failed", reason: "down" }),
    row("d", { kind: "no-file" }),
    row("e", ok(TELEGRAM), DISK_90, { canDeploy: false }), // differs, but cannot be changed
    row("f", ok()), // differs
  ];

  it("offers only servers that answered and can be changed", () => {
    expect(selectableIds(rows)).toEqual(["id-a", "id-b", "id-f"]);
  });

  it("offers for 'differing' only those of them that differ from the default", () => {
    expect(differingIds(rows)).toEqual(["id-a", "id-f"]);
    expect(differingIds(rows.map((r) => ({ ...r, differs: [] })))).toEqual([]);
  });
});

describe("planApply", () => {
  const template: NotificationsTemplate = { ...DISK_90, webhooks: [{ secretFile: "/s" }] };
  const following: NotificationsConfig = { disk_alert_percent: 90, webhooks: [{ url: HIDDEN, secret_file: "/s" }] };
  const rows = [
    row("same", ok(following), template),
    row("fresh", ok(TELEGRAM), template),
    row("down", { kind: "failed", reason: "cannot reach the agent: connection refused" }, template),
    row("nosecret", ok(following), template, { canDeploy: false }),
    row("nofile", { kind: "no-file" }, template),
  ];

  it("plans nothing for a server that follows the default, a change for one that does not, and says why a server is blocked", () => {
    const plan = planApply(template, rows, [true]);
    expect(plan).toEqual([
      { kind: "change", id: "id-same", name: "same", changes: ["webhooks"], before: expect.any(String), after: expect.any(String) },
      {
        kind: "change",
        id: "id-fresh",
        name: "fresh",
        changes: ["disk", "webhooks"],
        before: 'telegram:\n  bot_token_file: "/t"\n  chat_id: "1"\n',
        after: `webhooks:\n  - url: ${NEW_URL_TEXT}\n    secret_file: "/s"\ntelegram:\n  bot_token_file: "/t"\n  chat_id: "1"\ndisk_alert_percent: 90\nmemory_alert_percent: 10\nalert_cooldown: "5m"\n`,
      },
      { kind: "blocked", id: "id-down", name: "down", why: "unreachable", detail: "cannot reach the agent: connection refused" },
      { kind: "blocked", id: "id-nosecret", name: "nosecret", why: "read-only", detail: READ_ONLY_REASONS.noSecret },
      { kind: "blocked", id: "id-nofile", name: "nofile", why: "read-only", detail: READ_ONLY_REASONS.noFile },
    ]);
  });

  it("is the same for a server that follows when no URL is given", () => {
    expect(planApply(template, rows.slice(0, 1), [false])).toEqual([{ kind: "same", id: "id-same", name: "same" }]);
    expect(planApply(template, rows.slice(0, 1), [])).toEqual([{ kind: "same", id: "id-same", name: "same" }]);
  });

  it("makes a typed URL on a server that already follows the default the one change, shown without the URL", () => {
    const [item] = planApply(template, rows.slice(0, 1), [true]);
    expect(item).toEqual({
      kind: "change",
      id: "id-same",
      name: "same",
      changes: ["webhooks"],
      before: `webhooks:\n  - url: ${HIDDEN}\n    secret_file: "/s"\ndisk_alert_percent: 90\n`,
      after: `webhooks:\n  - url: ${NEW_URL_TEXT}\n    secret_file: "/s"\ndisk_alert_percent: 90\nmemory_alert_percent: 10\nalert_cooldown: "5m"\n`,
    });
  });

  it("blocks a server without a webhook at a slot when no URL is given for it", () => {
    const plan = planApply(template, rows.slice(1, 2), [false]);
    expect(plan).toEqual([{ kind: "blocked", id: "id-fresh", name: "fresh", why: "needs-url", detail: "It has no webhook 1: enter its URL." }]);
    const two: NotificationsTemplate = { ...template, webhooks: [{ secretFile: "/s" }, { secretFile: "/t" }] };
    expect(planApply(two, rows.slice(0, 1), [false, true])).toMatchObject([{ kind: "change" }]);
    expect(planApply(two, rows.slice(0, 1), [true, false])).toEqual([{ kind: "blocked", id: "id-same", name: "same", why: "needs-url", detail: "It has no webhook 2: enter its URL." }]);
  });

  it("keeps a server that has no section under a default of the agent's defaults as the same", () => {
    expect(planApply(PLAIN, [row("a", ok(), PLAIN)], [])).toEqual([{ kind: "same", id: "id-a", name: "a" }]);
  });

  it("never carries a URL: the plan only has the marker, and the section of a server only its hidden values", () => {
    const text = JSON.stringify(planApply(template, rows, [true]));
    expect(text).toContain(NEW_URL_TEXT);
    expect(text).not.toMatch(/https?:\/\//);
  });

  it("counts what it would do", () => {
    expect(planCounts(planApply(template, rows, [true]))).toEqual({ change: 2, same: 0, blocked: 3 });
    expect(planCounts(planApply(template, rows, [false]))).toEqual({ change: 0, same: 1, blocked: 4 });
    expect(planCounts([])).toEqual({ change: 0, same: 0, blocked: 0 });
  });
});

describe("testFact", () => {
  it("is unknown for an agent older than the route, never for one with no alert test", () => {
    expect(testFact(null)).toEqual({ kind: "unknown" });
    expect(testFact([])).toEqual({ kind: "never" });
    expect(testFact([{ kind: "key", at: "2026-11-01T00:00:00Z" }, { kind: "restore", at: "2026-11-02T00:00:00Z" }])).toEqual({ kind: "never" });
  });

  it("is the latest alert test, whatever the order the agent listed them in", () => {
    expect(
      testFact([
        { kind: "alert", at: "2026-10-30T10:00:00Z" },
        { kind: "key", at: "2026-11-03T00:00:00Z" },
        { kind: "alert", at: "2026-11-01T09:30:00Z" },
        { kind: "alert", at: "2026-10-01T00:00:00Z" },
      ]),
    ).toEqual({ kind: "at", at: "2026-11-01T09:30:00Z" });
  });
});
