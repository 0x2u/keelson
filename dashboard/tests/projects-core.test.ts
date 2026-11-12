import { describe, expect, it } from "vitest";
import { HIDDEN, type AppConfig, type AppStatus, type JobStatus } from "@/lib/agent-types";
import { diffVariables, environmentState, groupProjects, jobsOf, nextJob, placementHealth, planPromotion, projectOf, environmentOf, variableCell, type Placement } from "@/lib/projects-core";

const server = (id: string, canDeploy = true) => ({ id, name: `srv-${id}`, canDeploy });
function app(over: Partial<AppStatus> = {}): AppStatus {
  return {
    name: "web",
    image: "ghcr.io/o/web",
    project: "",
    environment: "",
    digest: "sha256:" + "a".repeat(64),
    container: { id: "c", name: "web", image: "ghcr.io/o/web:v1", created: "", tty: false, restart_count: 0, ports: [], state: { status: "running", running: true, paused: false, restarting: false, oom_killed: false, exit_code: 0 } },
    last_deployment: null,
    ...over,
  };
}
const place = (s: ReturnType<typeof server>, a: AppStatus, jobs: JobStatus[] = []): Placement => ({ server: s, app: a, jobs });

describe("defaults", () => {
  it("reads a missing project as the app's name and a missing environment as production", () => {
    expect(projectOf(app({ name: "shop" }))).toBe("shop");
    expect(environmentOf(app())).toBe("production");
    expect(projectOf(app({ project: "shop" }))).toBe("shop");
    expect(environmentOf(app({ environment: "staging" }))).toBe("staging");
  });
});

describe("groupProjects", () => {
  it("puts apps of several servers under one project, production first, then staging, then the rest by name", () => {
    const list = groupProjects([
      place(server("2"), app({ name: "md-dev", project: "shop", environment: "dev" })),
      place(server("2"), app({ name: "md-stg", project: "shop", environment: "staging" })),
      place(server("1"), app({ name: "md", project: "shop", environment: "production" })),
      place(server("1"), app({ name: "blog" })),
    ]);
    expect(list.map((p) => p.name)).toEqual(["blog", "shop"]);
    expect(list[1].environments.map((e) => e.name)).toEqual(["production", "staging", "dev"]);
    expect(list[0].environments[0].name).toBe("production");
  });

  it("keeps every placement of an environment, ordered by server", () => {
    const [p] = groupProjects([place(server("b"), app({ name: "web" })), place(server("a"), app({ name: "web" }))]);
    expect(p.environments[0].placements.map((x) => x.server.id)).toEqual(["a", "b"]);
  });
});

describe("jobsOf and nextJob", () => {
  const job = (name: string, target: string, next?: string, paused = false) => ({ name, kind: "container", target, next_run: next, paused }) as JobStatus;
  it("takes the jobs that run in the app's container, and the soonest unpaused one", () => {
    const jobs = [job("a", "container of web", "2026-10-21T10:00:00Z"), job("b", "container of web", "2026-10-21T09:00:00Z"), job("c", "container of api", "2026-10-21T08:00:00Z"), job("d", "container of web", "2026-10-21T07:00:00Z", true)];
    const mine = jobsOf("web", jobs);
    expect(mine.map((j) => j.name)).toEqual(["a", "b", "d"]);
    expect(nextJob(mine)).toEqual({ name: "b", at: "2026-10-21T09:00:00Z" });
    expect(nextJob([])).toBeNull();
  });
});

describe("placementHealth", () => {
  const withState = (state: Partial<NonNullable<AppStatus["container"]>["state"]>) => {
    const a = app();
    a.container!.state = { ...a.container!.state, ...state };
    return a;
  };
  it("says what an operator needs to know first", () => {
    expect(placementHealth(app({ container: null })).label).toBe("Not deployed");
    expect(placementHealth(withState({ running: false, status: "exited" })).label).toBe("Stopped");
    expect(placementHealth(withState({ running: false, status: "created" })).label).toBe("Created");
    expect(placementHealth(withState({ restarting: true })).label).toBe("Restarting");
    expect(placementHealth(withState({ health: "unhealthy" })).label).toBe("Unhealthy");
    expect(placementHealth(withState({ health: "starting" })).label).toBe("Starting");
    expect(placementHealth(withState({ health: "healthy" }))).toEqual({ tone: "success", label: "Healthy" });
  });
});

