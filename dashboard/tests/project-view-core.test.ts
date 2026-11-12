import { describe, expect, it } from "vitest";
import type { AppStatus, Deployment } from "@/lib/agent-types";
import { commitKey } from "@/lib/github-core";
import { groupProjects, type Placement } from "@/lib/projects-core";
import {
  commitsToResolve,
  describeDeployment,
  describeRef,
  environmentRefs,
  environmentView,
  newestDeployments,
  primaryDomain,
  projectView,
  servingDeployment,
  triggerWords,
  type AppSource,
  type ProjectContext,
} from "@/lib/project-view-core";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA2 = "fedcba9876543210fedcba9876543210fedcba98";
const REPO = "acme/shop";
const source = (over: Partial<AppSource> = {}): AppSource => ({ repo: REPO, branch: "main", builtOn: null, started: {}, ...over });

const server = (id: string) => ({ id, name: `srv-${id}`, canDeploy: true });
function dep(over: Partial<Deployment> = {}): Deployment {
  return { id: "d1", app: "shop", ref: `ghcr.io/acme/shop:${SHA}`, status: "succeeded", trigger: "build", started_at: "2026-10-21T10:00:00Z", finished_at: "2026-10-21T10:01:00Z", ...over };
}
function app(over: Partial<AppStatus> = {}): AppStatus {
  return {
    name: "shop",
    image: "ghcr.io/acme/shop",
    project: "shop",
    environment: "production",
    digest: "",
    container: { id: "c", name: "shop", image: `ghcr.io/acme/shop:${SHA}`, created: "", tty: false, restart_count: 0, ports: [], state: { status: "running", running: true, paused: false, restarting: false, oom_killed: false, exit_code: 0 } },
    last_deployment: dep(),
    domains: ["*.shop.example.com", "www.shop.example.com", "shop.example.com"],
    ...over,
  };
}
const place = (id: string, a: AppStatus): Placement => ({ server: server(id), app: a, jobs: [] });
const ctx = (over: Partial<ProjectContext> = {}): ProjectContext => ({ sources: { "1/shop": source() }, commits: {}, deployments: {}, ...over });
const MESSAGE = { [commitKey(REPO, SHA)]: { message: "Fix the cart total", author: "ana", date: "2026-10-21T09:58:00Z" } };

describe("primaryDomain", () => {
  it("is the first address one can open: the operator lists the main one first and a wildcard is not a site", () => {
    expect(primaryDomain(["www.a.com", "a.com"])).toBe("www.a.com");
    expect(primaryDomain(["*.a.com", "app.a.com"])).toBe("app.a.com");
  });
  it("is null when there is none or the agent does not say", () => {
    expect(primaryDomain(undefined)).toBeNull();
    expect(primaryDomain([])).toBeNull();
    expect(primaryDomain(["*.a.com"])).toBeNull();
  });
});

describe("describeRef", () => {
  it("names a commit by its message when it is known, with the short hash and the linked branch", () => {
    expect(describeRef(`ghcr.io/acme/shop:${SHA}`, source(), MESSAGE)).toEqual({ message: "Fix the cart total", version: "0123456", sha: "0123456", branch: "main" });
  });
  it("falls back to the short hash when the message could not be read, and never reads a message of another repository", () => {
    expect(describeRef(`ghcr.io/acme/shop:${SHA}`, source(), {})).toMatchObject({ message: null, version: "0123456" });
    expect(describeRef(`ghcr.io/acme/shop:${SHA}`, source({ repo: "acme/other" }), MESSAGE).message).toBeNull();
  });
  it("matches the repository whatever its letter case", () => {
    expect(describeRef(`x:${SHA}`, source({ repo: "Acme/Shop" }), MESSAGE).message).toBe("Fix the cart total");
  });
  it("does not look up an abbreviated hash, nor say a branch for an app that is not linked", () => {
    expect(describeRef("x:0123456", source(), MESSAGE)).toMatchObject({ message: null, sha: "0123456", branch: "main" });
    expect(describeRef(`x:${SHA}`, undefined, MESSAGE)).toMatchObject({ message: null, sha: "0123456", branch: null });
  });
  it("names a tag or a digest as such", () => {
    expect(describeRef("ghcr.io/acme/shop:v1.4.2", source(), {})).toEqual({ message: null, version: "v1.4.2", sha: null, branch: null });
    expect(describeRef(`ghcr.io/acme/shop@sha256:${"ab".repeat(32)}`, source(), {}).version).toBe("@abababababab");
    expect(describeRef("ghcr.io/acme/shop", source(), {}).version).toBe("latest");
  });
});

describe("triggerWords", () => {
  it("says a push for a build a push started, and the table of labels otherwise", () => {
    expect(triggerWords("build", "push")).toBe("Push");
    expect(triggerWords("transfer", "push")).toBe("Push");
    expect(triggerWords("transfer", "push", "builder-1")).toBe("Push (built on builder-1)");
    expect(triggerWords("build", "dashboard")).toBe("Deployed from source");
    expect(triggerWords("build", undefined)).toBe("Deployed from source");
    expect(triggerWords("transfer", "dashboard", "builder-1")).toBe("Deployed from source (built on builder-1)");
    expect(triggerWords("transfer", undefined)).toBe("Built on another server");
  });
  it("leaves the other triggers to their labels, whatever started the build of that commit", () => {
    expect(triggerWords("rollback", "push")).toBe("Roll back");
    expect(triggerWords("api", undefined)).toBe("Dashboard or API");
  });
});

