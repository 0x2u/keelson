import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildFeed, deliveryView, parseFilter, type ServerActivity } from "@/lib/activity-core";
import type { AlertRecord, SystemInfo } from "@/lib/agent-types";
import { ALERT_DELIVERY_WINDOW_MS, attentionItems, type ServerSnapshot } from "@/lib/attention-core";
import { loadOf, memoryOf, serverRows, type FleetServerInput } from "@/lib/servers-view-core";

const { ServersList } = await import("@/components/servers/ServersList");

const NOW = Date.parse("2026-10-23T12:00:00Z");
const HOUR = 3_600_000;
const GIB = 1024 ** 3;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const alert = (over: Partial<AlertRecord> = {}): AlertRecord => ({ type: "app_down", severity: "critical", server: "alpha", app: "shop", time: ago(HOUR), title: "shop is down", status: "delivered", ...over });

const activity = (alerts: AlertRecord[] | undefined, over: Partial<ServerActivity> = {}): ServerActivity => ({
  server: { id: "s1", name: "alpha" },
  deployments: [],
  runs: [],
  audit: [],
  versions: [],
  projects: { shop: "shop" },
  gaps: [],
  ...(alerts === undefined ? {} : { alerts }),
  ...over,
});

const feed = (servers: ServerActivity[], query: Record<string, string> = {}) => buildFeed({ servers, dashboard: [], now: NOW, filter: parseFilter(query), trigger: (t) => t });

describe("alerts in the activity feed", () => {
  it("builds a row with the title, severity, server, app and a delivery badge", () => {
    const [row] = feed([activity([alert()])]).events;
    expect(row).toMatchObject({ kind: "alert", summary: "shop is down", severity: "critical", server: { id: "s1", name: "alpha" }, app: "shop", project: "shop", status: "Delivered", tone: "success", failed: false });
    expect(row.subject).toEqual({ label: "shop", href: "/servers/s1/apps/shop" });
  });

  it("names the channels that failed and counts a partial or failed delivery as failed", () => {
    const events = feed([activity([alert({ status: "partial", failed_channels: ["telegram"], time: ago(2 * HOUR) }), alert({ status: "failed", failed_channels: ["telegram", "webhook"], title: "disk full", time: ago(HOUR) })])]).events;
    expect(events.map((e) => [e.status, e.failed, e.note])).toEqual([
      ["Not delivered", true, "Failed on telegram, webhook"],
      ["Partly delivered", true, "Failed on telegram"],
    ]);
  });

  it("says why an alert was not sent, dropped or held back, and does not call those failures", () => {
    const events = feed([activity([alert({ status: "no_channel", time: ago(HOUR) }), alert({ status: "dropped", time: ago(2 * HOUR) }), alert({ status: "suppressed", time: ago(3 * HOUR) })])]).events;
    expect(events.map((e) => [e.status, e.failed])).toEqual([["Not sent", false], ["Dropped", false], ["Suppressed", false]]);
    expect(events[0].note).toMatch(/No alert channel/);
  });

  it("is sorted with the other events, newest first, and filtered by the alert kind and the failed-only switch", () => {
    const servers = [activity([alert({ time: ago(3 * HOUR) }), alert({ status: "failed", time: ago(HOUR), title: "b" })], { deployments: [{ id: "d1", app: "shop", ref: "shop:v2", status: "succeeded", trigger: "api", started_at: ago(2 * HOUR), finished_at: ago(2 * HOUR) }] })];
    expect(feed(servers).events.map((e) => e.kind)).toEqual(["alert", "deployment", "alert"]);
    expect(feed(servers, { kind: "alert" }).events).toHaveLength(2);
    expect(feed(servers, { kind: "alert", failed: "1" }).events.map((e) => e.summary)).toEqual(["b"]);
    expect(feed(servers, { kind: "deployment" }).events).toHaveLength(1);
  });

  it("skips an agent that keeps no history, and shows a failed read as a gap rather than silence", () => {
    const out = feed([activity(undefined), activity(undefined, { server: { id: "s2", name: "beta" }, gaps: [{ source: "alert history", reason: "HTTP 500" }] })]);
    expect(out.events).toEqual([]);
    expect(out.gaps).toEqual([{ server: { id: "s2", name: "beta" }, source: "alert history", reason: "HTTP 500" }]);
  });

  it("shows a status it does not know as it came", () => {
    expect(deliveryView("queued")).toMatchObject({ label: "queued", tone: "muted", failed: false });
  });
});

const snapshot = (alerts: AlertRecord[] | null | undefined): ServerSnapshot => ({ server: { id: "s1", name: "alpha" }, reachable: true, lastSeen: NOW, containers: [], apps: [], jobs: [], databases: [], proxy: null, ...(alerts === undefined ? {} : { alerts }) });
const alertItems = (alerts: AlertRecord[] | null | undefined) => attentionItems([snapshot(alerts)], NOW).filter((i) => i.kind === "alert");