describe("environmentState", () => {
  const dep = (status: string) => ({ id: "d", app: "web", ref: "ghcr.io/o/web:v1", status, trigger: "api", started_at: "2026-10-21T10:00:00Z" }) as AppStatus["last_deployment"];
  const stopped = () => {
    const a = app({ last_deployment: dep("succeeded") });
    a.container!.state = { ...a.container!.state, running: false, status: "exited" };
    return a;
  };

  it("is Running while the container serves and the last deployment worked", () => {
    expect(environmentState(app({ last_deployment: dep("succeeded") }))).toEqual({ tone: "success", label: "Running", lastFailed: false });
    expect(environmentState(app())).toMatchObject({ label: "Running", lastFailed: false });
  });

  it("is Deploying while a deployment runs, whatever serves", () => {
    expect(environmentState(app({ last_deployment: dep("running") }))).toMatchObject({ tone: "info", label: "Deploying", live: true });
    expect(environmentState(app({ container: null, last_deployment: dep("running") }))).toMatchObject({ label: "Deploying" });
  });

  it.each(["failed", "rolled_back", "rollback_failed"])("is Running with a warning when the last deployment is %s and the old version still runs", (status) => {
    expect(environmentState(app({ last_deployment: dep(status) }))).toEqual({ tone: "warning", label: "Running", lastFailed: true });
  });

  it("is Down when the container is stopped or unwell, and says why", () => {
    expect(environmentState(stopped())).toMatchObject({ tone: "danger", label: "Down", detail: "Stopped" });
    const unhealthy = app({ last_deployment: dep("succeeded") });
    unhealthy.container!.state = { ...unhealthy.container!.state, health: "unhealthy" };
    expect(environmentState(unhealthy)).toMatchObject({ label: "Down", detail: "Unhealthy" });
  });

  it("is Down when the last deployment worked but no container exists, Error when it failed too", () => {
    expect(environmentState(app({ container: null, last_deployment: dep("succeeded") }))).toMatchObject({ label: "Down", detail: "Nothing is running" });
    expect(environmentState(app({ container: null, last_deployment: dep("failed") }))).toEqual({ tone: "danger", label: "Error", lastFailed: true });
  });

  it("is Not deployed before the first deployment", () => {
    expect(environmentState(app({ container: null, last_deployment: null }))).toEqual({ tone: "muted", label: "Not deployed", lastFailed: false });
  });

  it("calls a container that is starting Starting, not Running", () => {
    const starting = app();
    starting.container!.state = { ...starting.container!.state, health: "starting" };
    expect(environmentState(starting)).toMatchObject({ label: "Starting", detail: "Starting" });
  });
});

describe("planPromotion", () => {
  const staging = place(server("1"), app({ name: "md-stg", environment: "staging" }));
  const prod = place(server("2"), app({ name: "md", environment: "production" }));

  it("promotes the exact digest serving in the source", () => {
    const plan = planPromotion(staging, prod);
    expect(plan).toMatchObject({ ok: true, digest: "sha256:" + "a".repeat(64) });
  });

  it("refuses with a reason a person can act on", () => {
    expect(planPromotion(staging, staging)).toMatchObject({ ok: false, reason: expect.stringMatching(/same app/) });
    expect(planPromotion(staging, place(server("2", false), prod.app))).toMatchObject({ ok: false, reason: expect.stringMatching(/no deploy secret/) });
    expect(planPromotion(place(server("1"), app({ container: null })), prod)).toMatchObject({ ok: false, reason: expect.stringMatching(/Nothing is running/) });
    expect(planPromotion(place(server("1"), app({ digest: "" })), prod)).toMatchObject({ ok: false, reason: expect.stringMatching(/no registry digest/) });
    expect(planPromotion(staging, place(server("2"), app({ name: "md", image: "ghcr.io/o/other" })))).toMatchObject({ ok: false, reason: expect.stringMatching(/different images/) });
  });
});