describe("describeDeployment", () => {
  it("joins the commit, how the build was started, and the machine that built an image it received", () => {
    const view = describeDeployment(dep({ trigger: "transfer" }), source({ builtOn: "builder-1", started: { [SHA]: "push" } }), MESSAGE);
    expect(view).toMatchObject({ id: "d1", status: "succeeded", trigger: "Push (built on builder-1)", triggerCode: "transfer", ref: { message: "Fix the cart total" } });
  });
  it("names the builder only for a deployment that came from one", () => {
    expect(describeDeployment(dep({ trigger: "api" }), source({ builtOn: "builder-1" }), {}).trigger).toBe("Dashboard or API");
    expect(describeDeployment(dep({ trigger: "transfer" }), source({ builtOn: "builder-1" }), {}).trigger).toBe("Deployed from source (built on builder-1)");
  });
  it("carries the phases and what serves after it, for the pipeline", () => {
    const phases = [{ name: "release" as const, status: "done" as const, started_at: "2026-10-21T10:00:00Z" }];
    expect(describeDeployment(dep({ phases, serving_ref: "r/web:v1" }), undefined, {})).toMatchObject({ phases, servingRef: "r/web:v1" });
    expect(describeDeployment(dep(), undefined, {})).not.toHaveProperty("phases");
  });
  it("carries the error of a failed deployment", () => {
    expect(describeDeployment(dep({ status: "failed", error: "health check failed" }), source(), {})).toMatchObject({ status: "failed", error: "health check failed" });
  });
});

describe("servingDeployment", () => {
  const placement = place("1", app());
  it("is the deployment that shipped the running image, even when a newer one succeeded for another", () => {
    const shipped = dep({ id: "old", started_at: "2026-10-21T08:00:00Z" });
    const newer = dep({ id: "new", ref: `ghcr.io/acme/shop:${SHA2}`, started_at: "2026-10-21T09:00:00Z" });
    expect(servingDeployment(place("1", app({ last_deployment: newer })), [newer, shipped])?.id).toBe("old");
  });
  it("is the newest successful one when none shipped the running image (a digest or an image started by hand)", () => {
    const a = dep({ id: "a", ref: "x:1", started_at: "2026-10-21T08:00:00Z" });
    const b = dep({ id: "b", ref: "x:2", started_at: "2026-10-21T09:00:00Z" });
    expect(servingDeployment(place("1", app({ last_deployment: null })), [a, b])?.id).toBe("b");
  });
  it("ignores failed deployments, and is null when nothing runs", () => {
    expect(servingDeployment(place("1", app({ last_deployment: dep({ status: "failed" }) })), [dep({ id: "ok", started_at: "2026-10-20T10:00:00Z" })])?.id).toBe("ok");
    expect(servingDeployment(place("1", app({ container: null })), [dep()])).toBeNull();
  });
  it("falls back to the app's own last deployment when the history was not loaded", () => {
    expect(servingDeployment(placement, undefined)?.id).toBe("d1");
  });
});

describe("environmentView", () => {
  const [shop] = groupProjects([place("1", app())]);

  it("shows what serves, its commit, the address and where it runs", () => {
    const view = environmentView(shop.environments[0], ctx({ commits: MESSAGE }));
    expect(view).toMatchObject({
      name: "production",
      app: "shop",
      href: "/servers/1/apps/shop",
      domain: "www.shop.example.com",
      domains: ["www.shop.example.com", "shop.example.com"],
      serving: { message: "Fix the cart total", sha: "0123456" },
      serves: true,
      latest: { id: "d1" },
      deployed: { id: "d1" },
      state: { label: "Running" },
      variablesBehind: false,
    });
    expect(view.servers.map((s) => s.name)).toEqual(["srv-1"]);
  });

  it("keeps what serves apart from a latest deployment that failed", () => {
    const failed = dep({ id: "d2", status: "failed", ref: `ghcr.io/acme/shop:${SHA2}`, started_at: "2026-10-21T11:00:00Z", error: "boom" });
    const [p] = groupProjects([place("1", app({ last_deployment: failed }))]);
    const view = environmentView(p.environments[0], ctx({ deployments: { "1/shop": [failed, dep()] } }));
    expect(view.state).toMatchObject({ label: "Running", lastFailed: true });
    expect(view.serving?.sha).toBe("0123456");
    expect(view.latest).toMatchObject({ id: "d2", status: "failed", error: "boom" });
    expect(view.deployed?.id).toBe("d1");
  });

  it("keeps the image of a stopped container as the last version that ran, without saying it serves", () => {
    const stopped = app();
    stopped.container!.state = { ...stopped.container!.state, running: false, status: "exited" };
    const [p] = groupProjects([place("1", stopped)]);
    expect(environmentView(p.environments[0], ctx())).toMatchObject({ serves: false, serving: { sha: "0123456" }, state: { label: "Down" } });
    const [none] = groupProjects([place("1", app({ container: null }))]);
    expect(environmentView(none.environments[0], ctx())).toMatchObject({ serves: false, serving: null });
  });

  it("says variables are behind when they were saved after the serving deployment started", () => {
    const [p] = groupProjects([place("1", app({ env_changed_at: "2026-10-21T12:00:00Z" }))]);
    expect(environmentView(p.environments[0], ctx({ deployments: { "1/shop": [dep()] } })).variablesBehind).toBe(true);
    expect(environmentView(p.environments[0], ctx()).variablesBehind).toBe(false);
  });

  it("has nothing serving and no address for an app that was never deployed", () => {
    const [p] = groupProjects([place("1", app({ container: null, last_deployment: null, domains: undefined }))]);
    expect(environmentView(p.environments[0], ctx())).toMatchObject({ serving: null, deployed: null, latest: null, domain: null, domains: [], state: { label: "Not deployed" } });
  });

  it("names every server of an environment that runs on several, and links the first", () => {
    const [p] = groupProjects([place("2", app()), place("1", app())]);
    const view = environmentView(p.environments[0], ctx());
    expect(view.servers.map((s) => s.id)).toEqual(["1", "2"]);
    expect(view.href).toBe("/servers/1/apps/shop");
  });
});