describe("the failed delivery attention rule", () => {
  it("flags a failed or partial last alert of the last 24 hours, naming the channels", () => {
    const [failed] = alertItems([alert({ status: "failed", time: ago(HOUR) })]);
    expect(failed).toMatchObject({ severity: "warning", since: ago(HOUR), message: "The last alert of alpha reached no channel: shop is down" });
    expect(failed.actions.map((a) => a.href)).toEqual(["/servers/s1/config/notifications", "/activity?kind=alert&server=s1"]);
    const [partial] = alertItems([alert({ status: "partial", failed_channels: ["webhook"] })]);
    expect(partial.message).toContain("did not reach every channel (failed on webhook)");
  });

  it("judges only the most recent alert: a later delivered one clears it", () => {
    expect(alertItems([alert({ status: "delivered", time: ago(HOUR) }), alert({ status: "failed", time: ago(2 * HOUR) })])).toEqual([]);
    expect(alertItems([alert({ status: "failed", time: ago(2 * HOUR) }), alert({ status: "failed", time: ago(HOUR), title: "newer" })])[0].message).toContain("newer");
  });

  it("ignores a failure older than 24 hours, other statuses, and a server whose alerts were not read or kept", () => {
    expect(alertItems([alert({ status: "failed", time: ago(ALERT_DELIVERY_WINDOW_MS + 1000) })])).toEqual([]);
    expect(alertItems([alert({ status: "no_channel" })])).toEqual([]);
    expect(alertItems(null)).toEqual([]);
    expect(alertItems(undefined)).toEqual([]);
  });
});

const system = (over: Partial<SystemInfo["host"]> = {}): SystemInfo => ({ time: ago(0), host: { cpus: 2, disk: { path: "/", total: 100 * GIB, free: 60 * GIB }, ...over } });
const server = (over: Partial<FleetServerInput> = {}): FleetServerInput => ({
  server: { id: "s1", name: "alpha" },
  url: "http://alpha:7878",
  transport: "direct",
  serves: false,
  canDeploy: true,
  reachable: true,
  lastSeen: NOW,
  version: "1.4.0",
  system: system(),
  containers: [],
  apps: [],
  jobs: [],
  databases: [],
  proxy: null,
  deployments: [],
  ...over,
});
const rowOf = (over: Partial<FleetServerInput>) => serverRows([server(over)], [], "1.4.0")[0];

describe("the memory and load columns of the servers list", () => {
  it("takes used memory as what is not available, with the tone of the host verdict", () => {
    expect(memoryOf({ total: 8 * GIB, available: 4 * GIB })).toEqual({ used: 4 * GIB, total: 8 * GIB, percent: 50, tone: "success" });
    expect(memoryOf({ total: 100, available: 15 })?.tone).toBe("warning");
    expect(memoryOf({ total: 100, available: 5 })).toMatchObject({ percent: 95, tone: "danger" });
    expect(memoryOf(undefined)).toBeUndefined();
    expect(memoryOf({ total: 0, available: 0 })).toBeUndefined();
  });

  it("takes load per CPU with the tone of the host verdict", () => {
    expect(loadOf({ one: 0.5 }, 2)).toEqual({ one: 0.5, cpus: 2, perCpu: 0.25, tone: "success" });
    expect(loadOf({ one: 2 }, 2)?.tone).toBe("warning");
    expect(loadOf({ one: 5 }, 2)?.tone).toBe("danger");
    expect(loadOf(undefined, 2)).toBeUndefined();
    expect(loadOf({ one: 1 }, 0)).toBeUndefined();
  });

  it("puts both on a reachable row, and none on one that did not answer", () => {
    const row = rowOf({ system: system({ memory: { total: 8 * GIB, available: 2 * GIB, swap_total: 0, swap_free: 0 }, load: { one: 3, five: 1, fifteen: 1 } }) });
    expect(row.memory).toMatchObject({ percent: 75, tone: "success" });
    expect(row.load).toMatchObject({ perCpu: 1.5, tone: "warning" });
    const down = rowOf({ reachable: false, reason: "refused", system: undefined });
    expect(down.memory).toBeUndefined();
    expect(down.load).toBeUndefined();
  });

  it("renders the values with their tone, an em dash when the agent does not report them, and can't tell when it did not answer", () => {
    const full = renderToStaticMarkup(createElement(ServersList, { rows: [rowOf({ system: system({ memory: { total: 100, available: 10, swap_total: 0, swap_free: 0 }, load: { one: 4.4, five: 1, fifteen: 1 } }) })] }));
    expect(full).toContain("90%");
    expect(full).toContain("2.20");
    expect(full).toContain("text-warning-text");
    const bare = renderToStaticMarkup(createElement(ServersList, { rows: [rowOf({})] }));
    expect(bare).toContain("—");
    const unreachable = renderToStaticMarkup(createElement(ServersList, { rows: [rowOf({ reachable: false, reason: "refused", system: undefined })] }));
    expect(unreachable).toContain("Can&#x27;t tell");
  });

  it("leads its empty state with the one-command install and a primary Add server action", () => {
    const html = renderToStaticMarkup(createElement(ServersList, { rows: [] }));
    expect(html).toContain("Run one command on a server: its Keelson agent installs itself and connects out to this dashboard.");
    expect(html).toContain("Add server");
    expect(html).toContain('href="/servers/new"');
  });
});
