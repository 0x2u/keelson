import { describe, expect, it } from "vitest";
import type { AppStatus } from "@/lib/agent-types";
import { projectDots } from "@/lib/project-dot-core";

const RUNNING = { status: "running", running: true, paused: false, restarting: false, oom_killed: false, exit_code: 0 };
const STOPPED = { status: "exited", running: false, paused: false, restarting: false, oom_killed: false, exit_code: 1 };

function app(name: string, over: Partial<AppStatus> = {}, state = RUNNING): AppStatus {
  return {
    name,
    image: `ghcr.io/o/${name}`,
    project: "",
    environment: "",
    digest: "",
    container: { id: "c", name, image: `ghcr.io/o/${name}:v1`, created: "", tty: false, restart_count: 0, ports: [], state },
    last_deployment: null,
    ...over,
  } as AppStatus;
}

const server = (id: string) => ({ id, name: `srv-${id}` });

describe("the sidebar's dot for a project", () => {
  it("lists the projects of every server's apps alphabetically, each with its worst environment", () => {
    const dots = projectDots([
      { server: server("1"), apps: [app("web", { project: "shop" }), app("blog")] },
      { server: server("2"), apps: [app("web-staging", { project: "shop", environment: "staging" }, STOPPED)] },
    ]);
    expect(dots.map((d) => d.name)).toEqual(["blog", "shop"]);
    expect(dots[0]).toMatchObject({ tone: "success" });
    // Production runs but staging is down: the project's dot is the worse of the two.
    expect(dots[1]).toMatchObject({ tone: "danger" });
    expect(dots[1].label).not.toBe("");
  });

  it("is grey for a project nothing runs in yet", () => {
    const dots = projectDots([{ server: server("1"), apps: [app("web", { container: null })] }]);
    expect(dots).toEqual([expect.objectContaining({ name: "web", tone: "muted" })]);
  });

  it("leaves out a server that did not answer", () => {
    expect(projectDots([{ server: server("1"), apps: null }, { server: server("2") }])).toEqual([]);
  });
});
