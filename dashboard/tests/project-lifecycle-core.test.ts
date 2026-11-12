import { describe, expect, it } from "vitest";
import type { AppConfig } from "@/lib/agent-types";
import { fileEntities } from "@/lib/config-labels-core";
import {
  environmentAppName,
  labelEdits,
  nameIssue,
  planAddEnvironment,
  planRenameProject,
  renameCountsText,
  renameFacts,
  serverChoices,
  type AddEnvironmentInput,
  type CopySource,
  type RenameServerFacts,
} from "@/lib/project-lifecycle-core";

const s1 = { id: "s1", name: "vps-1", canDeploy: true };
const s2 = { id: "s2", name: "vps-2", canDeploy: true };
const ro = { id: "s3", name: "vps-3", canDeploy: false };

const production: AppConfig = {
  name: "shop",
  environment: "production",
  image: "ghcr.io/acme/shop",
  env: { API_KEY: "secret" },
  env_file: "/etc/shop.env",
  domains: ["shop.example.com"],
  command: ["node", "server.js"],
  port: 3000,
  volumes: ["shop-data:/data"],
  health_path: "/healthz",
  release: { steps: [{ name: "migrate", host: ["node", "migrate.js"] }] },
  database: { password_file: "/var/lib/keelson/postgres/roles/shop" },
  previews: { domain: "pr-{pr}-shop.example.com" },
  source: { repo: "acme/shop", branch: "main" },
  restart: "unless-stopped",
};
const source = (over: Partial<CopySource> = {}): CopySource => ({ server: s1, app: { name: "shop", image: "ghcr.io/acme/shop" }, config: production, ...over });

const input = (over: Partial<AddEnvironmentInput> = {}): AddEnvironmentInput => ({
  project: "shop",
  environment: "staging",
  server: s2,
  from: source(),
  existingEnvironments: ["production"],
  existingAppNames: ["shop"],
  ...over,
});

function plan(over: Partial<AddEnvironmentInput> = {}) {
  const p = planAddEnvironment(input(over));
  if (!p.ok) throw new Error(p.reason);
  return p;
}

describe("nameIssue", () => {
  it("accepts what the agent accepts and says what is wrong otherwise", () => {
    expect(nameIssue("environment", "pr-12")).toBeNull();
    expect(nameIssue("environment", "")).not.toBeNull();
    expect(nameIssue("project", "My Shop")).not.toBeNull();
    expect(nameIssue("project", "-shop")).not.toBeNull();
    expect(nameIssue("project", "a".repeat(64))).not.toBeNull();
    expect(nameIssue("project", "a".repeat(63))).toBeNull();
  });
});

describe("serverChoices", () => {
  const servers = [
    { ...s2, transport: "direct" as const, serves: false },
    { ...ro, transport: "direct" as const, serves: false },
    { id: "m", name: "laptop", canDeploy: true, transport: "relay" as const, serves: false },
    { ...s1, transport: "direct" as const, serves: false },
    { id: "r", name: "relay-vps", canDeploy: true, transport: "relay" as const, serves: true },
  ];
  it("lists the project's servers first, then the others by name", () => {
    expect(serverChoices(servers, ["s2"]).map((c) => c.id)).toEqual(["s2", "m", "r", "s1", "s3"]);
    expect(serverChoices(servers, []).map((c) => c.id)).toEqual(["m", "r", "s1", "s2", "s3"]);
  });
  it("keeps what cannot be used, disabled, with a reason", () => {
    const choices = serverChoices(servers, ["s1"]);
    expect(choices.find((c) => c.id === "s1")).toMatchObject({ enabled: true, inProject: true });
    expect(choices.find((c) => c.id === "s3")).toMatchObject({ enabled: false });
    expect(choices.find((c) => c.id === "s3")?.reason).toBeTruthy();
    expect(choices.find((c) => c.id === "m")).toMatchObject({ enabled: false });
    expect(choices.find((c) => c.id === "m")?.reason).toBeTruthy();
  });
  it("offers a server that connects out and runs apps like a direct one, and not the one that does not serve traffic", () => {
    const choices = serverChoices(servers, []);
    expect(choices.find((c) => c.id === "r")).toMatchObject({ enabled: true });
    expect(choices.find((c) => c.id === "m")).toMatchObject({ enabled: false, reason: "Does not serve traffic" });
    expect(serverChoices([{ id: "r", name: "relay-vps", canDeploy: false, transport: "relay", serves: true }], [])[0]).toMatchObject({ enabled: false });
  });
});

describe("environmentAppName", () => {
  it("is <project>-<environment>, made unique with a number", () => {
    expect(environmentAppName("shop", "staging", [])).toBe("shop-staging");
    expect(environmentAppName("shop", "staging", ["shop-staging"])).toBe("shop-staging-2");
    expect(environmentAppName("shop", "staging", ["shop-staging", "shop-staging-2"])).toBe("shop-staging-3");
  });
  it("gives up rather than make a name the agent refuses", () => {
    expect(environmentAppName("a".repeat(40), "b".repeat(30), [])).toBeNull();
    expect(environmentAppName("a".repeat(30), "b".repeat(32), ["x"])).toBe(`${"a".repeat(30)}-${"b".repeat(32)}`);
    expect(environmentAppName("a".repeat(30), "b".repeat(32), [`${"a".repeat(30)}-${"b".repeat(32)}`])).toBeNull();
  });
});

