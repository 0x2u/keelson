import { describe, expect, it } from "vitest";
import { HIDDEN, type ConfigIssue, type NotificationsConfig } from "@/lib/agent-types";
import {
  APPLY_CONCURRENCY,
  applyTemplate,
  scrubSecrets,
  type ApplyDeps,
  type ApplyOutcome,
  type ApplyResult,
  type ApplyTarget,
  type LoadedTarget,
  type SaveAttempt,
} from "@/lib/notifications-apply-core";
import type { NotificationsTemplate } from "@/lib/notifications-core";

const URL1 = "https://hooks.example/SECRET1";
const SENSITIVE = "Where alerts are sent decides who hears about an outage.";

/** A default with one webhook slot (its secret file) and a 90% disk threshold. */
const WITH_HOOK: NotificationsTemplate = { events: [], diskPercent: 90, memoryPercent: 10, cooldown: "5m", telegram: null, webhooks: [{ secretFile: "/s" }] };
/** A default that only moves thresholds and events: nothing about where alerts go. */
const THRESHOLDS: NotificationsTemplate = { events: ["app.down"], diskPercent: 90, memoryPercent: 10, cooldown: "5m", telegram: null, webhooks: [] };

const following: NotificationsConfig = { disk_alert_percent: 90, webhooks: [{ url: HIDDEN, secret_file: "/s" }] };
const hooked = (name: string): LoadedTarget => ({ kind: "ok", notifications: { name, webhooks: [{ url: HIDDEN, secret_file: "/old" }] } });
const SAVED: SaveAttempt = { ok: true, hash: "new", version: 2, issues: [] };

interface Script {
  load: LoadedTarget;
  save?: SaveAttempt | ((config: NotificationsConfig, baseHash: string) => SaveAttempt);
}

/** Lets the other servers of the batch run: whatever is in flight at once is then in flight together. */
const yieldToOthers = () => Promise.resolve();
const targetsOf = (...ids: string[]): ApplyTarget[] => ids.map((id) => ({ id, baseHash: `hash-${id}` }));

/** In-memory servers: what each answers to a read and a save, and a record of everything asked of them, in order. */
function fleet(scripts: Record<string, Script>, unlockAnswer: string | null = null) {
  const log: string[] = [];
  const saves: { id: string; config: NotificationsConfig; baseHash: string }[] = [];
  const unlocks: string[] = [];
  const peak = { load: 0, save: 0 };
  let loading = 0;
  let saving = 0;
  const deps: ApplyDeps = {
    async load(id) {
      log.push(`load:${id}`);
      peak.load = Math.max(peak.load, ++loading);
      await yieldToOthers();
      loading--;
      return scripts[id].load;
    },
    async save(id, config, baseHash) {
      log.push(`save:${id}`);
      saves.push({ id, config, baseHash });
      peak.save = Math.max(peak.save, ++saving);
      await yieldToOthers();
      saving--;
      const answer = scripts[id].save ?? SAVED;
      return typeof answer === "function" ? answer(config, baseHash) : answer;
    },
    async unlock(reason) {
      log.push("unlock");
      unlocks.push(reason);
      return unlockAnswer;
    },
  };
  return { deps, log, saves, unlocks, peak };
}

const outcomes = (r: ApplyResult): Record<string, ApplyOutcome> => {
  if (!r.ok) throw new Error(`not ok: ${r.message}`);
  return Object.fromEntries(r.results.map((x) => [x.id, x.outcome]));
};

