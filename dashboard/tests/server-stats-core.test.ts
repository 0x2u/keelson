import { describe, expect, it } from "vitest";
import type { SystemInfo } from "@/lib/agent-types";
import { formatBytes, OFFLINE, parseBuildMemory, ramFit, statsFromSystem, statsSummary, type ServerStats } from "@/lib/server-stats-core";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

const system = (host: SystemInfo["host"]): SystemInfo => ({ time: "2026-01-01T00:00:00Z", host });

describe("statsFromSystem", () => {
  it("keeps what the agent reported and leaves out what it did not", () => {
    expect(statsFromSystem(system({ cpus: 2, load: { one: 0.4, five: 0.3, fifteen: 0.2 }, memory: { total: 4 * GB, available: 3 * GB, swap_total: 0, swap_free: 0 }, disk: { path: "/", total: 40 * GB, free: 24 * GB } }))).toEqual({
      online: true,
      cpus: 2,
      load1: 0.4,
      memTotal: 4 * GB,
      memAvailable: 3 * GB,
      diskTotal: 40 * GB,
      diskFree: 24 * GB,
    });
    expect(statsFromSystem(system({ cpus: 1 }))).toEqual({ online: true, cpus: 1 });
  });

  it("is offline for an agent that did not answer or is too old to say", () => {
    expect(statsFromSystem(null)).toEqual(OFFLINE);
    expect(statsSummary(OFFLINE)).toBe("not answering");
  });
});

describe("formatBytes", () => {
  it("writes gigabytes with a decimal below ten, whole above, and megabytes below one", () => {
    expect(formatBytes(2.84 * GB)).toBe("2.8 GB");
    expect(formatBytes(24 * GB)).toBe("24 GB");
    expect(formatBytes(640 * MB)).toBe("640 MB");
    expect(formatBytes(-5)).toBe("0 MB");
  });
});

describe("parseBuildMemory", () => {
  it("reads the agent's sizes and falls back to its default of 2g", () => {
    expect(parseBuildMemory("3g")).toBe(3 * GB);
    expect(parseBuildMemory("512m")).toBe(512 * MB);
    expect(parseBuildMemory("2GiB")).toBe(2 * GB);
    expect(parseBuildMemory("1048576")).toBe(1048576);
    expect(parseBuildMemory(undefined)).toBe(2 * GB);
    expect(parseBuildMemory("lots")).toBe(2 * GB);
  });
});

describe("ramFit", () => {
  const server = (available: number, total = 4 * GB): ServerStats => ({ online: true, memTotal: total, memAvailable: available });

  it("says short when less memory than the job needs is available, tight when it leaves little, ok otherwise", () => {
    expect(ramFit(server(2 * GB), 3 * GB)).toBe("short");
    expect(ramFit(server(3.2 * GB), 3 * GB)).toBe("tight");
    expect(ramFit(server(6 * GB, 8 * GB), 3 * GB)).toBe("ok");
  });

  it("does not guess without numbers", () => {
    expect(ramFit(OFFLINE, GB)).toBe("unknown");
    expect(ramFit({ online: true }, GB)).toBe("unknown");
  });
});

describe("statsSummary", () => {
  it("is one line, leaving out what is missing", () => {
    expect(statsSummary({ online: true, cpus: 4, load1: 0.42, memTotal: 8 * GB, memAvailable: 5.5 * GB, diskFree: 60 * GB })).toBe("4 CPUs · load 0.4 · 5.5 GB of 8.0 GB RAM free · 60 GB disk free");
    expect(statsSummary({ online: true, cpus: 1 })).toBe("1 CPU");
  });
});
