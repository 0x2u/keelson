import { describe, expect, it } from "vitest";
import {
  REQUEST_STALE_MS,
  RUN_STALE_MS,
  STALL_MS,
  buildRequest,
  busy,
  checkRequest,
  comparePlain,
  isNewerPlain,
  offersOneClick,
  parseMarker,
  parsePayload,
  parseStatus,
  pendingRequest,
  plainVersion,
  updatePayload,
  updateView,
  type UpdatePayload,
  type UpdateStatus,
} from "@/lib/updater-core";

const NOW = Date.parse("2026-11-13T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

const hostStatus = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ state: "running", phase: "pulling", from: "v0.1.0", to: "v0.2.0", message: "", started_at: iso(NOW), finished_at: "", ...over });

const status = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({ state: "running", phase: "pulling", from: "v0.1.0", to: "v0.2.0", message: "", startedAt: NOW, finishedAt: null, ...over });

const payload = (over: Partial<UpdatePayload> = {}): UpdatePayload => ({ updater: true, version: "v0.1.0", status: null, requested: false, ...over });

describe("plain versions", () => {
  it("accepts only vX.Y.Z", () => {
    expect(plainVersion("v0.2.0")).toEqual([0, 2, 0]);
    expect(plainVersion("v010.002.0003")).toEqual([10, 2, 3]);
    for (const bad of ["0.2.0", "v0.2", "v0.2.0-rc.1", "v0.2.0-4-gabc1234", "v0.2.0-dirty", "v0.2.0 ", " v0.2.0", "v0.2.0\n", "dev", "", "v1.2.3.4", "v-1.2.3", "v1234567890.0.0"]) {
      expect(plainVersion(bad), bad).toBeNull();
    }
  });

  it("compares each component as a number, not as text", () => {
    expect(comparePlain("v0.9.0", "v0.10.0")).toBe(-1);
    expect(comparePlain("v1.0.0", "v0.99.99")).toBe(1);
    expect(comparePlain("v0.2.0", "v0.2.0")).toBe(0);
    expect(comparePlain("v0.02.0", "v0.2.0")).toBe(0);
    expect(comparePlain("v0.2.9", "v0.2.10")).toBe(-1);
    expect(comparePlain("v0.2.0", "dev")).toBeNull();
  });

  it("is newer only when strictly newer and both are plain", () => {
    expect(isNewerPlain("v0.2.0", "v0.1.0")).toBe(true);
    expect(isNewerPlain("v0.10.0", "v0.9.0")).toBe(true);
    expect(isNewerPlain("v0.1.0", "v0.1.0")).toBe(false);
    expect(isNewerPlain("v0.1.0", "v0.2.0")).toBe(false);
    expect(isNewerPlain("v0.2.0-rc.1", "v0.1.0")).toBe(false);
    expect(isNewerPlain("v0.2.0", "dev")).toBe(false);
  });
});

describe("the marker", () => {
  it("is present only for exactly what install.sh writes", () => {
    expect(parseMarker('{"version":1,"installed":true}')).toBe(true);
    expect(parseMarker('{"version":1,"installed":true,"extra":"x"}')).toBe(true);
    for (const bad of [null, "", "{", "[]", "null", '{"version":2,"installed":true}', '{"version":1,"installed":false}', '{"version":"1","installed":true}', '{"version":1,"installed":"true"}', '{"version":1}']) {
      expect(parseMarker(bad), String(bad)).toBe(false);
    }
  });
});

describe("the request", () => {
  it("is exactly the version and the time", () => {
    expect(buildRequest("v0.2.0", new Date("2026-11-13T10:00:00.123Z"))).toBe('{"version":"v0.2.0","requested_at":"2026-11-13T10:00:00.123Z"}');
  });

  it("is pending while recent, and neither a stale nor a garbled one blocks a new request", () => {
    const at = (ms: number) => buildRequest("v0.2.0", new Date(ms));
    expect(pendingRequest(at(NOW - 1000), NOW)).toBe(true);
    expect(pendingRequest(at(NOW - REQUEST_STALE_MS + 1000), NOW)).toBe(true);
    expect(pendingRequest(at(NOW - REQUEST_STALE_MS), NOW)).toBe(false);
    expect(pendingRequest(at(NOW + REQUEST_STALE_MS), NOW)).toBe(false);
    expect(pendingRequest(null, NOW)).toBe(false);
    expect(pendingRequest("garbage", NOW)).toBe(false);
    expect(pendingRequest('{"version":"v0.2.0"}', NOW)).toBe(false);
    expect(pendingRequest('{"requested_at":12}', NOW)).toBe(false);
  });
});