describe("applyTemplate", () => {
  it("reads, merges and saves every server, in the order given, with the base hash of the operator's snapshot", async () => {
    const f = fleet({ a: { load: hooked("a") }, b: { load: hooked("b") }, c: { load: { kind: "ok" } } });
    const result = await applyTemplate(targetsOf("a", "b", "c"), WITH_HOOK, [URL1], f.deps);

    expect(result).toEqual({
      ok: true,
      results: [
        { id: "a", outcome: { status: "applied", version: 2, warnings: [] } },
        { id: "b", outcome: { status: "applied", version: 2, warnings: [] } },
        { id: "c", outcome: { status: "applied", version: 2, warnings: [] } },
      ],
    });
    const base = { disk_alert_percent: 90, memory_alert_percent: 10, alert_cooldown: "5m" };
    expect(f.saves.sort((x, y) => x.id.localeCompare(y.id))).toEqual([
      { id: "a", baseHash: "hash-a", config: { ...base, name: "a", webhooks: [{ url: URL1, secret_file: "/s" }] } },
      { id: "b", baseHash: "hash-b", config: { ...base, name: "b", webhooks: [{ url: URL1, secret_file: "/s" }] } },
      { id: "c", baseHash: "hash-c", config: { ...base, webhooks: [{ url: URL1, secret_file: "/s" }] } },
    ]);
    expect(f.unlocks).toEqual([SENSITIVE]);
  });

  it("keeps the URL a server stores (hidden) when none is typed", async () => {
    const f = fleet({ a: { load: hooked("a") } });
    await applyTemplate(targetsOf("a"), WITH_HOOK, [""], f.deps);
    expect(f.saves).toEqual([{ id: "a", baseHash: "hash-a", config: { name: "a", webhooks: [{ url: HIDDEN, secret_file: "/s" }], disk_alert_percent: 90, memory_alert_percent: 10, alert_cooldown: "5m" } }]);
  });

  it("omits the version when the agent did not give one, and passes its warnings on", async () => {
    const warning: ConfigIssue = { severity: "warning", path: "notifications", message: "no events are listed" };
    const f = fleet({ a: { load: hooked("a"), save: { ok: true, hash: "n", issues: [warning] } } });
    const result = await applyTemplate(targetsOf("a"), WITH_HOOK, [""], f.deps);
    expect(result).toEqual({ ok: true, results: [{ id: "a", outcome: { status: "applied", warnings: [warning] } }] });
    expect(outcomes(result).a).not.toHaveProperty("version");
  });

  it("reports every kind of failure, and the other servers are still applied", async () => {
    const issue: ConfigIssue = { severity: "error", path: "notifications.webhooks[0]", message: "the secret file does not exist" };
    const f = fleet({
      applied: { load: hooked("applied") },
      invalid: { load: hooked("invalid"), save: { ok: false, kind: "invalid", message: "the file would be invalid", issues: [issue] } },
      conflict: { load: hooked("conflict"), save: { ok: false, kind: "changed", hash: "moved", issues: [] } },
      saveDown: { load: hooked("saveDown"), save: { ok: false, kind: "unreachable", message: "cannot reach the agent: timed out" } },
      loadDown: { load: { kind: "unreachable", reason: "cannot reach the agent: connection refused" } },
      readOnly: { load: { kind: "read-only", reason: "This agent has no apps file: its configuration is read-only." } },
      unchanged: { load: { kind: "ok", notifications: following } },
      noHook: { load: { kind: "ok", notifications: { disk_alert_percent: 50 } } },
      ack: { load: hooked("ack"), save: { ok: false, kind: "needs_acknowledgement", message: "this removes an app", issues: [] } },
      busy: { load: hooked("busy"), save: { ok: false, kind: "busy", message: "a deploy is running", issues: [] } },
      broken: { load: hooked("broken"), save: { ok: false, kind: "error", message: "the agent answered 500" } },
      last: { load: hooked("last") },
    });
    const ids = ["applied", "invalid", "conflict", "saveDown", "loadDown", "readOnly", "unchanged", "noHook", "ack", "busy", "broken", "last"];
    const result = await applyTemplate(targetsOf(...ids), WITH_HOOK, [""], f.deps);

    expect(result).toEqual({
      ok: true,
      results: [
        { id: "applied", outcome: { status: "applied", version: 2, warnings: [] } },
        { id: "invalid", outcome: { status: "refused", kind: "invalid", message: "the file would be invalid", issues: [issue] } },
        { id: "conflict", outcome: { status: "conflict" } },
        { id: "saveDown", outcome: { status: "unreachable", reason: "cannot reach the agent: timed out" } },
        { id: "loadDown", outcome: { status: "unreachable", reason: "cannot reach the agent: connection refused" } },
        { id: "readOnly", outcome: { status: "read-only", reason: "This agent has no apps file: its configuration is read-only." } },
        { id: "unchanged", outcome: { status: "unchanged" } },
        { id: "noHook", outcome: { status: "needs-url", slot: 1 } },
        { id: "ack", outcome: { status: "refused", kind: "needs_acknowledgement", message: "this removes an app", issues: [] } },
        { id: "busy", outcome: { status: "refused", kind: "busy", message: "a deploy is running", issues: [] } },
        { id: "broken", outcome: { status: "refused", kind: "error", message: "the agent answered 500", issues: [] } },
        { id: "last", outcome: { status: "applied", version: 2, warnings: [] } },
      ],
    });
    // Only the servers that had something to write were asked to save: no stale file was forced, nothing was retried.
    expect(f.saves.map((s) => s.id).sort()).toEqual(["ack", "applied", "broken", "busy", "conflict", "invalid", "last", "saveDown"]);
    expect(f.saves.every((s) => s.baseHash === `hash-${s.id}`)).toBe(true);
  });

  it("gives a refusal without a message none, and one with no issues an empty list", async () => {
    const f = fleet({ a: { load: hooked("a"), save: { ok: false, kind: "busy", issues: [] } } });
    const result = await applyTemplate(targetsOf("a"), WITH_HOOK, [""], f.deps);
    expect(result).toEqual({ ok: true, results: [{ id: "a", outcome: { status: "refused", kind: "busy", issues: [] } }] });
    expect(outcomes(result).a).not.toHaveProperty("message");
  });

  it("applies nothing to an empty list of servers and asks nothing", async () => {
    const f = fleet({});
    expect(await applyTemplate([], WITH_HOOK, [URL1], f.deps)).toEqual({ ok: true, results: [] });
    expect(f.log).toEqual([]);
  });
});

