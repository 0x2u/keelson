import { describe, expect, it } from "vitest";
import type { DeploymentPhase, PhaseName } from "@/lib/agent-types";
import { initialDeployMode } from "@/lib/build-now-core";
import { failureTitle, pipeline, servingSentence, stepDuration, type PipelineSource } from "@/lib/pipeline-core";

const T0 = Date.parse("2026-11-02T10:00:00Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const phase = (name: PhaseName, status: DeploymentPhase["status"], start: number, end?: number): DeploymentPhase => ({
  name,
  status,
  started_at: at(start),
  ...(end === undefined ? {} : { finished_at: at(end) }),
});
const dep = (over: Partial<PipelineSource> = {}): PipelineSource => ({ status: "succeeded", trigger: "api", phases: [], ...over });
const states = (d: PipelineSource) => pipeline(d)?.steps.map((s) => `${s.name}:${s.state}`);

describe("pipeline", () => {
  it("is null for an agent that does not report phases, so the page shows what it always showed", () => {
    expect(pipeline(dep({ phases: undefined }))).toBeNull();
    expect(pipeline(dep({ phases: [] }))).toBeNull();
  });

  it("draws a plain image deploy from release on, with the soak skipped when the app has none", () => {
    const d = dep({ phases: [phase("release", "done", 0, 4), phase("switch", "done", 4, 9), phase("soak", "skipped", 9, 9), phase("live", "done", 9, 10)] });
    expect(states(d)).toEqual(["release:done", "switch:done", "soak:skipped", "live:done"]);
  });

  it("leaves out a phase that does not apply once the deployment succeeded (an in-place app has no soak)", () => {
    expect(states(dep({ phases: [phase("release", "done", 0, 1), phase("switch", "done", 1, 2), phase("live", "done", 2, 3)] }))).toEqual(["release:done", "switch:done", "live:done"]);
  });

  it("draws a build from source from the source on, in pipeline order whatever the order it was sent in", () => {
    const d = dep({ trigger: "build", phases: [phase("build", "done", 5, 60), phase("source", "done", 0, 5), phase("release", "done", 60, 62)] });
    expect(states(d)).toEqual(["source:done", "build:done", "release:done"]);
  });

  it("shows what has not started while it runs, and what was not reached after a failure", () => {
    const running = dep({ status: "running", phases: [phase("release", "done", 0, 4), phase("switch", "running", 4)] });
    expect(states(running)).toEqual(["release:done", "switch:running", "soak:pending", "live:pending"]);
    const failed = dep({ status: "failed", phases: [phase("release", "failed", 0, 4)] });
    expect(states(failed)).toEqual(["release:failed", "switch:notReached", "soak:notReached", "live:notReached"]);
    expect(pipeline(failed)?.failed?.label).toBe("Release");
    expect(pipeline(running)?.running?.label).toBe("Switch");
  });

  it("keeps a restore after a failure in the failed phase: the phases after it are not reached", () => {
    const d = dep({ status: "rolled_back", phases: [phase("release", "done", 0, 4), phase("switch", "failed", 4, 30)] });
    expect(states(d)).toEqual(["release:done", "switch:failed", "soak:notReached", "live:notReached"]);
  });

  it("says Source and Build ran on another server for an image that was sent here", () => {
    const d = dep({ trigger: "transfer", phases: [phase("release", "done", 0, 3), phase("switch", "done", 3, 8)] });
    expect(states(d)).toEqual(["source:elsewhere", "build:elsewhere", "release:done", "switch:done"]);
    expect(pipeline(d)?.steps[0].view).toMatchObject({ tone: "muted", label: "Built on another server" });
    expect(states(dep({ trigger: "api", phases: [phase("release", "done", 0, 3)] }))).toEqual(["release:done"]);
  });

  it("skips the release of a roll back as the agent says, and ignores a phase it does not know", () => {
    const d = dep({ trigger: "rollback", phases: [phase("release", "skipped", 0, 0), phase("switch", "done", 0, 6), { ...phase("live", "done", 6, 7), name: "teleport" as PhaseName }] });
    expect(states(d)).toEqual(["release:skipped", "switch:done"]);
  });
});

