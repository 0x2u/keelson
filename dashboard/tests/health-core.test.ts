import { describe, expect, it } from "vitest";
import { assess, formatUptime, loadTone, usageTone } from "@/lib/health-core";
import type { Container, SystemInfo } from "@/lib/agent-types";

const GIB = 1024 ** 3;

function system(over: Partial<SystemInfo["host"]> = {}, rest: Partial<SystemInfo> = {}): SystemInfo {
  return {
    time: "2026-10-20T10:00:00Z",
    host: {
      cpus: 2,
      load: { one: 0.3, five: 0.3, fifteen: 0.3 },
      memory: { total: 4 * GIB, available: 3 * GIB, swap_total: 0, swap_free: 0 },
      disk: { path: "/", total: 100 * GIB, free: 60 * GIB },
      ...over,
    },
    engine: { name: "vps", version: "27", os: "Debian", cpus: 2, mem_total: 4 * GIB, root_dir: "/var/lib/docker", containers: 1, running: 1, images: 1 },
    ...rest,
  };
}

describe("usage thresholds", () => {
  it("warns from 85% and alarms from 95%", () => {
    expect(usageTone(84, 100)).toBe("success");
    expect(usageTone(85, 100)).toBe("warning");
    expect(usageTone(95, 100)).toBe("danger");
    expect(usageTone(1, 0)).toBe("muted");
  });
  it("reads load against the CPU count", () => {
    expect(loadTone(1.9, 2)).toBe("success");
    expect(loadTone(2, 2)).toBe("warning");
    expect(loadTone(4, 2)).toBe("danger");
  });
});

describe("formatUptime", () => {
  it("keeps the two largest units", () => {
    expect(formatUptime(42 * 60 + 10)).toBe("42 min");
    expect(formatUptime(3 * 3600 + 5 * 60)).toBe("3 h 5 min");
    expect(formatUptime(12 * 86400 + 3 * 3600 + 59 * 60)).toBe("12 d 3 h");
  });
});

describe("assess", () => {
  it("is fine when nothing is tight", () => {
    expect(assess(system(), [])).toEqual({ tone: "success", reasons: [] });
  });

  it("puts the worst problem first and names every one", () => {
    const a = assess(system({ disk: { path: "/", total: 100, free: 3 }, memory: { total: 100, available: 10, swap_total: 0, swap_free: 0 } }), []);
    expect(a.tone).toBe("danger");
    expect(a.reasons).toEqual(["Disk 97% full", "Memory 90% used"]);
  });

  it("reports an engine that does not answer, and leaves out what it could not read", () => {
    const a = assess(system({ disk: undefined, memory: undefined, load: undefined }, { engine: undefined, engine_error: "docker engine error" }), undefined);
    expect(a).toEqual({ tone: "danger", reasons: ["Docker does not answer"] });
  });

  it("flags unhealthy and restarting containers, not stopped ones", () => {
    const c = (state: string, status: string) => ({ state, status }) as Container;
    const a = assess(system(), [c("running", "Up 2 minutes (unhealthy)"), c("restarting", "Restarting (1) 3 seconds ago"), c("exited", "Exited (0) 1 hour ago"), c("running", "Up 1 hour (healthy)")]);
    expect(a.reasons).toEqual(["2 containers unhealthy or restarting"]);
  });

  it("flags a stopped container that keelson manages for an app, but not an ad hoc or one-off one", () => {
    const c = (state: string, labels: Record<string, string>) => ({ state, status: state === "exited" ? "Exited (3) 1 hour ago" : "Up 1 hour", labels }) as Container;
    const a = assess(system(), [c("exited", { "keelson.app": "shop" }), c("exited", {}), c("exited", { "keelson.app": "shop", "keelson.release": "true" }), c("exited", { "keelson.app": "shop", "keelson.job": "true" })]);
    expect(a).toEqual({ tone: "danger", reasons: ["1 app container stopped"] });
  });
});
