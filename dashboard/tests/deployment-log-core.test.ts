import { describe, expect, it } from "vitest";
import type { DeploymentEvent, DeploymentPhase, PhaseName } from "@/lib/agent-types";
import { groupByPhase, splitOutput, startsOpen } from "@/lib/deployment-log-core";

const ev = (seq: number, level: DeploymentEvent["level"], message: string): DeploymentEvent => ({ seq, time: "2026-10-23T10:00:00Z", level, message });

describe("splitOutput", () => {
  it("keeps the agent's steps and the container's output apart, in order", () => {
    const { steps, output } = splitOutput([ev(1, "info", "pulling"), ev(2, "error", "health check failed"), ev(3, "output", "boom"), ev(4, "output", "at main.js:1")]);
    expect(steps.map((e) => e.seq)).toEqual([1, 2]);
    expect(output.map((e) => e.message)).toEqual(["boom", "at main.js:1"]);
  });
  it("returns no output block for an older agent that never records it", () => {
    expect(splitOutput([ev(1, "info", "a")]).output).toEqual([]);
  });
});

const inPhase = (seq: number, phase: PhaseName | undefined, message = `line ${seq}`, level: DeploymentEvent["level"] = "info"): DeploymentEvent => ({ ...ev(seq, level, message), ...(phase ? { phase } : {}) });

describe("groupByPhase", () => {
  it("is null when no line says its phase: an older agent's log stays one flat list", () => {
    expect(groupByPhase([ev(1, "info", "a"), ev(2, "warn", "b")])).toBeNull();
    expect(groupByPhase([])).toBeNull();
  });
  it("groups by phase in pipeline order, keeps the order of the lines, and puts what belongs to none last as Other", () => {
    const sections = groupByPhase([inPhase(1, undefined), inPhase(2, "build"), inPhase(3, "source"), inPhase(4, "build"), inPhase(5, "switch"), inPhase(6, undefined)])!;
    expect(sections.map((s) => [s.label, s.events.map((e) => e.seq)])).toEqual([
      ["Source", [3]],
      ["Build", [2, 4]],
      ["Switch", [5]],
      ["Other", [1, 6]],
    ]);
  });
  it("lists only the phases that have lines, and treats a phase it does not know as Other", () => {
    const sections = groupByPhase([inPhase(1, "release"), { ...inPhase(2, undefined), phase: "teleport" as PhaseName }])!;
    expect(sections.map((s) => s.label)).toEqual(["Release", "Other"]);
  });
});

describe("startsOpen", () => {
  const phases: DeploymentPhase[] = [
    { name: "release", status: "done", started_at: "2026-11-02T10:00:00Z", finished_at: "2026-11-02T10:00:04Z" },
    { name: "switch", status: "failed", started_at: "2026-11-02T10:00:04Z", finished_at: "2026-11-02T10:00:09Z" },
  ];
  const sections = groupByPhase([inPhase(1, "release"), inPhase(2, "switch"), inPhase(3, "soak")])!;
  const open = (live: PhaseName | null) => sections.map((s) => startsOpen(s, phases, live));
  it("opens the failed phase and closes the others", () => {
    expect(open(null)).toEqual([false, true, false]);
  });
  it("opens the phase of the newest line while it is followed live, even before the pipeline knows of it", () => {
    expect(open("soak")).toEqual([false, true, true]);
  });
  it("opens Other only when it holds an error", () => {
    const quiet = groupByPhase([inPhase(1, "release"), inPhase(2, undefined)])!;
    const loud = groupByPhase([inPhase(1, "release"), inPhase(2, undefined, "boom", "error")])!;
    expect(startsOpen(quiet[1], undefined, null)).toBe(false);
    expect(startsOpen(loud[1], undefined, null)).toBe(true);
  });
});