describe("planAddEnvironment: what is written", () => {
  it("labels the new app with the project and the environment", () => {
    const p = plan();
    expect(p.appName).toBe("shop-staging");
    expect(p.config).toMatchObject({ name: "shop-staging", project: "shop", environment: "staging" });
  });
  it("copies the configuration of the source: image, command, ports, volumes, health check, release steps", () => {
    const { config, copied } = plan();
    expect(config).toMatchObject({ image: "ghcr.io/acme/shop", command: ["node", "server.js"], port: 3000, volumes: ["shop-data:/data"], health_path: "/healthz", restart: "unless-stopped" });
    expect(config.release?.steps).toHaveLength(1);
    expect(copied).toEqual(expect.arrayContaining(["image", "command", "port", "volumes", "health_path", "release", "restart"]));
  });
  it("never copies variables, domains or what belongs to the one app (its database, previews and source link), and says it left them out", () => {
    const { config, left, copied } = plan();
    for (const f of ["env", "env_file", "domains", "database", "previews", "source"] as const) {
      expect(config).not.toHaveProperty(f);
      expect(copied).not.toContain(f);
    }
    expect(left.sort()).toEqual(["database", "domains", "env", "env_file", "previews", "source"]);
  });
  it("does not mention what the source never had", () => {
    const { left } = plan({ from: source({ config: { name: "shop", image: "ghcr.io/acme/shop", env: {}, domains: [] } }) });
    expect(left).toEqual([]);
  });
  it("does not share the source's lists with the new app", () => {
    const { config } = plan();
    config.volumes?.push("x");
    expect(production.volumes).toEqual(["shop-data:/data"]);
  });
  it("starts from the given image when nothing is copied", () => {
    const { config, copied } = plan({ from: null, image: " ghcr.io/acme/shop " });
    expect(config).toEqual({ name: "shop-staging", project: "shop", environment: "staging", image: "ghcr.io/acme/shop" });
    expect(copied).toEqual([]);
  });
  it("copies the image of the status when the source's file could not be read, and warns", () => {
    const p = plan({ from: source({ config: null }) });
    expect(p.config.image).toBe("ghcr.io/acme/shop");
    expect(p.copied).toEqual(["image"]);
    expect(p.warnings).toHaveLength(1);
  });
});

describe("planAddEnvironment: names", () => {
  it("makes the app name unique on the target server", () => {
    expect(plan({ existingAppNames: ["shop", "shop-staging"] }).appName).toBe("shop-staging-2");
  });
  it("trims the environment name", () => {
    expect(plan({ environment: " staging " }).config.environment).toBe("staging");
  });
});

describe("planAddEnvironment: refusals", () => {
  const refused = (over: Partial<AddEnvironmentInput>) => {
    const p = planAddEnvironment(input(over));
    expect(p.ok).toBe(false);
    return p.ok ? "" : p.reason;
  };
  it("refuses an environment the project has", () => {
    expect(refused({ environment: "production" })).toContain("production");
  });
  it("refuses a name the agent would refuse", () => {
    refused({ environment: "Staging" });
    refused({ environment: "" });
    refused({ environment: "a b" });
    refused({ project: "Not Valid" });
  });
  it("refuses a server that cannot deploy", () => {
    expect(refused({ server: ro })).toContain(ro.name);
  });
  it("refuses without an image to start from", () => {
    refused({ from: null, image: "" });
    refused({ from: null });
    refused({ from: null, image: "a b" });
  });
  it("refuses a name that is too long", () => {
    expect(refused({ project: "a".repeat(40), environment: "b".repeat(30) })).toContain("shorter");
  });
});

describe("planAddEnvironment: warnings", () => {
  it("warns about what the two environments would share on the same server", () => {
    const p = plan({ server: s1 });
    expect(p.warnings).toHaveLength(1);
    expect(p.warnings[0]).toContain("volumes");
  });
  it("says nothing on another server", () => {
    expect(plan({ server: s2 }).warnings).toEqual([]);
  });
});

// ---- rename ----

const FILE = `apps:
  - name: shop
    image: ghcr.io/acme/shop
  - name: shop-worker
    project: shop
    image: ghcr.io/acme/worker
  - name: blog
    image: ghcr.io/acme/blog
jobs:
  - name: nightly
    project: shop
    schedule: "0 3 * * *"
  - name: other
    project: blog
    schedule: "0 4 * * *"
databases:
  - name: shopdb
    project: shop
    host: localhost
`;

function facts(server = s1, content = FILE, model?: Parameters<typeof renameFacts>[1]): RenameServerFacts {
  const entities = fileEntities(content);
  const m = model ?? {
    apps: entities.filter((e) => e.section === "apps").map((e) => ({ name: e.name, ...(e.label ? { project: e.label } : {}) })),
    jobs: entities.filter((e) => e.section === "jobs").map((e) => ({ name: e.name, ...(e.label ? { project: e.label } : {}) })),
    databases: entities.filter((e) => e.section === "databases").map((e) => ({ name: e.name, ...(e.label ? { project: e.label } : {}) })),
  };
  return renameFacts(server, m, entities);
}

