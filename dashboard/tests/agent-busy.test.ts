import { beforeEach, describe, expect, it, vi } from "vitest";

let agent: { deployments: () => Promise<unknown[]>; jobs: () => Promise<unknown[]> };
vi.mock("server-only", () => ({}));
vi.mock("@/lib/agent", async () => ({
  AgentError: class AgentError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
  agentFor: () => agent,
}));

const { currentlyBusy } = await import("@/lib/agent-busy");
const { AgentError } = await import("@/lib/agent");
const server = { id: "s", name: "vps-1" } as never;

beforeEach(() => {
  agent = { deployments: async () => [], jobs: async () => [] };
});

describe("what is running on an agent that is about to be replaced", () => {
  it("lists a deployment that is under way and a job that is running", async () => {
    agent = {
      deployments: async () => [{ id: "d1", app: "web", status: "running", ref: "o/web:v2" }],
      jobs: async () => [{ name: "backup", running: true }],
    };
    const { reachable, busy } = await currentlyBusy(server);
    expect(reachable).toBe(true);
    expect(busy.join(" ")).toMatch(/web/);
    expect(busy.join(" ")).toMatch(/backup/);
  });

  it("is empty when nothing runs, and says unreachable only for a network failure", async () => {
    expect(await currentlyBusy(server)).toEqual({ reachable: true, busy: [] });
    agent = { deployments: async () => { throw new AgentError(404, "no route"); }, jobs: async () => [] };
    expect(await currentlyBusy(server)).toEqual({ reachable: true, busy: [] });
    agent = { deployments: async () => { throw new AgentError(0, "refused"); }, jobs: async () => [] };
    expect(await currentlyBusy(server)).toEqual({ reachable: false, busy: [] });
  });
});
