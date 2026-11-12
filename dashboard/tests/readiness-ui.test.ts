import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppStatus, DatabaseStatus } from "@/lib/agent-types";
import type { FleetServer } from "@/lib/fleet";
import { FakeReadinessAgent } from "./fake-readiness-agent";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-readiness-ui-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;
process.env.KEELSON_AGENT_BIN_DIR = dir;
writeFileSync(path.join(dir, "VERSION"), "v1\n");

vi.mock("next/navigation", () => ({ notFound: () => Promise.reject(new Error("not found")), useRouter: () => ({ refresh() {} }) }));
// The dialogs are client components with their own tests of behaviour (the actions); here they are markers, so the list is what is read.
vi.mock("@/components/readiness/TestRestoreAction", () => ({ TestRestoreAction: (p: { name: string; label?: string }) => createElement("button", { "data-fix": "test-restore" }, `${p.label} ${p.name}`) }));
vi.mock("@/components/readiness/ProveKeyDialog", () => ({ ProveKeyDialog: (p: { name: string; label?: string }) => createElement("button", { "data-fix": "prove-key" }, `${p.label} ${p.name}`) }));
vi.mock("@/components/readiness/TestAlertDialog", () => ({ TestAlertDialog: (p: { serverName: string; label?: string }) => createElement("button", { "data-fix": "test-alert" }, `${p.label} ${p.serverName}`) }));

const { ReadinessGroups, ReadinessHeadline } = await import("@/components/readiness/ReadinessList");
const { TrustLine } = await import("@/components/readiness/TrustLine");
const { ReadinessSection } = await import("@/components/servers/ServerOverview");
const { dashboardReadiness, forProject, ownedKey, serverReadiness } = await import("@/lib/readiness-core");
const { loadServerReadiness } = await import("@/lib/readiness");
const servers = await import("@/lib/servers");

const NOW = Date.parse("2026-11-02T12:00:00Z");
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const app = (name: string): AppStatus =>
  ({ name, image: `r:${name}`, project: "", environment: "", digest: "", container: null, last_deployment: null }) as AppStatus;
const database = (name: string): DatabaseStatus => ({
  name,
  engine: "postgres",
  host: "db",
  port: 5432,
  database: name,
  user: "u",
  version: 16,
  network: "",
  has_password: true,
  backup: { schedule: "0 3 * * *", timezone: "UTC", keep: 7, keep_days: 0, paused: false, destination: "local:/b", recipients: 1, job: `backup-${name}`, next_run: ago(-3_600_000), last_run: { id: "r", status: "succeeded", started_at: ago(3_600_000), finished_at: ago(3_600_000) } },
});

const agent = new FakeReadinessAgent({
  version: "v0.9",
  apps: [app("shop")],
  databases: [database("shop-db")],
  model: {
    apps: [{ name: "shop", image: "r:shop" }],
    databases: [{ name: "shop-db", host: "db", database: "shop", user: "u", backups: { schedule: "0 3 * * *", recipients: ["age1x"], destinations: [{ local: { dir: "/b" } }] } }],
    notifications: { telegram: { bot_token_file: "/t", chat_id: "1" } },
  },
  proofs: [{ kind: "restore", subject: "shop-db", at: ago(2 * DAY) }],
});
let id = "";
beforeAll(async () => {
  await agent.start();
  id = servers.createServer({ name: "alpha", url: agent.url, token: "t".repeat(40), deploySecret: "s".repeat(40) });
});
afterAll(async () => {
  await agent.stop();
  rmSync(dir, { recursive: true, force: true });
});

const html = (el: ReactElement) => renderToStaticMarkup(el);
const items = async () => loadServerReadiness({ server: { id, name: "alpha" }, reachable: true, version: "v0.9", apps: agent.opts.apps, databases: agent.opts.databases }, NOW);