describe("stepDuration", () => {
  const steps = pipeline(dep({ status: "running", phases: [phase("release", "done", 0, 4), phase("switch", "running", 4)] }))!.steps;
  it("is how long a finished step took, how long a running one has gone on, and nothing for a step that has not started", () => {
    expect(stepDuration(steps[0])).toBe("4 s");
    expect(stepDuration(steps[1], T0 + 79_000)).toBe("1 min 15 s");
    expect(stepDuration(steps[1])).toBeNull();
    expect(stepDuration(steps[2], T0 + 79_000)).toBeNull();
    expect(stepDuration(pipeline(dep({ trigger: "rollback", phases: [phase("release", "skipped", 0, 0), phase("switch", "done", 0, 5)] }))!.steps[0])).toBeNull();
  });
});

describe("failureTitle", () => {
  it("names the verb and the phase it failed in", () => {
    expect(failureTitle(dep({ status: "failed", phases: [phase("release", "failed", 0, 4)] }))).toBe("Deploy failed in Release");
    expect(failureTitle(dep({ status: "failed", trigger: "rollback", phases: [phase("switch", "failed", 0, 4)] }))).toBe("Roll back failed in Switch");
    expect(failureTitle(dep({ status: "failed", trigger: "promotion", phases: [phase("build", "failed", 0, 4)] }))).toBe("Promote failed in Build");
  });
  it("says what became of a deploy that was rolled back or could not be", () => {
    expect(failureTitle(dep({ status: "rolled_back", phases: [phase("switch", "failed", 0, 4)] }))).toBe("Deploy failed in Switch and was rolled back");
    expect(failureTitle(dep({ status: "rollback_failed", phases: [phase("soak", "failed", 0, 4)] }))).toBe("Deploy failed in Soak and the previous version could not be restored");
  });
  it("is the same without phases, minus the phase, and absent for a deployment that did not fail", () => {
    expect(failureTitle(dep({ status: "failed", phases: undefined }))).toBe("Deploy failed");
    expect(failureTitle(dep({ status: "succeeded" }))).toBeNull();
    expect(failureTitle(dep({ status: "running" }))).toBeNull();
  });
});

describe("servingSentence", () => {
  const some = [phase("release", "failed", 0, 1)];
  it("says the previous version still serves after a failure before the switch", () => {
    expect(servingSentence({ status: "failed", serving_ref: "ghcr.io/acme/shop:v1.2", phases: some })).toBe("The previous version (v1.2) is still serving.");
  });
  it("says nothing serves when the agent knows of nothing", () => {
    expect(servingSentence({ status: "failed", phases: some })).toBe("Nothing is serving.");
    expect(servingSentence({ status: "rollback_failed", phases: some })).toBe("The previous version could not be restored: nothing is known to be serving.");
  });
  it("says the previous version serves again after a roll back of the switch", () => {
    expect(servingSentence({ status: "rolled_back", serving_ref: "r/shop:v1", phases: some })).toBe("The previous version (v1) is serving again.");
  });
  it("claims nothing for an older agent, while it runs or after a success", () => {
    expect(servingSentence({ status: "failed" })).toBeNull();
    expect(servingSentence({ status: "running", phases: some })).toBeNull();
    expect(servingSentence({ status: "succeeded", serving_ref: "r/shop:v2", phases: some })).toBeNull();
  });
});

describe("initialDeployMode", () => {
  it("starts on the latest commit for an app that builds from a repository and can be deployed now", () => {
    expect(initialDeployMode({ blocked: null }, "")).toBe("source");
  });
  it("starts on an image version without a source, with one that is blocked, or from a link that names a tag", () => {
    expect(initialDeployMode(null, "")).toBe("image");
    expect(initialDeployMode({ blocked: "A deployment is running." }, "")).toBe("image");
    expect(initialDeployMode({ blocked: null }, "v1.4.2")).toBe("image");
  });
});
