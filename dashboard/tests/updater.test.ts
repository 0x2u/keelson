import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDir, updaterAvailable, updaterState, writeUpdateRequest } from "@/lib/updater";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "keelson-run-"));
  vi.stubEnv("KEELSON_RUN_DIR", dir);
  vi.stubEnv("KEELSON_UPDATE_CHECK", "");
  vi.stubEnv("KEELSON_DASHBOARD_VERSION", "v0.1.0");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const put = (name: string, content: string) => writeFileSync(path.join(dir, name), content);

describe("the shared directory", () => {
  it("defaults to /run/keelson and follows KEELSON_RUN_DIR", () => {
    expect(runDir()).toBe(dir);
    vi.stubEnv("KEELSON_RUN_DIR", "  ");
    expect(runDir()).toBe("/run/keelson");
  });

  it("offers the update only with the marker, and never with the check off", () => {
    expect(updaterAvailable()).toBe(false);
    put("updater.json", '{"version":1,"installed":true}');
    expect(updaterAvailable()).toBe(true);
    vi.stubEnv("KEELSON_UPDATE_CHECK", "off");
    expect(updaterAvailable()).toBe(false);
  });

  it("reports the files it finds, and nothing for what is missing, garbage or too large", () => {
    const now = Date.parse("2026-11-13T10:00:00Z");
    expect(updaterState(now)).toEqual({ updater: false, version: "v0.1.0", status: null, requested: false });
    put("updater.json", '{"version":1,"installed":true}');
    put("update-status.json", JSON.stringify({ state: "failed", phase: "pulling", from: "v0.1.0", to: "v0.2.0", message: "boom", started_at: "2026-11-13T09:59:00Z", finished_at: "2026-11-13T09:59:30Z" }));
    put("update-request.json", '{"version":"v0.2.0","requested_at":"2026-11-13T09:59:58Z"}');
    expect(updaterState(now)).toMatchObject({ updater: true, requested: true, status: { state: "failed", message: "boom" } });
    put("update-status.json", "x".repeat(100_000));
    expect(updaterState(now).status).toBeNull();
    put("update-status.json", "{");
    expect(updaterState(now).status).toBeNull();
  });
});

describe("writeUpdateRequest", () => {
  it("writes the request file the host reads, world-readable, leaving nothing else behind", () => {
    const old = process.umask(0o077);
    try {
      writeUpdateRequest("v0.2.0", new Date("2026-11-13T10:00:00.000Z"));
    } finally {
      process.umask(old);
    }
    expect(readdirSync(dir)).toEqual(["update-request.json"]);
    const file = path.join(dir, "update-request.json");
    expect(readFileSync(file, "utf8")).toBe('{"version":"v0.2.0","requested_at":"2026-11-13T10:00:00.000Z"}');
    expect(statSync(file).mode & 0o777).toBe(0o644);
  });

  it("replaces an older request in one step", () => {
    put("update-request.json", "old");
    writeUpdateRequest("v0.3.0", new Date("2026-11-13T10:00:00.000Z"));
    expect(JSON.parse(readFileSync(path.join(dir, "update-request.json"), "utf8")).version).toBe("v0.3.0");
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("leaves no temporary file when the folder cannot be written", () => {
    chmodSync(dir, 0o500);
    try {
      expect(() => writeUpdateRequest("v0.2.0", new Date())).toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(readdirSync(dir)).toEqual([]);
  });
});
