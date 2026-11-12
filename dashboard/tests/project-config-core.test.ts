import { describe, expect, it } from "vitest";
import type { AppStatus, ConfigFile, ConfigIssue, ProjectConfigDocument, ProjectFileSummary, SplitPlan } from "@/lib/agent-types";
import {
  configFileRows,
  configLocation,
  countsText,
  derivedProject,
  derivedYaml,
  fileEntities,
  issueInFile,
  issueWhere,
  issuesInFile,
  projectConfigHref,
  projectFileView,
  splitNotice,
  splitPlanView,
  versionsHref,
} from "@/lib/project-config-core";
import type { ProjectMembers, ServerFacts } from "@/lib/project-hub-core";

const server = { id: "s1", name: "vps-1", canDeploy: true };
const summary = (name: string): ProjectFileSummary => ({ name, path: `projects.d/${name}.yaml`, hash: "h", applied_hash: "h", modified_at: "", apps: 1, jobs: 0, databases: 0, previews: 0 });

describe("where a project's configuration lives", () => {
  it("takes a missing list for an agent without the feature, a listed file for its own file, and any other project for the shared file", () => {
    expect(configLocation(null, "shop")).toBe("old-agent");
    expect(configLocation([], "shop")).toBe("shared");
    expect(configLocation([summary("blog")], "shop")).toBe("shared");
    expect(configLocation([summary("blog"), summary("shop")], "shop")).toBe("file");
  });
});

describe("projectFileView: the state of the file", () => {
  const doc = (over: Partial<ProjectConfigDocument> = {}): ProjectConfigDocument => ({
    project: "shop",
    path: "projects.d/shop.yaml",
    content: "apps: []",
    hash: "aaa",
    applied_hash: "aaa",
    config_hash: "bundle",
    modified_at: "2026-10-30T10:00:00Z",
    model: { apps: [{ name: "shop", image: "x", previews: { domain: "pr-{pr}-shop.example.com" } }, { name: "shop-api", image: "y" }], jobs: [{ name: "report", schedule: "* * * * *" }], databases: [] },
    ...over,
  });

  it("is in force when the file in force is the one on disk, and counts what it holds", () => {
    const view = projectFileView(doc());
    expect(view).toMatchObject({ path: "projects.d/shop.yaml", hash: "aaa", inForce: true, counts: { apps: 2, jobs: 1, databases: 0 } });
    expect(view.error).toBeUndefined();
  });

  it("is not in force, with the agent's reason, when the file on disk is not the one in force", () => {
    const view = projectFileView(doc({ applied_hash: "old", error: "projects.d/shop.yaml line 4: unknown key" }));
    expect(view.inForce).toBe(false);
    expect(view.error).toBe("projects.d/shop.yaml line 4: unknown key");
  });

  it("is not in force when nothing is in force (empty applied hash), even without a message", () => {
    expect(projectFileView(doc({ applied_hash: "" })).inForce).toBe(false);
  });

  it("lists what the file holds by kind, for the removal to show what leaves", () => {
    expect(fileEntities(doc().model)).toEqual([
      { label: "Apps", names: ["shop", "shop-api"] },
      { label: "Jobs", names: ["report"] },
    ]);
    expect(fileEntities({})).toEqual([]);
  });

  it("says in words what is there", () => {
    expect(countsText({ apps: 2, jobs: 1, databases: 1 })).toBe("2 apps, 1 job and 1 database");
    expect(countsText({ apps: 1, jobs: 0, databases: 0 })).toBe("1 app");
    expect(countsText({ apps: 0, jobs: 0, databases: 0 })).toBe("no apps, jobs or databases");
  });
});

describe("the derived view of a project in the shared file", () => {
  const apps = [
    { name: "shop", image: "i", project: "shop", env: { API_KEY: "<hidden>", MODE: "prod" }, domains: ["shop.example.com"], publish: ["8080:80"], command: ["run", "--fast"] },
    { name: "shop-api", image: "j", project: "shop" },
    { name: "blog", image: "k" },
  ];
  const facts = (config: ServerFacts["config"]): ServerFacts => ({ server, apps: [] as AppStatus[], jobs: [], databases: [], config });
  const members = (over: Partial<ProjectMembers> = {}): ProjectMembers => ({ jobs: [], databases: [], unassignedJobs: [], unassignedDatabases: [], ...over });

  it("keeps the apps labelled with the project or named for it, and the jobs and databases the hub attributes", () => {
    const d = derivedProject(
      "shop",
      server,
      facts({ apps }),
      members({
        jobs: [{ server, job: {} as never, config: { name: "report", schedule: "0 3 * * *" }, via: "label" }, { server: { ...server, id: "s2" }, job: {} as never, config: { name: "other", schedule: "* * * * *" }, via: "label" }],
        databases: [{ server, db: {} as never, config: { name: "shop", host: "h", database: "d", user: "u" }, via: "managed-app", apps: ["shop"] }],
      }),
    );
    expect(d?.apps.map((a) => a.name)).toEqual(["shop", "shop-api"]);
    expect(d?.jobs.map((j) => j.name)).toEqual(["report"]);
    expect(d?.databases.map((x) => x.name)).toEqual(["shop"]);
  });

  it("is unknown (null), not empty, when the configuration could not be read", () => {
    expect(derivedProject("shop", server, facts(null), members())).toBeNull();
    expect(derivedProject("shop", server, undefined, members())).toBeNull();
  });

  it("writes the entries as YAML, secrets as they come (hidden), strings quoted only when they must be", () => {
    const d = derivedProject("shop", server, facts({ apps }), members());
    const yaml = derivedYaml(d!);
    expect(yaml).toBe(
      [
        "apps:",
        "  - name: shop",
        "    image: i",
        "    project: shop",
        "    env:",
        "      API_KEY: <hidden>",
        "      MODE: prod",
        "    domains:",
        "      - shop.example.com",
        "    publish:",
        '      - "8080:80"',
        "    command:",
        "      - run",
        '      - "--fast"',
        "  - name: shop-api",
        "    image: j",
        "    project: shop",
        "",
      ].join("\n"),
    );
    expect(yaml).not.toContain("hunter2");
  });

  it("quotes what YAML would read as another type, and writes empty and nested values", () => {
    const yaml = derivedYaml({
      apps: [],
      jobs: [{ name: "j", schedule: "* * * * *", timeout: "10s", http: { url: "http://x/y?a=1", headers: {}, expect_status: [200, 204] }, paused: false }],
      databases: [],
    });
    expect(yaml).toContain('schedule: "* * * * *"');
    expect(yaml).toContain("paused: false");
    expect(yaml).toContain("headers: {}");
    expect(yaml).toContain("- 200");
    expect(yaml).toContain('url: "http://x/y?a=1"');
    expect(derivedYaml({ apps: [], jobs: [], databases: [] })).toBe("");
  });
});