describe("the checklist of a project", () => {
  it("shows the groups in order with how many pass, each item's state word, detail and fix", async () => {
    const mine = forProject([...(await items()), ...dashboardReadiness({ totp: false, passkeys: 0, lastBackupAt: null }, NOW)], {
      name: "shop",
      servers: [id],
      databases: new Set([ownedKey(id, "shop-db")]),
      apps: new Set([ownedKey(id, "shop")]),
    });
    const out = html(createElement(ReadinessGroups, { items: mine }));
    const headings = [...out.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((m) => m[1]);
    expect(headings).toEqual(["Data", "Alerts", "Deploys", "Access"]);
    expect(out).toMatch(/\d+ of \d+ pass/);
    // Words come from the vocabulary table, with the thing each is about.
    expect(out).toContain("Passing");
    expect(out).toContain("To do");
    expect(out).toContain("Needs a look");
    expect(out).toContain("shop-db");
    // The restore test has a proof (passing, "Test again"); the key was never proven (a dialog); the alert was never tested.
    expect(out).toContain("Test again shop-db");
    expect(out).toContain("Prove the key shop-db");
    expect(out).toContain("Send a test alert alpha");
    // What cannot be fixed from the list links to the page that does.
    expect(out).toContain('href="/servers/' + id + '/config/databases/shop-db"');
    expect(out).toContain('href="/settings/security"');
    expect(out).toContain('href="/settings/backup"');
    expect(out).toContain('href="/servers/' + id + '/update"');
  });

  it("says a project with no database has nothing to back up, with no state word to claim it passes", () => {
    const mine = forProject(serverReadiness({ server: { id: "s1", name: "alpha" }, reachable: true, version: "v1", bundledVersion: "v1", apps: [], databases: [], config: { kind: "ok", value: {} }, proofs: { kind: "ok", value: [] }, restoreTests: {}, histories: {} }, NOW), {
      name: "blog",
      servers: ["s1"],
      databases: new Set(),
      apps: new Set(),
    });
    const out = html(createElement(ReadinessGroups, { items: mine }));
    expect(out).toContain("This project has no database, so there is nothing to back up.");
    expect(out).toContain("Not applicable");
    expect(out).not.toContain("Restore tested");
  });

  it("opens with the verdict and the next thing to do", async () => {
    const out = html(createElement(ReadinessHeadline, { items: await items() }));
    expect(out).toMatch(/Trust: \d+ of \d+ checks pass/);
    expect(out).toContain("next:");
  });
});

describe("the server's card", () => {
  it("lists the server's own items only: the alert channel and the agent's version", async () => {
    const card = await ReadinessSection({ serverId: id });
    expect(card).not.toBeNull();
    const out = html(card as ReactElement);
    expect(out).toContain("Alert channel tested");
    expect(out).toContain("Agent and dashboard versions match");
    expect(out).toContain("The agent runs v0.9; this dashboard carries v1.");
    expect(out).not.toContain("Restore tested");
    expect(out).not.toContain("Health check present");
    expect(out).toMatch(/Trust: 0 of 2 checks pass/);
  });
});

describe("Home's line", () => {
  const fleet = (): FleetServer[] => [{ server: { id, name: "alpha" }, reachable: true, lastSeen: NOW, url: agent.url, transport: "direct", serves: true, canDeploy: true, version: "v0.9", apps: agent.opts.apps, databases: agent.opts.databases, jobs: [] } as FleetServer];

  it("says how many checks pass and links to the worst place, naming it", async () => {
    const line = await TrustLine({ servers: fleet(), now: NOW });
    const out = html(line as ReactElement);
    expect(out).toMatch(/Trust: \d+ of \d+ checks pass/);
    expect(out).toContain("next: ");
    // The worst item is a data check of the database that belongs to no project label: the app's project is its own name.
    expect(out).toMatch(/href="\/(projects|servers)\//);
  });

  it("is a single line, not a list: it never lists the checks", async () => {
    const out = html((await TrustLine({ servers: fleet(), now: NOW })) as ReactElement);
    expect(out).not.toContain("<ul");
  });
});