describe("projectView", () => {
  it("is judged by production, with the repository of whichever app is linked", () => {
    const [p] = groupProjects([place("1", app({ name: "shop-test", environment: "test" })), place("1", app({ name: "shop", environment: "" }))]);
    const view = projectView(p, ctx({ sources: { "1/shop-test": source({ repo: "acme/linked" }) } }));
    expect(view).toMatchObject({ name: "shop", href: "/projects/shop", repo: "acme/linked" });
    expect(view.primary.name).toBe("production");
    expect(view.environments.map((e) => e.name)).toEqual(["production", "test"]);
  });
  it("is judged by its first environment when it has no production", () => {
    const [p] = groupProjects([place("1", app({ name: "shop-test", environment: "test" }))]);
    expect(projectView(p, ctx({ sources: {} }))).toMatchObject({ repo: null, primary: { name: "test" } });
  });
  it("encodes the name in its address", () => {
    const [p] = groupProjects([place("1", app({ project: "a b" }))]);
    expect(projectView(p, ctx()).href).toBe("/projects/a%20b");
  });
});

describe("commitsToResolve", () => {
  const sources = { "1/shop": source(), "1/other": source({ repo: "acme/other" }) };
  it("asks once for each full commit of an app that is linked to a repository", () => {
    expect(
      commitsToResolve(
        [
          { serverId: "1", app: "shop", ref: `x:${SHA}` },
          { serverId: "1", app: "shop", ref: `y:${SHA}` },
          { serverId: "1", app: "other", ref: `x:${SHA}` },
        ],
        sources,
      ),
    ).toEqual([
      { repo: REPO, sha: SHA },
      { repo: "acme/other", sha: SHA },
    ]);
  });
  it("skips tags, digests, abbreviated hashes and apps that are not linked", () => {
    expect(
      commitsToResolve(
        [
          { serverId: "1", app: "shop", ref: "x:v1" },
          { serverId: "1", app: "shop", ref: `x@sha256:${"a".repeat(64)}` },
          { serverId: "1", app: "shop", ref: "x:0123456" },
          { serverId: "2", app: "shop", ref: `x:${SHA}` },
        ],
        sources,
      ),
    ).toEqual([]);
  });
});

describe("environmentRefs", () => {
  it("is what serves and the latest deployment, of the environment's first app", () => {
    const [p] = groupProjects([place("1", app({ last_deployment: dep({ ref: `x:${SHA2}` }) }))]);
    expect(environmentRefs(p.environments[0])).toEqual([
      { serverId: "1", app: "shop", ref: `ghcr.io/acme/shop:${SHA}` },
      { serverId: "1", app: "shop", ref: `x:${SHA2}` },
    ]);
  });
  it("has nothing for an app that never ran", () => {
    const [p] = groupProjects([place("1", app({ container: null, last_deployment: null }))]);
    expect(environmentRefs(p.environments[0])).toEqual([]);
  });
});

describe("newestDeployments", () => {
  const at = (id: string, hour: number) => dep({ id, started_at: `2026-10-21T${String(hour).padStart(2, "0")}:00:00Z` });
  it("merges the deployments of environments, newest first, and cuts the list", () => {
    const entries = newestDeployments(
      [
        { server: server("1"), app: "shop", environment: "production", deployments: [at("p2", 12), at("p1", 8)] },
        { server: server("2"), app: "shop", environment: "staging", deployments: [at("s2", 11), at("s1", 7)] },
      ],
      3,
    );
    expect(entries.map((e) => e.deployment.id)).toEqual(["p2", "s2", "p1"]);
    expect(entries.map((e) => e.environment)).toEqual(["production", "staging", "production"]);
    expect(entries[1].server.id).toBe("2");
  });
});
