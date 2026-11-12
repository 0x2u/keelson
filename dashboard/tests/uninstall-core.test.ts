import { describe, expect, it } from "vitest";
import { busyWork } from "@/lib/uninstall-core";
import type { Deployment, JobStatus } from "@/lib/agent-types";

const dep = (app: string, status: Deployment["status"]) => ({ id: app, app, ref: `${app}:v2`, status, trigger: "api", started_at: "2026-10-20T10:00:00Z" }) as Deployment;
const job = (name: string, running: boolean) => ({ name, running }) as JobStatus;

describe("busyWork", () => {
  it("names the deployments and jobs in flight, and nothing that has finished", () => {
    expect(busyWork([dep("web", "running"), dep("api", "succeeded"), dep("old", "failed")], [job("backup", true), job("cleanup", false)])).toEqual([
      "a deployment of web (web:v2)",
      "the job backup",
    ]);
  });
  it("is empty when the agent is idle, or has no jobs", () => {
    expect(busyWork([dep("web", "succeeded")], null)).toEqual([]);
    expect(busyWork([], [])).toEqual([]);
  });
});
