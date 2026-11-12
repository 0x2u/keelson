import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationsConfig } from "@/lib/agent-types";
import { FakeNotificationsAgent } from "./fake-notifications-agent";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-notifications-actions-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

const session = vi.hoisted(() => ({ require: vi.fn(async () => {}) }));
const stepUp = vi.hoisted(() => ({ error: vi.fn(async (): Promise<string | null> => null) }));
vi.mock("@/lib/session", () => ({ requireSession: session.require, clientInfo: async () => ({ ip: "127.0.0.1" }) }));
vi.mock("@/lib/step-up", () => ({ stepUpError: stepUp.error }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const actions = await import("@/app/notifications-actions");
const servers = await import("@/lib/servers");
const { db } = await import("@/lib/db");
const { getNotificationsDefault } = await import("@/lib/notifications-default");
const { READ_ONLY_REASONS } = await import("@/lib/notifications-fleet-core");

const HIDDEN = "<hidden>";
const URL1 = "https://hooks.example/T0P-SECRET-1";
const SENSITIVE = "Where alerts are sent decides who hears about an outage.";
const SECRET_FILE = "/etc/keelson/hook";

/** The default the tests save: the events, thresholds and cooldown, and one webhook slot (its secret file; the URL is typed later). */
const DEFAULT = { events: ["app.down", "deployment.failed"], diskPercent: 90, memoryPercent: 15, cooldown: "10m", telegram: null, webhooks: [{ secretFile: SECRET_FILE }] };

afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  session.require.mockReset();
  session.require.mockResolvedValue(undefined);
  stepUp.error.mockReset();
  stepUp.error.mockResolvedValue(null);
  db().exec("DELETE FROM audit_log");
  db().exec("DELETE FROM notifications_default");
});

const audits = () => db().prepare("SELECT event, detail FROM audit_log ORDER BY id").all();

/** The default stored, as the settings page does; its own audit entry is not what the apply tests look at. */
async function storeDefault(): Promise<void> {
  await actions.saveNotificationsDefaultAction(DEFAULT);
  db().exec("DELETE FROM audit_log");
}

describe("saveNotificationsDefaultAction", () => {
  it("validates, stores, audits without detail, and sends nothing to any server", async () => {
    const out = await actions.saveNotificationsDefaultAction({ ...DEFAULT, events: ["deployment.failed", "app.down"] });
    expect(out).toEqual({
      ok: true,
      template: { events: ["deployment.failed", "app.down"], diskPercent: 90, memoryPercent: 15, cooldown: "10m", telegram: null, webhooks: [{ secretFile: SECRET_FILE }] },
      updatedAt: expect.any(Number),
    });
    expect(session.require).toHaveBeenCalled();
    expect(getNotificationsDefault()).toEqual({ template: out.ok ? out.template : null, updatedAt: out.ok ? out.updatedAt : 0 });
    expect(audits()).toEqual([{ event: "notifications_default_saved", detail: null }]);
    expect(stepUp.error).not.toHaveBeenCalled();
  });

  it("replaces the stored default on a second save", async () => {
    await actions.saveNotificationsDefaultAction(DEFAULT);
    const out = await actions.saveNotificationsDefaultAction({ ...DEFAULT, diskPercent: "70", webhooks: [] });
    expect(out).toMatchObject({ ok: true, template: { diskPercent: 70, webhooks: [] } });
    expect(getNotificationsDefault()?.template).toEqual({ events: ["deployment.failed", "app.down"], diskPercent: 70, memoryPercent: 15, cooldown: "10m", telegram: null, webhooks: [] });
    expect(db().prepare("SELECT COUNT(*) AS n FROM notifications_default").get()).toEqual({ n: 1 });
    expect(audits().map((a) => a.event)).toEqual(["notifications_default_saved", "notifications_default_saved"]);
  });

  it("rejects bad input with the errors, stores nothing and audits nothing", async () => {
    const out = await actions.saveNotificationsDefaultAction({ ...DEFAULT, diskPercent: 5, cooldown: "soon", events: ["app.exploded"], telegram: { botTokenFile: "/t" } });
    expect(out).toEqual({
      ok: false,
      errors: {
        events: "One of the events is not one the agent sends.",
        diskPercent: "The disk threshold must be between 6 and 100.",
        cooldown: "Not a duration. A number and a unit, for example 90s, 5m or 1h30m.",
        chatId: "Enter the chat id.",
      },
    });
    expect(await actions.saveNotificationsDefaultAction(null)).toMatchObject({ ok: false });
    expect(getNotificationsDefault()).toBeNull();
    expect(audits()).toEqual([]);
  });

  it("requires a session before anything else", async () => {
    session.require.mockRejectedValueOnce(new Error("no session"));
    await expect(actions.saveNotificationsDefaultAction(DEFAULT)).rejects.toThrow("no session");
    expect(getNotificationsDefault()).toBeNull();
    expect(audits()).toEqual([]);
  });
});