describe("parseStatus", () => {
  it("reads what the host writes", () => {
    expect(parseStatus(hostStatus())).toEqual(status());
    expect(parseStatus(hostStatus({ state: "done", phase: "done", message: "ok", finished_at: iso(NOW + 60_000) }))).toEqual(
      status({ state: "done", phase: "done", message: "ok", finishedAt: NOW + 60_000 }),
    );
  });

  it("treats anything that does not fit as no status", () => {
    for (const bad of [
      null,
      "",
      "not json",
      "[]",
      "null",
      "42",
      hostStatus({ state: "exploded" }),
      hostStatus({ phase: "nope" }),
      hostStatus({ to: "latest" }),
      hostStatus({ to: "v0.2.0-rc.1" }),
      hostStatus({ from: "" }),
      hostStatus({ from: "x".repeat(65) }),
      hostStatus({ message: 5 }),
      hostStatus({ started_at: "yesterday" }),
      hostStatus({ started_at: undefined }),
      hostStatus({ finished_at: "someday" }),
      hostStatus({ state: undefined }),
    ]) {
      expect(parseStatus(bad), String(bad)).toBeNull();
    }
  });

  it("caps the message and flattens control characters", () => {
    const s = parseStatus(hostStatus({ message: `line one\nline\u001b[31m two ${"x".repeat(1000)}` }));
    expect(s?.message.length).toBeLessThanOrEqual(300);
    expect(s?.message).not.toMatch(/[\u0000-\u001f]/);
    expect(s?.message.startsWith("line one line [31m two")).toBe(true);
  });

  it("accepts an absent finished_at as not finished", () => {
    expect(parseStatus(hostStatus({ finished_at: undefined }))?.finishedAt).toBeNull();
  });
});

describe("busy", () => {
  it("is busy for a live run or a waiting request, not for a finished or dead one", () => {
    expect(busy({ status: status({ startedAt: NOW - 1000 }), requested: false }, NOW)).toBe(true);
    expect(busy({ status: null, requested: true }, NOW)).toBe(true);
    expect(busy({ status: null, requested: false }, NOW)).toBe(false);
    for (const state of ["done", "failed", "rolled_back"] as const) expect(busy({ status: status({ state }), requested: false }, NOW), state).toBe(false);
    expect(busy({ status: status({ startedAt: NOW - RUN_STALE_MS }), requested: false }, NOW)).toBe(false);
  });
});

describe("updatePayload", () => {
  it("assembles the answer of the route from the two files", () => {
    const p = updatePayload({ updater: true, version: "v0.1.0", statusText: hostStatus(), requestText: buildRequest("v0.2.0", new Date(NOW - 1000)), now: NOW });
    expect(p).toEqual({ updater: true, version: "v0.1.0", status: status(), requested: true });
  });

  it("answers no status and no request for missing or garbage files", () => {
    expect(updatePayload({ updater: false, version: "dev", statusText: "{", requestText: null, now: NOW })).toEqual({ updater: false, version: "dev", status: null, requested: false });
  });
});