describe("planRenameProject", () => {
  const run = (to: string, f: RenameServerFacts[], existingProjects = ["shop", "blog"]) => planRenameProject({ from: "shop", to, facts: f, existingProjects });

  it("lists every app, job and database of the project, the implicit project name included", () => {
    const p = run("store", [facts()]);
    if (!p.ok) throw new Error(p.reason);
    expect(p.servers).toHaveLength(1);
    expect(p.servers[0].changes).toEqual([
      { kind: "app", name: "shop", write: "add" },
      { kind: "app", name: "shop-worker", write: "set" },
      { kind: "job", name: "nightly", write: "set" },
      { kind: "database", name: "shopdb", write: "set" },
    ]);
    expect(p.totals).toEqual({ apps: 2, jobs: 1, databases: 1 });
    expect(p.blockers).toEqual([]);
  });
  it("does not touch another project, nor an unlabelled job", () => {
    const p = run("store", [facts()]);
    if (!p.ok) throw new Error(p.reason);
    expect(p.servers[0].changes.map((c) => c.name)).not.toContain("blog");
    expect(p.servers[0].changes.map((c) => c.name)).not.toContain("other");
  });
  it("groups by server, one save each, and skips servers with nothing to change", () => {
    const other = `apps:\n  - name: shop-eu\n    project: shop\n    image: x\n`;
    const p = run("store", [facts(s1), facts(s2, other), facts({ id: "s9", name: "quiet", canDeploy: true }, `apps:\n  - name: blog\n    image: x\n`)]);
    if (!p.ok) throw new Error(p.reason);
    expect(p.servers.map((s) => s.server.id)).toEqual(["s1", "s2"]);
    expect(p.servers[1]).toMatchObject({ apps: 1, jobs: 0, databases: 0 });
    expect(labelEdits(p.servers[1])).toEqual([{ section: "apps", name: "shop-eu" }]);
  });
  it("refuses a project that exists, the same name and an invalid one", () => {
    expect(run("blog", [facts()]).ok).toBe(false);
    expect(run("shop", [facts()]).ok).toBe(false);
    expect(run("Bad Name", [facts()]).ok).toBe(false);
    expect(run("", [facts()]).ok).toBe(false);
  });
  it("refuses when nothing belongs to the project", () => {
    expect(run("store", [facts(s1, `apps:\n  - name: blog\n    image: x\n`)]).ok).toBe(false);
  });
  it("reports a read-only server as a blocker, not as a skip", () => {
    const p = run("store", [facts(s1), facts(ro, `apps:\n  - name: shop-ro\n    project: shop\n    image: x\n`)]);
    if (!p.ok) throw new Error(p.reason);
    expect(p.blockers).toHaveLength(1);
    expect(p.blockers[0]).toMatchObject({ serverId: "s3" });
    expect(p.servers.map((s) => s.server.id)).toEqual(["s1", "s3"]);
  });
  it("reports an unreadable server and entities that live in a project file or cannot be edited", () => {
    const unreadable: RenameServerFacts = { server: s2, unreadable: "the agent did not answer", entities: [{ kind: "app", name: "shop-eu", label: "shop", inAppsFile: true }] };
    const inProjectFile: RenameServerFacts = { server: s1, entities: [{ kind: "app", name: "shop", label: "shop", inAppsFile: false }] };
    const flow: RenameServerFacts = { server: s1, entities: [{ kind: "app", name: "shop", label: "", inAppsFile: true, unsupported: "it is written in flow style or with an anchor" }] };
    for (const f of [unreadable, inProjectFile, flow]) {
      const p = run("store", [f]);
      if (!p.ok) throw new Error(p.reason);
      expect(p.blockers.length).toBeGreaterThan(0);
    }
  });
  it("trims the new name", () => {
    const p = run(" store ", [facts()]);
    expect(p.ok && p.to).toBe("store");
  });
});

describe("renameFacts", () => {
  it("takes the label as the file writes it and marks what the file does not declare", () => {
    const entities = fileEntities(FILE);
    const f = renameFacts(s1, { apps: [{ name: "shop" }, { name: "shop-worker", project: "shop" }, { name: "in-project-file", project: "shop" }] }, entities);
    expect(f.entities).toEqual([
      { kind: "app", name: "shop", label: "", inAppsFile: true },
      { kind: "app", name: "shop-worker", label: "shop", inAppsFile: true },
      { kind: "app", name: "in-project-file", label: "shop", inAppsFile: false },
    ]);
  });
});

describe("renameCountsText", () => {
  it("says what is there and nothing else", () => {
    expect(renameCountsText({ apps: 2, jobs: 1, databases: 1 })).toBe("2 apps, 1 job and 1 database");
    expect(renameCountsText({ apps: 1, jobs: 0, databases: 0 })).toBe("1 app");
    expect(renameCountsText({ apps: 0, jobs: 0, databases: 0 })).toBe("nothing");
  });
});
