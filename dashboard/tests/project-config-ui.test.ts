import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ConfigIssue, ProjectConfigDocument, SplitPlan } from "@/lib/agent-types";
import { configFileRows, derivedProject, type ServerProjectConfig } from "@/lib/project-config-core";
import type { ProjectMembers, ServerFacts } from "@/lib/project-hub-core";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-project-config-ui-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

vi.mock("@/lib/session", () => ({ requireSession: async () => {}, clientInfo: async () => ({ ip: "127.0.0.1" }) }));
vi.mock("@/lib/step-up", () => ({ stepUpError: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({ notFound: () => {}, redirect: () => {}, usePathname: () => "/", useRouter: () => ({ refresh() {}, push() {} }) }));

const { TooltipProvider } = await import("@/components/ui/tooltip");
const { ProjectConfig } = await import("@/components/projects/ProjectConfig");
const { SplitPlanSummary, SplitProjectDialog } = await import("@/components/projects/SplitProjectDialog");
const { DeleteProjectFileDialog } = await import("@/components/projects/DeleteProjectFileDialog");
const { IssuesList } = await import("@/components/config/IssuesList");
const { ConfigFiles } = await import("@/components/config/ConfigFiles");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const html = (element: unknown) => renderToStaticMarkup(createElement(TooltipProvider, null, element as ReactElement));
const vps1 = { id: "s1", name: "vps-1", canDeploy: true };
const ro = { id: "s2", name: "edge", canDeploy: false };
const facts = (s = vps1): ServerFacts => ({
  server: s,
  apps: [],
  jobs: [],
  databases: [],
  config: { apps: [{ name: "shop", image: "i", project: "shop", env: { API_KEY: "<hidden>" } }, { name: "blog", image: "b" }] },
});
const members: ProjectMembers = { jobs: [], databases: [], unassignedJobs: [], unassignedDatabases: [] };
const derived = (s = vps1) => derivedProject("shop", s, facts(s), members);

const doc = (over: Partial<ProjectConfigDocument> = {}): ProjectConfigDocument => ({
  project: "shop",
  path: "projects.d/shop.yaml",
  content: "apps:\n  - name: shop\n    image: i\n",
  hash: "0123456789abcdef0123456789abcdef",
  applied_hash: "0123456789abcdef0123456789abcdef",
  config_hash: "bundle",
  modified_at: "2026-10-30T10:00:00Z",
  model: { apps: [{ name: "shop", image: "i" }], jobs: [{ name: "report", schedule: "0 3 * * *" }] },
  ...over,
});

const shared = (s = vps1): ServerProjectConfig => ({ server: s, machine: false, derived: derived(s), deprecations: [], source: "shared" });
const file = (over: Partial<ProjectConfigDocument> = {}, s = vps1): ServerProjectConfig => ({ server: s, machine: false, derived: derived(s), deprecations: [], source: "file", doc: doc(over) });
const render = (servers: ServerProjectConfig[], unreachable: { id: string; name: string; reason?: string }[] = []) =>
  html(createElement(ProjectConfig, { project: "shop", servers, unreachable }));

describe("the Configuration tab: a project without a file", () => {
  const out = render([shared()]);

  it("says where the configuration lives, and shows what the project holds as read-only YAML, secrets hidden", () => {
    expect(out).toContain("The shared configuration of vps-1");
    expect(out).toContain('data-testid="derived-config"');
    expect(out).toContain("name: shop");
    expect(out).toContain("API_KEY: &lt;hidden&gt;");
    expect(out).not.toContain("name: blog");
    expect(out).toContain("1 app");
  });

  it("offers to give the project its own file, naming the file", () => {
    expect(out).toContain("Give shop its own file");
    expect(out).toContain("projects.d/shop.yaml");
    expect(out).not.toContain("<textarea");
  });

  it("disables the action with its reason on a server without the deploy secret", () => {
    const readOnly = render([shared(ro)]);
    expect(readOnly).toContain("Give shop its own file");
    expect(readOnly).toMatch(/<button[^>]*disabled[^>]*data-gate="read-only"[^>]*>\s*(<svg[^>]*>.*?<\/svg>)?\s*Give shop its own file/s);
  });

  it("says nothing belongs to the project when the merged model holds none of it, and that it cannot tell when it is unreadable", () => {
    const empty = render([{ server: vps1, machine: false, deprecations: [], source: "shared", derived: { apps: [], jobs: [], databases: [] } }]);
    expect(empty).toContain("Nothing in the configuration of vps-1 belongs to shop");
    const unreadable = render([{ server: vps1, machine: false, deprecations: [], source: "shared", derived: null }]);
    expect(unreadable).toContain("The configuration of vps-1 could not be read");
    expect(unreadable).toContain("Not known");
  });
});

describe("the Configuration tab: an agent too old", () => {
  it("says the agent must be updated, links to the server's update page, and still shows the derived view", () => {
    const out = render([{ server: vps1, machine: false, derived: derived(), deprecations: [], source: "old-agent" }]);
    expect(out).toContain("must be updated to give shop its own file");
    expect(out).toContain('href="/servers/s1/update"');
    expect(out).toContain('data-testid="derived-config"');
    expect(out).not.toContain("Give shop its own file on");
    expect(out).not.toContain("Create ");
  });

  it("does not link to an update page a machine that connects out does not have", () => {
    const out = render([{ server: vps1, machine: true, derived: derived(), deprecations: [], source: "old-agent" }]);
    expect(out).toContain("keelson-agent connect");
    expect(out).not.toContain("/servers/s1/update");
  });
});

describe("the Configuration tab: a project with its own file", () => {
  it("shows its state first: path, hash, last change, counts and in force; then the editor, the versions link and the removal", () => {
    const out = render([file()]);
    expect(out).toContain("Its own file");
    expect(out).toContain("projects.d/shop.yaml");
    expect(out).toContain("In force");
    expect(out).toContain("0123456789ab");
    expect(out).toContain("1 app and 1 job");
    expect(out).toContain("Review and save");
    expect(out).toContain('href="/servers/s1/config/versions"');
    expect(out).toContain("versioned as a whole");
    expect(out).toContain("Delete projects.d/shop.yaml");
    expect(out).not.toContain("Read-only");
  });

  it("says the file on disk is not the one in force, with the agent's reason (file and line)", () => {
    const out = render([file({ applied_hash: "ffff", error: "projects.d/shop.yaml line 4: unknown key: foo" })]);
    expect(out).toContain("Not in force");
    expect(out).toContain("projects.d/shop.yaml line 4: unknown key: foo");
    expect(out).toContain("keeps running the last good configuration");
    expect(out).toContain("The editor shows the file that is in force");
  });

  it("is read-only on a server without the deploy secret, with the reason, and the removal is disabled", () => {
    const out = render([file({}, ro)]);
    expect(out).toContain("Read-only");
    expect(out).toMatch(/<button[^>]*disabled[^>]*data-gate="read-only"[^>]*>\s*Delete projects.d\/shop.yaml/);
    expect(out).not.toContain("Review and save");
  });

  it("has one section per server, each at its own anchor, and names a server that did not answer", () => {
    const out = render([file(), shared(ro)], [{ id: "s3", name: "far", reason: "timeout" }]);
    expect(out.match(/data-testid="server-config"/g)).toHaveLength(2);
    expect(out).toContain('id="config-s1"');
    expect(out).toContain('id="config-s2"');
    expect(out).toContain("far");
    expect(out).toContain("did not answer");
  });

  it("says a server that could not be read could not be read, with why", () => {
    const out = render([{ server: vps1, machine: false, derived: null, deprecations: [], source: "unavailable", reason: "connection refused" }]);
    expect(out).toContain("Could not read the configuration of shop on vps-1");
    expect(out).toContain("connection refused");
    expect(out).not.toContain('data-testid="derived-config"');
  });

  it("with no server at all: names the unreachable ones, or says no server holds the project", () => {
    expect(render([], [{ id: "s3", name: "far" }])).toContain("far");
    expect(render([])).toContain('data-slot="empty-state"');
  });
});

describe("the split plan", () => {
  const plan: SplitPlan = {
    project: "shop",
    file: "projects.d/shop.yaml",
    apps: ["shop", "shop-api"],
    jobs: ["report"],
    databases: ["shop"],
    previews: [],
    kept: [{ kind: "database", name: "shared", reason: "also named by the release step of app blog" }],
  };

  it("shows what moves, and what stays in the apps file and why", () => {
    const out = html(createElement(SplitPlanSummary, { plan }));
    expect(out).toContain("Moves 2 apps, 1 job and 1 database into projects.d/shop.yaml.");
    expect(out).toContain("Moves to projects.d/shop.yaml");
    expect(out).toContain("shop, shop-api");
    expect(out).toContain("Stays in the shared configuration");
    expect(out).toContain("database shared");
    expect(out).toContain("also named by the release step of app blog");
  });

  it("omits the 'stays' list when everything moves", () => {
    const out = html(createElement(SplitPlanSummary, { plan: { ...plan, kept: [] } }));
    expect(out).not.toContain("Stays in the shared configuration");
  });

  it("closed, the dialog is only its trigger: nothing is asked of the agent before the click", () => {
    const out = html(createElement(SplitProjectDialog, { serverId: "s1", serverName: "vps-1", project: "shop", canEdit: true }));
    expect(out).toContain("Give shop its own file");
    expect(out).not.toContain("Asking the agent");
  });
});

describe("the removal of a project's file", () => {
  it("is a button naming the file; the dialog with the typed-name confirmation opens on click", () => {
    const out = html(
      createElement(DeleteProjectFileDialog, {
        serverId: "s1",
        serverName: "vps-1",
        project: "shop",
        file: "projects.d/shop.yaml",
        hash: "h",
        holds: [{ label: "Apps", names: ["shop"] }],
        appsLeave: true,
      }),
    );
    expect(out).toContain("Delete projects.d/shop.yaml");
  });
});

describe("issues of a bundle", () => {
  const issues: ConfigIssue[] = [
    { severity: "error", path: "apps[web]", line: 12, message: "bad", file: "projects.d/shop.yaml", project: "shop" },
    { severity: "warning", path: "proxy", line: 3, message: "w", file: "apps.yaml" },
    { severity: "error", path: "yaml", line: 1, message: "syntax" },
  ];

  it("names the file of each issue; only the lines of the edited file are clickable", () => {
    const out = html(createElement(IssuesList, { issues, file: "projects.d/shop.yaml", onSelectLine: () => {} }));
    expect(out).toContain("projects.d/shop.yaml");
    expect(out).toContain("apps.yaml");
    expect(out).toContain('aria-label="Go to line 12"');
    expect(out).toContain('aria-label="Go to line 1"');
    expect(out).not.toContain('aria-label="Go to line 3"');
    expect(out).toContain("line 3");
  });

  it("is what it was for a configuration without project files", () => {
    const out = html(createElement(IssuesList, { issues: [issues[2]], onSelectLine: () => {} }));
    expect(out).toContain('aria-label="Go to line 1"');
    expect(out).not.toContain("font-mono text-xs text-muted-foreground\">projects.d");
  });
});

describe("the files of a server's configuration", () => {
  const rows = configFileRows([
    { path: "apps.yaml", project: "", hash: "0123456789abcdef0123", modified_at: "2026-10-30T10:00:00Z" },
    { path: "projects.d/shop.yaml", project: "shop", hash: "fedcba9876543210fedc", modified_at: "2026-10-30T11:00:00Z" },
  ]);

  it("lists each file with its project and hash, and links a project file to the hub's Configuration tab", () => {
    const out = html(createElement(ConfigFiles, { rows }));
    expect(out).toContain("apps.yaml");
    expect(out).toContain("projects.d/shop.yaml");
    expect(out).toContain("Server-wide");
    expect(out).toContain("fedcba987654");
    expect(out).toContain('href="/projects/shop/config"');
    expect(out).toContain("2 files");
  });
});