describe("checkRequest", () => {
  const ok = { version: "v0.2.0", running: "v0.1.0", latest: "v0.2.0", payload: payload(), now: NOW };
  const refused = (over: { version?: unknown; running?: string; latest?: string | null; payload?: UpdatePayload }) => {
    const r = checkRequest({ ...ok, ...over });
    return r.ok ? null : r.error;
  };

  it("allows the latest release, newer than the running one", () => {
    expect(checkRequest(ok)).toEqual({ ok: true, version: "v0.2.0" });
  });

  it("refuses without the host side", () => {
    expect(refused({ payload: payload({ updater: false }) })).toMatch(/not set up/);
  });

  it("refuses a version that is not a plain release, whatever else is true", () => {
    for (const version of ["0.2.0", "v0.2.0-rc.1", "v0.2.0; rm -rf /", "../v0.2.0", "latest", "", "v0.2.0\n", undefined, null, 2, { toString: () => "v0.2.0" }]) {
      expect(refused({ version, latest: String(version) }), String(version)).toMatch(/not a release version/);
    }
  });

  it("refuses a dashboard that is not itself a release", () => {
    for (const running of ["dev", "v0.1.0-4-gabc1234", "v0.1.0-dirty", "v0.1.0-rc.1", ""]) expect(refused({ running }), running).toMatch(/not a release/);
  });

  it("refuses the running version, an older one, and compares numerically", () => {
    expect(refused({ version: "v0.1.0", latest: "v0.1.0" })).toMatch(/not newer/);
    expect(refused({ running: "v0.2.0" })).toMatch(/not newer/);
    expect(refused({ version: "v0.1.0", running: "v0.2.0", latest: "v0.1.0" })).toMatch(/not newer/);
    expect(refused({ version: "v0.9.0", running: "v0.10.0", latest: "v0.9.0" })).toMatch(/not newer/);
    expect(checkRequest({ ...ok, version: "v0.10.0", running: "v0.9.0", latest: "v0.10.0" })).toEqual({ ok: true, version: "v0.10.0" });
  });

  it("refuses a version other than the latest release this dashboard knows", () => {
    expect(refused({ version: "v0.3.0" })).toMatch(/latest release is v0.2.0, not v0.3.0/);
    expect(refused({ latest: null })).toMatch(/not known/);
  });

  it("refuses while a run is in progress or a request waits, and allows after a finished or dead one", () => {
    expect(refused({ payload: payload({ status: status({ startedAt: NOW - 1000 }) }) })).toMatch(/already in progress/);
    expect(refused({ payload: payload({ requested: true }) })).toMatch(/already in progress/);
    expect(checkRequest({ ...ok, payload: payload({ status: status({ state: "failed" }) }) }).ok).toBe(true);
    expect(checkRequest({ ...ok, payload: payload({ status: status({ startedAt: NOW - RUN_STALE_MS - 1 }) }) }).ok).toBe(true);
  });
});

describe("offersOneClick", () => {
  it("needs the host side, a newer plain release and a plain running version", () => {
    expect(offersOneClick({ running: "v0.1.0", latest: "v0.2.0", updater: true })).toBe(true);
    expect(offersOneClick({ running: "v0.1.0", latest: "v0.2.0", updater: false })).toBe(false);
    expect(offersOneClick({ running: "v0.2.0", latest: "v0.2.0", updater: true })).toBe(false);
    expect(offersOneClick({ running: "v0.3.0", latest: "v0.2.0", updater: true })).toBe(false);
    expect(offersOneClick({ running: "dev", latest: "v0.2.0", updater: true })).toBe(false);
    expect(offersOneClick({ running: "v0.1.0-4-gabc1234", latest: "v0.2.0", updater: true })).toBe(false);
    expect(offersOneClick({ running: "v0.1.0", latest: null, updater: true })).toBe(false);
    expect(offersOneClick({ running: "v0.1.0", latest: "v0.2.0-rc.1", updater: true })).toBe(false);
  });
});