type Name = "thr" | "chan" | "fresh" | "stale" | "down" | "ro" | "nofile" | "bad" | "echo";

/** The servers of a small fleet, each a fake agent over real HTTP, registered in the dashboard. */
interface Fleet {
  agents: Record<Name, FakeNotificationsAgent>;
  ids: Record<Name, string>;
}

const FOLLOWING_HOOK = { url: HIDDEN, secret_file: SECRET_FILE };
const CHANGEABLE: NotificationsConfig = { name: "x", webhooks: [{ url: HIDDEN, secret_file: "/old" }], heartbeat: { url: HIDDEN, every: "1m" } };

let fleet: Fleet | null = null;

async function buildFleet(): Promise<Fleet> {
  const agents: Record<Name, FakeNotificationsAgent> = {
    // Follows the default except for its disk threshold: only a threshold changes, where alerts go does not.
    thr: new FakeNotificationsAgent({ hash: "h-thr", notifications: { name: "thr", events: ["app.down", "deployment.failed"], webhooks: [FOLLOWING_HOOK], disk_alert_percent: 50, memory_alert_percent: 15, alert_cooldown: "600s" } }),
    // Its webhook uses another secret file: applying moves where alerts go.
    chan: new FakeNotificationsAgent({ hash: "h-chan", notifications: { ...CHANGEABLE, name: "chan" } }),
    // Has no notifications at all: it needs a URL.
    fresh: new FakeNotificationsAgent({ hash: "h-fresh" }),
    // Its file moved since the operator looked.
    stale: new FakeNotificationsAgent({ hash: "h-moved", notifications: { ...CHANGEABLE, name: "stale" } }),
    down: new FakeNotificationsAgent({ hash: "h-down", notifications: CHANGEABLE }),
    ro: new FakeNotificationsAgent({ hash: "h-ro", notifications: CHANGEABLE }),
    nofile: new FakeNotificationsAgent({ readOnlyNoFile: true }),
    bad: new FakeNotificationsAgent({ invalidFile: true, hash: "h-bad" }),
    // Refuses every save and says the URL back in its message and its issue.
    echo: new FakeNotificationsAgent({
      hash: "h-echo",
      notifications: CHANGEABLE,
      save: { status: 400, body: { error: "invalid", message: `cannot send to ${URL1}`, issues: [{ severity: "error", path: "notifications.webhooks[0].url", message: `${URL1} is not reachable` }] } },
    }),
  };
  await Promise.all(Object.values(agents).map((a) => a.start()));
  const ids = {} as Record<Name, string>;
  for (const name of Object.keys(agents) as Name[]) {
    ids[name] = servers.createServer({ name, url: agents[name].url, token: "t".repeat(40), ...(name === "ro" ? {} : { deploySecret: "s".repeat(40) }) });
  }
  // A closed port: the agent that does not answer.
  await agents.down.stop();
  fleet = { agents, ids };
  return fleet;
}

afterEach(async () => {
  if (fleet === null) return;
  for (const name of Object.keys(fleet.agents) as Name[]) {
    await fleet.agents[name].stop();
    servers.deleteServer(fleet.ids[name]);
  }
  fleet = null;
});

const PUT = "PUT /v1/config/notifications";
const target = (f: Fleet, name: Name, baseHash = f.agents[name].hash) => ({ id: f.ids[name], baseHash });
const everyRequest = (f: Fleet) => Object.values(f.agents).flatMap((a) => a.requests);
const saved = (f: Fleet, name: Name) => f.agents[name].saves;