describe("the unlock", () => {
  it("is asked exactly once, with the reason, and before any save", async () => {
    const f = fleet({ a: { load: hooked("a") }, b: { load: hooked("b") }, c: { load: hooked("c") }, d: { load: hooked("d") }, e: { load: hooked("e") }, g: { load: hooked("g") } });
    await applyTemplate(targetsOf("a", "b", "c", "d", "e", "g"), WITH_HOOK, [URL1], f.deps);

    expect(f.unlocks).toEqual([SENSITIVE]);
    const at = f.log.indexOf("unlock");
    expect(f.log.filter((l) => l === "unlock")).toHaveLength(1);
    expect(f.log.slice(0, at).every((l) => l.startsWith("load:"))).toBe(true);
    expect(f.log.slice(0, at)).toHaveLength(6);
    expect(f.log.slice(at + 1).every((l) => l.startsWith("save:"))).toBe(true);
    expect(f.log.slice(at + 1)).toHaveLength(6);
  });

  it("is needed by a single sensitive server among others that only change thresholds", async () => {
    const template: NotificationsTemplate = { ...WITH_HOOK };
    const f = fleet({
      thresholds: { load: { kind: "ok", notifications: { disk_alert_percent: 50, webhooks: [{ url: HIDDEN, secret_file: "/s" }] } } },
      moves: { load: hooked("moves") },
    });
    await applyTemplate(targetsOf("thresholds", "moves"), template, [""], f.deps);
    expect(f.unlocks).toEqual([SENSITIVE]);
  });

  it("when it refuses, nothing is saved and the message is the answer", async () => {
    const f = fleet({ a: { load: hooked("a") }, b: { load: hooked("b") } }, "Confirm your password to continue.");
    const result = await applyTemplate(targetsOf("a", "b"), WITH_HOOK, [URL1], f.deps);
    expect(result).toEqual({ ok: false, message: "Confirm your password to continue." });
    expect(f.saves).toEqual([]);
    expect(f.log.filter((l) => l.startsWith("save:"))).toEqual([]);
    expect(f.unlocks).toEqual([SENSITIVE]);
  });

  it("is not asked when only events and thresholds change", async () => {
    const f = fleet({
      a: { load: { kind: "ok", notifications: { telegram: { bot_token_file: "/t", chat_id: "1" }, heartbeat: { url: HIDDEN }, disk_alert_percent: 50 } } },
      b: { load: { kind: "ok" } },
    });
    const result = await applyTemplate(targetsOf("a", "b"), THRESHOLDS, [], f.deps);
    expect(f.unlocks).toEqual([]);
    expect(outcomes(result)).toEqual({ a: { status: "applied", version: 2, warnings: [] }, b: { status: "applied", version: 2, warnings: [] } });
    // The Telegram chat and the heartbeat the servers have are untouched.
    expect(f.saves.find((s) => s.id === "a")?.config).toEqual({
      events: ["app.down"],
      telegram: { bot_token_file: "/t", chat_id: "1" },
      heartbeat: { url: HIDDEN },
      disk_alert_percent: 90,
      memory_alert_percent: 10,
      alert_cooldown: "5m",
    });
  });

  it("is not asked when nothing is written (unchanged, blocked or unreachable servers only)", async () => {
    const f = fleet({
      a: { load: { kind: "ok", notifications: following } },
      b: { load: { kind: "unreachable", reason: "down" } },
      c: { load: { kind: "read-only", reason: "no file" } },
      d: { load: { kind: "ok" } },
    });
    const result = await applyTemplate(targetsOf("a", "b", "c", "d"), WITH_HOOK, [""], f.deps);
    expect(f.unlocks).toEqual([]);
    expect(f.saves).toEqual([]);
    expect(outcomes(result)).toEqual({
      a: { status: "unchanged" },
      b: { status: "unreachable", reason: "down" },
      c: { status: "read-only", reason: "no file" },
      d: { status: "needs-url", slot: 1 },
    });
  });
});