describe("diffVariables", () => {
  const cfg = (env: Record<string, string>): AppConfig => ({ name: "web", image: "i", env });
  it("sorts every key into the state a reviewer cares about", () => {
    const rows = diffVariables(cfg({ A: "1", B: "2", C: "3", D: HIDDEN, E: "x" }), cfg({ A: "1", B: "9", D: HIDDEN, F: "y" }));
    expect(Object.fromEntries(rows.map((r) => [r.key, r.state]))).toEqual({ A: "same", B: "different", C: "only-a", D: "secret", E: "only-a", F: "only-b" });
  });
  it("does not compare a secret, even against a plain value", () => {
    expect(diffVariables(cfg({ K: HIDDEN }), cfg({ K: "plain" }))[0].state).toBe("secret");
  });
  it("keeps both values of a variable set in both environments, so the view shows it as set on each side and not as missing", () => {
    expect(diffVariables(cfg({ K: HIDDEN }), cfg({ K: HIDDEN }))).toEqual([{ key: "K", state: "secret", a: HIDDEN, b: HIDDEN }]);
    expect(diffVariables(cfg({ K: HIDDEN }), cfg({ K: "plain" }))).toEqual([{ key: "K", state: "secret", a: HIDDEN, b: "plain" }]);
  });
  it("carries the real value of a variable set in both environments, whether equal or different (never a missing side)", () => {
    expect(diffVariables(cfg({ PORT: "80", MODE: "a" }), cfg({ PORT: "80", MODE: "b" }))).toEqual([
      { key: "MODE", state: "different", a: "a", b: "b" },
      { key: "PORT", state: "same", a: "80", b: "80" },
    ]);
  });
  it("leaves the missing side undefined only for a variable one environment does not set", () => {
    const [row] = diffVariables(cfg({ ONLY: "1" }), cfg({}));
    expect(row).toEqual({ key: "ONLY", state: "only-a", a: "1" });
    expect(row.b).toBeUndefined();
  });
});

describe("variableCell: what the variables table shows for one side", () => {
  const cfg = (env: Record<string, string>): AppConfig => ({ name: "web", image: "i", env });
  it("shows the value, hidden for a secret, (empty) for an empty value, and not set only when undefined", () => {
    expect(variableCell("prod")).toBe("prod");
    expect(variableCell(HIDDEN)).toBe("hidden");
    expect(variableCell("")).toBe("(empty)");
    expect(variableCell(undefined)).toBe("not set");
  });
  it("never shows a dash for a variable present on both sides", () => {
    for (const row of diffVariables(cfg({ A: "1", S: HIDDEN, E: "" }), cfg({ A: "2", S: HIDDEN, E: "x" }))) {
      expect(variableCell(row.a)).not.toBe("not set");
      expect(variableCell(row.b)).not.toBe("not set");
    }
  });
});

describe("diffVariables edge cases", () => {
  const cfg = (env: Record<string, string>): AppConfig => ({ name: "web", image: "i", env });
  it("handles an app without env, and a missing app", () => {
    expect(diffVariables(undefined, undefined)).toEqual([]);
    expect(diffVariables({ name: "w", image: "i" }, cfg({ X: "1" }))).toEqual([{ key: "X", state: "only-b", b: "1" }]);
  });
});

describe("promotionView", () => {
  const pl = (environment: string, image: string, digest: string, running = true): Placement => ({
    server: { id: "s", name: "srv", canDeploy: true },
    app: { name: `web-${environment}`, image: "ghcr.io/me/web", project: "web", environment, digest, container: running ? ({ image } as never) : null, last_deployment: null },
    jobs: [],
  });
  const D1 = `sha256:${"1".repeat(64)}`;
  const D2 = `sha256:${"2".repeat(64)}`;
  it("marks staging to production as the deliberate direction and shows both versions", async () => {
    const { promotionView } = await import("@/lib/projects-core");
    const v = promotionView(pl("staging", "ghcr.io/me/web:v4", D2), pl("production", "ghcr.io/me/web:v3", D1));
    expect(v).toEqual({ intoProduction: true, from: "v4", to: "v3", digest: "222222222222", same: false });
  });
  it("keeps production to staging neutral", async () => {
    const { promotionView } = await import("@/lib/projects-core");
    expect(promotionView(pl("production", "ghcr.io/me/web:v3", D1), pl("staging", "ghcr.io/me/web:v4", D2)).intoProduction).toBe(false);
  });
  it("names a version by its digest when the image has no tag, and null when nothing runs", async () => {
    const { promotionView } = await import("@/lib/projects-core");
    const v = promotionView(pl("staging", `ghcr.io/me/web@${D2}`, D2), pl("production", "x", "", false));
    expect(v.from).toBe("222222222222");
    expect(v.to).toBeNull();
  });
  it("notices when the target already runs the image", async () => {
    const { promotionView } = await import("@/lib/projects-core");
    expect(promotionView(pl("staging", "ghcr.io/me/web:v3", D1), pl("production", "ghcr.io/me/web:v3", D1)).same).toBe(true);
  });
});