describe("updateView", () => {
  const target = "v0.2.0";
  const requestedAt = NOW;
  const view = (result: Parameters<typeof updateView>[0]["result"], now = NOW + 5000) => updateView({ target, requestedAt, now, result });
  const answer = (over: Partial<UpdatePayload> = {}) => ({ ok: true as const, payload: payload(over) });

  it("waits for the host while the request is there", () => {
    expect(view(answer({ requested: true }))).toEqual({ kind: "waiting", text: "Waiting for the host to start the update…", polling: true });
    expect(view(answer())).toMatchObject({ kind: "waiting", polling: true });
  });

  it("says what the host is doing", () => {
    expect(view(answer({ status: status({ phase: "downloading" }) }))).toEqual({ kind: "running", text: "Downloading v0.2.0…", polling: true });
    expect(view(answer({ status: status({ phase: "backup" }) })).text).toBe("Copying the database…");
    expect(view(answer({ status: status({ phase: "rolling-back" }) })).text).toMatch(/going back/);
  });

  it("tolerates the restart: a failed fetch is Restarting and keeps polling, before, during and after the host's work", () => {
    expect(view({ ok: false })).toEqual({ kind: "restarting", text: "Restarting…", polling: true });
    expect(view({ ok: false }, NOW + 10 * 60 * 1000).polling).toBe(true);
  });

  it("gives up when nothing settles for fifteen minutes, whether the dashboard is down or the host never starts", () => {
    const late = NOW + STALL_MS + 1;
    expect(view({ ok: false }, late)).toMatchObject({ kind: "stalled", polling: false });
    expect(view(answer({ requested: true }), late)).toMatchObject({ kind: "stalled", polling: false });
    expect(view(answer({ status: status() }), late)).toMatchObject({ kind: "stalled", polling: false });
  });

  it("does not stall a result that is settled", () => {
    const late = NOW + STALL_MS + 1;
    expect(view(answer({ version: "v0.2.0", status: status({ state: "done", phase: "done" }) }), late).kind).toBe("done");
  });

  it("is done only when the dashboard that answers runs the target", () => {
    const done = status({ state: "done", phase: "done", finishedAt: NOW + 60_000 });
    expect(view(answer({ version: "v0.2.0", status: done }))).toEqual({ kind: "done", text: "Updated to v0.2.0", polling: false });
    // The host says done, but the answer still comes from the old dashboard: not done yet.
    expect(view(answer({ version: "v0.1.0", status: done }))).toMatchObject({ kind: "restarting", polling: true });
  });

  it("is not done while the host still runs, even if the new version already answers", () => {
    expect(view(answer({ version: "v0.2.0", status: status({ phase: "starting" }) }))).toMatchObject({ kind: "running", polling: true });
  });

  it("shows a failure with the host's message", () => {
    const failed = status({ state: "failed", phase: "pulling", message: "pull access denied" });
    expect(view(answer({ status: failed }))).toEqual({ kind: "failed", text: "The update did not complete: pull access denied", polling: false });
    expect(view(answer({ status: { ...failed, message: "" } })).text).toBe("The update did not complete.");
  });

  it("shows a rollback with the version back and the cause", () => {
    const back = status({ state: "rolled_back", phase: "done", message: "the new version did not become healthy" });
    expect(view(answer({ status: back }))).toEqual({ kind: "rolled_back", text: "Rolled back to v0.1.0: the new version did not become healthy", polling: false });
  });

  it("does not take the status of an earlier run for this one", () => {
    // An earlier failure, rollback and success of the same target, and a run of another version.
    const before = NOW - 3600_000;
    for (const old of [
      status({ state: "failed", message: "old failure", startedAt: before, finishedAt: before + 30_000 }),
      status({ state: "rolled_back", phase: "done", message: "old rollback", startedAt: before, finishedAt: before + 30_000 }),
      status({ state: "done", phase: "done", startedAt: before, finishedAt: before + 30_000 }),
      status({ state: "failed", to: "v0.1.5", startedAt: NOW + 1000, message: "other version" }),
      status({ state: "done", phase: "done", to: "v0.1.5", startedAt: NOW + 1000 }),
    ]) {
      expect(view(answer({ status: old, requested: true })), JSON.stringify(old)).toMatchObject({ kind: "waiting", polling: true });
    }
  });

  it("does not take an earlier success of the target for this run's even if the old dashboard answers", () => {
    const old = status({ state: "done", phase: "done", startedAt: NOW - 3600_000 });
    expect(view(answer({ version: "v0.1.0", status: old }))).toMatchObject({ kind: "waiting" });
  });

  it("accepts the host's started_at a moment before the request (second resolution)", () => {
    expect(view(answer({ status: status({ startedAt: NOW - 900, state: "failed", message: "x" }) })).kind).toBe("failed");
    expect(view(answer({ status: status({ startedAt: NOW - 6000, state: "failed", message: "x" }) })).kind).toBe("waiting");
  });

  it("trusts the running version when the status file is gone", () => {
    expect(view(answer({ version: "v0.2.0" }))).toEqual({ kind: "done", text: "Updated to v0.2.0", polling: false });
  });
});

describe("parsePayload", () => {
  it("reads what the route sends", () => {
    const sent = JSON.parse(JSON.stringify(payload({ status: status({ state: "done", phase: "done", finishedAt: NOW + 1 }) })));
    expect(parsePayload(sent)).toEqual(payload({ status: status({ state: "done", phase: "done", finishedAt: NOW + 1 }) }));
    expect(parsePayload({ updater: false, version: "dev", status: null, requested: false })).toEqual({ updater: false, version: "dev", status: null, requested: false });
  });

  it("rejects what is not an answer of the route (an error body from a proxy, an old shape)", () => {
    for (const bad of [null, undefined, "x", 3, [], {}, { error: "unauthorized" }, { updater: true, version: "v0.1.0", requested: false }, { updater: "yes", version: "v0.1.0", status: null, requested: false }]) {
      expect(parsePayload(bad), JSON.stringify(bad)).toBeNull();
    }
    const base = { updater: true, version: "v0.1.0", requested: false };
    expect(parsePayload({ ...base, status: "running" })).toBeNull();
    expect(parsePayload({ ...base, status: { ...status(), state: "exploded" } })).toBeNull();
    expect(parsePayload({ ...base, status: { ...status(), startedAt: "now" } })).toBeNull();
    expect(parsePayload({ ...base, status: { ...status(), finishedAt: undefined } })).toBeNull();
  });
});