describe("concurrency", () => {
  it(`reads and saves at most ${APPLY_CONCURRENCY} servers at once, and keeps the results in the order of the targets`, async () => {
    const ids = Array.from({ length: 11 }, (_, i) => `s${i}`);
    const f = fleet(Object.fromEntries(ids.map((id) => [id, { load: hooked(id) }])));
    const result = await applyTemplate(targetsOf(...ids), WITH_HOOK, [URL1], f.deps);

    expect(APPLY_CONCURRENCY).toBe(4);
    expect(f.peak).toEqual({ load: 4, save: 4 });
    expect(f.saves).toHaveLength(11);
    expect(result.ok && result.results.map((r) => r.id)).toEqual(ids);
  });

  it("does not stall on fewer servers than the limit", async () => {
    const f = fleet({ a: { load: hooked("a") }, b: { load: hooked("b") } });
    await applyTemplate(targetsOf("a", "b"), WITH_HOOK, [URL1], f.deps);
    expect(f.peak).toEqual({ load: 2, save: 2 });
  });
});

describe("secrets", () => {
  it("scrubs every occurrence, and ignores an empty secret", () => {
    expect(scrubSecrets(`a ${URL1} b ${URL1}`, [URL1])).toBe("a [redacted] b [redacted]");
    expect(scrubSecrets("nothing to hide", [URL1, ""])).toBe("nothing to hide");
    expect(scrubSecrets("x https://a.example/1 y https://b.example/2", ["https://a.example/1", "https://b.example/2"])).toBe("x [redacted] y [redacted]");
  });

  it("keeps the typed URL out of every result and message, even when the agent echoes it back", async () => {
    const f = fleet({
      ok: { load: hooked("ok"), save: { ok: true, hash: "n", version: 3, issues: [{ severity: "warning", path: "notifications.webhooks[0]", message: `${URL1} answered slowly` }] } },
      invalid: {
        load: hooked("invalid"),
        save: { ok: false, kind: "invalid", message: `the url ${URL1} is not allowed`, issues: [{ severity: "error", path: "notifications.webhooks[0].url", message: `cannot use ${URL1}` }] },
      },
      down: { load: hooked("down"), save: { ok: false, kind: "unreachable", message: `cannot reach the agent while sending ${URL1}` } },
      broken: { load: hooked("broken"), save: { ok: false, kind: "error", message: `500 for ${URL1}` } },
    });
    const result = await applyTemplate(targetsOf("ok", "invalid", "down", "broken"), WITH_HOOK, [URL1], f.deps);

    expect(result).toEqual({
      ok: true,
      results: [
        { id: "ok", outcome: { status: "applied", version: 3, warnings: [{ severity: "warning", path: "notifications.webhooks[0]", message: "[redacted] answered slowly" }] } },
        {
          id: "invalid",
          outcome: {
            status: "refused",
            kind: "invalid",
            message: "the url [redacted] is not allowed",
            issues: [{ severity: "error", path: "notifications.webhooks[0].url", message: "cannot use [redacted]" }],
          },
        },
        { id: "down", outcome: { status: "unreachable", reason: "cannot reach the agent while sending [redacted]" } },
        { id: "broken", outcome: { status: "refused", kind: "error", message: "500 for [redacted]", issues: [] } },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("SECRET1");
    expect(f.unlocks.join()).not.toContain("SECRET1");
  });

  it("scrubs the URL as it was typed or trimmed, for every slot", async () => {
    const template: NotificationsTemplate = { ...WITH_HOOK, webhooks: [{ secretFile: "/a" }, { secretFile: "/b" }] };
    const f = fleet({
      a: { load: { kind: "ok" }, save: { ok: false, kind: "invalid", message: "bad https://one.example/1 and https://two.example/2", issues: [] } },
    });
    const result = await applyTemplate(targetsOf("a"), template, ["  https://one.example/1 ", "https://two.example/2"], f.deps);
    expect(outcomes(result).a).toEqual({ status: "refused", kind: "invalid", message: "bad [redacted] and [redacted]", issues: [] });
    expect(f.saves[0].config.webhooks).toEqual([
      { url: "https://one.example/1", secret_file: "/a" },
      { url: "https://two.example/2", secret_file: "/b" },
    ]);
  });
});