describe("applyNotificationsDefaultAction", () => {
  it("reports what became of every server, and keeps writing when one cannot be written", async () => {
    const f = await buildFleet();
    await storeDefault();
    const targets = [target(f, "thr"), target(f, "chan"), target(f, "fresh"), target(f, "stale", "h-seen-before"), target(f, "down", "h-down"), target(f, "ro", "h-ro"), target(f, "nofile", "h-x"), target(f, "bad")];

    const out = await actions.applyNotificationsDefaultAction(targets, [URL1]);

    expect(out).toEqual({
      ok: true,
      results: [
        { id: f.ids.thr, outcome: { status: "applied", version: 1, warnings: [] } },
        { id: f.ids.chan, outcome: { status: "applied", version: 1, warnings: [] } },
        { id: f.ids.fresh, outcome: { status: "applied", version: 1, warnings: [] } },
        { id: f.ids.stale, outcome: { status: "conflict" } },
        { id: f.ids.down, outcome: { status: "unreachable", reason: expect.stringMatching(/^cannot reach the agent: /) } },
        { id: f.ids.ro, outcome: { status: "read-only", reason: READ_ONLY_REASONS.noSecret } },
        { id: f.ids.nofile, outcome: { status: "read-only", reason: READ_ONLY_REASONS.noFile } },
        { id: f.ids.bad, outcome: { status: "read-only", reason: READ_ONLY_REASONS.invalid } },
      ],
    });
    // The step-up check is asked once, for the whole batch, with the reason.
    expect(stepUp.error).toHaveBeenCalledTimes(1);
    expect(stepUp.error).toHaveBeenCalledWith({ required: true, reason: SENSITIVE }, "the default notification settings");
  });

  it("writes to each saved server the default merged into what it has, signed, on the base hash it was given", async () => {
    const f = await buildFleet();
    await storeDefault();
    await actions.applyNotificationsDefaultAction([target(f, "thr"), target(f, "chan"), target(f, "fresh"), target(f, "stale", "h-seen-before")], [URL1]);

    const common = { events: ["deployment.failed", "app.down"], disk_alert_percent: 90, memory_alert_percent: 15, alert_cooldown: "10m" };
    const hook = { url: URL1, secret_file: SECRET_FILE };
    expect(saved(f, "thr")).toEqual([{ base_hash: "h-thr", comment: "Applied the default notification settings", notifications: { ...common, name: "thr", webhooks: [hook] } }]);
    expect(saved(f, "chan")).toEqual([
      { base_hash: "h-chan", comment: "Applied the default notification settings", notifications: { ...common, name: "chan", webhooks: [hook], heartbeat: { url: HIDDEN, every: "1m" } } },
    ]);
    expect(saved(f, "fresh")).toEqual([{ base_hash: "h-fresh", comment: "Applied the default notification settings", notifications: { ...common, webhooks: [hook] } }]);
    // A stale base is sent as it was seen and refused: never read again and forced.
    expect(saved(f, "stale")).toEqual([{ base_hash: "h-seen-before", comment: "Applied the default notification settings", notifications: { ...common, name: "stale", webhooks: [hook], heartbeat: { url: HIDDEN, every: "1m" } } }]);
    expect(f.agents.stale.lastSaved).toBeUndefined();
    expect(f.agents.chan.lastSaved).toEqual(saved(f, "chan")[0].notifications);

    for (const name of ["thr", "chan", "fresh", "stale"] as const) {
      const [put] = f.agents[name].requests.filter((r) => `${r.method} ${r.url}` === PUT);
      expect(put.headers["x-keelson-signature"], name).toMatch(/^[0-9a-f]{64}$/);
      expect(put.headers["x-keelson-timestamp"], name).toBeDefined();
      expect(put.headers.authorization, name).toBeUndefined();
    }
    // Servers that were not written to were not asked to.
    for (const name of ["down", "ro", "nofile", "bad", "echo"] as const) expect(saved(f, name), name).toEqual([]);
  });

  it("does not write anything, anywhere, when the step-up check refuses; then writes when it allows", async () => {
    const f = await buildFleet();
    await storeDefault();
    const targets = [target(f, "thr"), target(f, "chan"), target(f, "fresh")];
    stepUp.error.mockResolvedValueOnce("Confirm your password to continue.");

    expect(await actions.applyNotificationsDefaultAction(targets, [URL1])).toEqual({ ok: false, message: "Confirm your password to continue." });
    expect(stepUp.error).toHaveBeenCalledTimes(1);
    expect(everyRequest(f).filter((r) => r.method !== "GET")).toEqual([]);
    expect(audits()).toEqual([]);

    const out = await actions.applyNotificationsDefaultAction(targets, [URL1]);
    expect(out).toMatchObject({ ok: true });
    expect(stepUp.error).toHaveBeenCalledTimes(2);
    expect(saved(f, "thr")).toHaveLength(1);
    expect(saved(f, "chan")).toHaveLength(1);
    expect(saved(f, "fresh")).toHaveLength(1);
  });

  it("asks for no unlock when only a threshold changes", async () => {
    const f = await buildFleet();
    await storeDefault();
    const out = await actions.applyNotificationsDefaultAction([target(f, "thr")], [""]);

    expect(out).toEqual({ ok: true, results: [{ id: f.ids.thr, outcome: { status: "applied", version: 1, warnings: [] } }] });
    expect(stepUp.error).not.toHaveBeenCalled();
    // No URL was typed: the server keeps the one it stores, shown as hidden and sent back as such.
    expect(saved(f, "thr")[0].notifications).toEqual({
      name: "thr",
      events: ["deployment.failed", "app.down"],
      webhooks: [FOLLOWING_HOOK],
      disk_alert_percent: 90,
      memory_alert_percent: 15,
      alert_cooldown: "10m",
    });
    expect(everyRequest(f).some((r) => r.body.includes(URL1))).toBe(false);
  });

  it("says a server without a webhook needs a URL when none was typed, and does not touch it", async () => {
    const f = await buildFleet();
    await storeDefault();
    const out = await actions.applyNotificationsDefaultAction([target(f, "fresh"), target(f, "thr")], [""]);
    expect(out).toEqual({
      ok: true,
      results: [
        { id: f.ids.fresh, outcome: { status: "needs-url", slot: 1 } },
        { id: f.ids.thr, outcome: { status: "applied", version: 1, warnings: [] } },
      ],
    });
    expect(saved(f, "fresh")).toEqual([]);
  });

  it("reports a server that is no longer registered", async () => {
    await storeDefault();
    const out = await actions.applyNotificationsDefaultAction([{ id: "nope", baseHash: "h" }], [""]);
    expect(out).toEqual({ ok: true, results: [{ id: "nope", outcome: { status: "unreachable", reason: "This server is no longer registered." } }] });
  });

  it("keeps the typed URL out of the result, the audit trail, and every request but the saves that carry it", async () => {
    const f = await buildFleet();
    await storeDefault();
    const out = await actions.applyNotificationsDefaultAction(
      [target(f, "thr"), target(f, "chan"), target(f, "fresh"), target(f, "stale", "h-seen-before"), target(f, "down"), target(f, "ro"), target(f, "nofile"), target(f, "echo")],
      [`  ${URL1}  `],
    );

    expect(out).toEqual({
      ok: true,
      results: [
        { id: f.ids.thr, outcome: { status: "applied", version: 1, warnings: [] } },
        { id: f.ids.chan, outcome: { status: "applied", version: 1, warnings: [] } },
        { id: f.ids.fresh, outcome: { status: "applied", version: 1, warnings: [] } },
        { id: f.ids.stale, outcome: { status: "conflict" } },
        { id: f.ids.down, outcome: { status: "unreachable", reason: expect.any(String) } },
        { id: f.ids.ro, outcome: { status: "read-only", reason: READ_ONLY_REASONS.noSecret } },
        { id: f.ids.nofile, outcome: { status: "read-only", reason: READ_ONLY_REASONS.noFile } },
        {
          id: f.ids.echo,
          outcome: {
            status: "refused",
            kind: "invalid",
            message: "cannot send to [redacted]",
            issues: [{ severity: "error", path: "notifications.webhooks[0].url", message: "[redacted] is not reachable" }],
          },
        },
      ],
    });
    expect(JSON.stringify(out)).not.toContain("T0P-SECRET");

    // The audit trail: counts only.
    expect(audits()).toEqual([{ event: "notifications_default_applied", detail: "3 applied, 1 conflict, 1 refused, 2 read-only, 1 unreachable of 8" }]);
    expect(JSON.stringify(db().prepare("SELECT * FROM audit_log").all())).not.toContain("T0P-SECRET");
    expect(JSON.stringify(db().prepare("SELECT * FROM notifications_default").all())).not.toContain("T0P-SECRET");

    // The URL travelled in the body of a save, and nowhere else (not a read, not a header, not an address).
    let carrying = 0;
    for (const [name, agent] of Object.entries(f.agents)) {
      for (const r of agent.requests) {
        if (!JSON.stringify(r).includes("T0P-SECRET")) continue;
        carrying++;
        expect(`${r.method} ${r.url}`, name).toBe(PUT);
        expect((JSON.parse(r.body) as { notifications: NotificationsConfig }).notifications.webhooks?.[0], name).toEqual({ url: URL1, secret_file: SECRET_FILE });
      }
    }
    // thr, chan, fresh, stale and echo each got one save carrying it; the three that could not be written got none.
    expect(carrying).toBe(5);
    for (const name of ["down", "ro", "nofile"] as const) expect(JSON.stringify(f.agents[name].requests), name).not.toContain("T0P-SECRET");
    // A server shows its webhook as hidden when read back: the URL is not given back by any read.
    expect(f.agents.thr.requests.filter((r) => r.method === "GET").every((r) => !r.body.includes("T0P-SECRET"))).toBe(true);
  });

  it("counts every outcome in the audit entry, and only audits when the batch ran", async () => {
    const f = await buildFleet();
    await storeDefault();
    await actions.applyNotificationsDefaultAction([target(f, "thr"), target(f, "fresh"), target(f, "nofile")], [""]);
    expect(audits()).toEqual([{ event: "notifications_default_applied", detail: "1 applied, 1 needs-url, 1 read-only of 3" }]);

    db().exec("DELETE FROM audit_log");
    stepUp.error.mockResolvedValueOnce("Confirm.");
    await actions.applyNotificationsDefaultAction([target(f, "chan")], [URL1]);
    expect(audits()).toEqual([]);
  });

  describe("refuses before reading or writing anything", () => {
    const expectUntouched = async (f: Fleet) => {
      expect(everyRequest(f)).toEqual([]);
      expect(stepUp.error).not.toHaveBeenCalled();
      expect(audits()).toEqual([]);
    };

    it("with no default stored", async () => {
      const f = await buildFleet();
      expect(await actions.applyNotificationsDefaultAction([target(f, "thr")], [""])).toEqual({ ok: false, message: "There is no default to apply. Set one first." });
      await expectUntouched(f);
    });

    it("with targets that are not a list of distinct servers with a hash", async () => {
      const f = await buildFleet();
      await storeDefault();
      const message = "Choose the servers to apply the default to.";
      const one = target(f, "thr");
      const many = Array.from({ length: 501 }, (_, i) => ({ id: `s${i}`, baseHash: "h" }));
      for (const bad of [undefined, null, "thr", {}, [], [one, one], [{ id: one.id }], [{ baseHash: "h" }], [{ id: 1, baseHash: "h" }], [null], many]) {
        expect(await actions.applyNotificationsDefaultAction(bad, [""]), JSON.stringify(bad)?.slice(0, 40)).toEqual({ ok: false, message });
      }
      await expectUntouched(f);
    });

    it("with a number of URLs that is not the number of webhook slots of the default", async () => {
      const f = await buildFleet();
      await storeDefault();
      const message = "The default has changed: reload the page and apply again.";
      for (const bad of [[], ["", ""], undefined, null, "https://x.example", [5]]) {
        expect(await actions.applyNotificationsDefaultAction([target(f, "thr")], bad), JSON.stringify(bad)).toEqual({ ok: false, message });
      }
      await expectUntouched(f);
    });

    it("with a URL that is not http(s), without saying it back", async () => {
      const f = await buildFleet();
      await storeDefault();
      expect(await actions.applyNotificationsDefaultAction([target(f, "thr")], ["ftp://hooks.example/T0P-SECRET-2"])).toEqual({ ok: false, message: "The URL must start with http:// or https://." });
      expect(await actions.applyNotificationsDefaultAction([target(f, "thr")], ["hooks.example/T0P-SECRET-2"])).toEqual({
        ok: false,
        message: "That is not a valid URL. Include the scheme, for example https://example.com/hook.",
      });
      await expectUntouched(f);
    });

    it("without a session", async () => {
      const f = await buildFleet();
      await storeDefault();
      session.require.mockRejectedValueOnce(new Error("no session"));
      await expect(actions.applyNotificationsDefaultAction([target(f, "thr")], [""])).rejects.toThrow("no session");
      await expectUntouched(f);
    });
  });
});