describe("splitPlanView", () => {
  const plan: SplitPlan = {
    project: "shop",
    file: "projects.d/shop.yaml",
    apps: ["shop", "shop-api"],
    jobs: ["report"],
    databases: [],
    previews: [],
    kept: [{ kind: "database", name: "shared", reason: "also named by the release step of app blog" }],
  };

  it("lists what moves by kind, in the order of the file, and what stays with the reason", () => {
    const view = splitPlanView(plan);
    expect(view.moves).toEqual([
      { label: "Apps", names: ["shop", "shop-api"] },
      { label: "Jobs", names: ["report"] },
    ]);
    expect(view.moved).toBe(3);
    expect(view.summary).toBe("Moves 2 apps and 1 job into projects.d/shop.yaml.");
    expect(view.kept).toEqual(plan.kept);
  });

  it("says nothing moves when the plan is empty", () => {
    const view = splitPlanView({ ...plan, apps: [], jobs: [], kept: [] });
    expect(view.moved).toBe(0);
    expect(view.summary).toBe("Nothing moves into projects.d/shop.yaml.");
  });

  it("links the result to the editor of that server's section", () => {
    const notice = splitNotice("shop", "s1", plan.file);
    expect(notice.title).toBe("projects.d/shop.yaml created");
    expect(notice.action).toEqual({ label: "Open the editor", href: "/projects/shop/config#config-s1" });
    expect(projectConfigHref("a b")).toBe("/projects/a%20b/config");
    expect(versionsHref("s1")).toBe("/servers/s1/config/versions");
  });
});

describe("issues: file and line", () => {
  const inShop: ConfigIssue = { severity: "error", path: "apps[web]", line: 12, message: "bad", file: "projects.d/shop.yaml", project: "shop" };
  const inMain: ConfigIssue = { severity: "warning", path: "proxy", line: 3, message: "w", file: "apps.yaml" };
  const plain: ConfigIssue = { severity: "error", path: "yaml", line: 1, message: "syntax" };

  it("names the file and the line, or only what is known", () => {
    expect(issueWhere(inShop)).toBe("projects.d/shop.yaml, line 12");
    expect(issueWhere(plain)).toBe("line 1");
    expect(issueWhere({ severity: "error", path: "x", message: "m", file: "apps.yaml" })).toBe("apps.yaml");
    expect(issueWhere({ severity: "error", path: "x", message: "m" })).toBeUndefined();
  });

  it("can jump only to lines of the edited file", () => {
    expect(issueInFile(inShop, "projects.d/shop.yaml")).toBe(true);
    expect(issueInFile(inMain, "projects.d/shop.yaml")).toBe(false);
    expect(issueInFile(plain, "projects.d/shop.yaml")).toBe(true);
    expect(issueInFile(inMain, undefined)).toBe(true);
    expect(issuesInFile([inShop, inMain, plain], "projects.d/shop.yaml")).toEqual([inShop, plain]);
    expect(issuesInFile([inShop, inMain, plain], "apps.yaml")).toEqual([inMain, plain]);
  });
});

describe("configFileRows: the files of a server's configuration", () => {
  const files: ConfigFile[] = [
    { path: "apps.yaml", project: "", hash: "0123456789abcdef0123", modified_at: "2026-10-30T10:00:00Z" },
    { path: "projects.d/shop.yaml", project: "shop", hash: "fedcba9876543210fedc", modified_at: "2026-10-30T11:00:00Z" },
  ];

  it("lists them with their project, hash and a link from each project file to its tab; the apps file has none", () => {
    expect(configFileRows(files)).toEqual([
      { path: "apps.yaml", project: "", hash: files[0].hash, shortHash: "0123456789ab", modifiedAt: files[0].modified_at, href: undefined },
      { path: "projects.d/shop.yaml", project: "shop", hash: files[1].hash, shortHash: "fedcba987654", modifiedAt: files[1].modified_at, href: "/projects/shop/config" },
    ]);
  });

  it("lists nothing for a lone apps file or an agent that sends no files", () => {
    expect(configFileRows(undefined)).toEqual([]);
    expect(configFileRows([files[0]])).toEqual([]);
  });
});
