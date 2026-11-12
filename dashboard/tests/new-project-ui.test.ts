import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BackupKeyNotice } from "@/components/new-project/BackupKeyNotice";
import { DatabaseCard } from "@/components/new-project/DatabaseCard";
import { EnvNamesHint } from "@/components/new-project/EnvNamesHint";
import type { DnsSetup } from "@/lib/dns-record-core";
import { chooseFramework, initialInput, WIZARD_STEPS, type ProjectServer } from "@/lib/new-project-wizard-core";
import { PRESET_LIST, visibleFields } from "@/lib/presets-core";
import type { ReviewContext, ReviewInput } from "@/lib/repo-detect-core";

vi.mock("@/app/new-project-actions", () => ({
  createProjectAction: async () => ({}),
  retryCreateProjectAction: async () => ({}),
  inspectRepoAction: async () => ({ ok: true, candidates: [], truncated: false, suggestion: { framework: null, release: null, database: null, envNames: [] } }),
}));

const { NewProjectWizard } = await import("@/components/new-project/NewProjectWizard");
const { ProgressPanel } = await import("@/components/new-project/Progress");
const { RepositoryStep } = await import("@/components/new-project/RepositoryStep");
const { FrameworkStep } = await import("@/components/new-project/FrameworkStep");
const { ConfigureStep } = await import("@/components/new-project/ConfigureStep");
const { VariablesStep, VariableList, MASK } = await import("@/components/new-project/VariablesStep");
const { ReviewStep } = await import("@/components/new-project/ReviewStep");
const { PresetOptionsFields } = await import("@/components/new-project/PresetOptionsFields");
const { GithubRequiredNotice } = await import("@/components/new-project/GithubRequiredNotice");

const ctx = (extra: Partial<ReviewContext> = {}): ReviewContext => ({ existingNames: [], usedDomains: [], usedHostPorts: [], proxy: "caddy", previewApps: [], ...extra });
const candidate = (extra: Record<string, unknown> = {}) => ({ path: "Dockerfile", context: ".", dockerfile: "Dockerfile", port: 3000, portFromVariable: false, healthcheck: false, ...extra });
const SETUP: DnsSetup = { connected: false, zones: [], zonesError: null, address: { ok: true, ip: "203.0.113.7", type: "A", source: "the host of the agent's URL", private: null } };
const server = (extra: Partial<ProjectServer> = {}): ProjectServer => ({ id: "srv", name: "staging", context: ctx(), hostPort: 8101, dns: SETUP, envSupported: true, databaseSupported: true, appsDomain: null, stats: { online: true, cpus: 2, load1: 0.4, memTotal: 4 * 1024 ** 3, memAvailable: 2.8 * 1024 ** 3, diskFree: 24 * 1024 ** 3 }, ...extra });
const REPOS = [
  { fullName: "acme/shop", defaultBranch: "main", private: true },
  { fullName: "acme/blog", defaultBranch: "trunk", private: false },
];

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const checked = (markup: string) => (markup.match(/aria-checked="true"/g) ?? []).length;

describe("the repository step", () => {
  it("explains the missing GitHub App and links to Integrations", () => {
    const out = html(createElement(GithubRequiredNotice));
    expect(out).toContain("GitHub is not connected yet");
    expect(out).toContain('href="/settings/integrations"');
  });

  it("lists the repositories with their branch, marks private ones, searches, and selects none to begin with", () => {
    const out = html(createElement(RepositoryStep, { repos: REPOS, selected: "", onSelect: () => {} }));
    expect(out).toContain("acme/shop");
    expect(out).toContain("acme/blog");
    expect(out).toContain("trunk");
    expect(out).toContain("Private");
    expect(out).toContain("Search repositories");
    expect(checked(out)).toBe(0);
  });

  it("marks the chosen one, and says when the App is installed nowhere", () => {
    expect(checked(html(createElement(RepositoryStep, { repos: REPOS, selected: "acme/blog", onSelect: () => {} })))).toBe(1);
    expect(html(createElement(RepositoryStep, { repos: [], selected: "", onSelect: () => {} }))).toContain("not installed on any repository");
  });
});

describe("the framework step", () => {
  const step = (preset: string, extra: Record<string, unknown> = {}) =>
    html(
      createElement(FrameworkStep, {
        preset,
        onChoose: () => {},
        lookup: { status: "idle" },
        suggested: null,
        input: { dockerfile: "Dockerfile", context: "." },
        candidate: "",
        onPick: () => {},
        onField: () => {},
        errors: {},
        idPrefix: "t",
        ...extra,
      }),
    );

  it("shows one card per entry of the registry, in its order, and nothing selected", () => {
    const out = step("");
    const labels = PRESET_LIST.map((p) => out.indexOf(p.label));
    expect(labels.every((i) => i >= 0)).toBe(true);
    expect([...labels].sort((a, b) => a - b)).toEqual(labels);
    expect((out.match(/role="radio"/g) ?? []).length).toBe(PRESET_LIST.length);
    for (const p of PRESET_LIST) expect(out).toContain(`data-preset="${p.id}"`);
    expect(checked(out)).toBe(0);
    expect(out).not.toContain("Dockerfile found");
    expect(out).not.toContain("Reading the repository");
  });

  it("selects exactly the card that was clicked, and says nothing about the repository for a framework", () => {
    for (const p of PRESET_LIST.filter((x) => x.id !== "dockerfile")) {
      const out = step(p.id);
      expect(checked(out)).toBe(1);
      expect(out).not.toContain("Build context");
    }
  });

  it("shows the Dockerfile details only for the Dockerfile card: the lookup, the candidates, the path and the context", () => {
    const lookup = { status: "ready" as const, candidates: [candidate(), candidate({ path: "api/Dockerfile", context: "api" })], truncated: true };
    const out = step("dockerfile", { lookup, candidate: "Dockerfile" });
    expect(checked(out)).toBe(1);
    expect(out).toContain("Dockerfile found");
    expect(out).toContain("Build context");
    expect(out).toContain("Only part of the repository was searched");
    expect(step("dockerfile", { lookup: { status: "ready", candidates: [], truncated: false } })).toContain("No Dockerfile found");
    expect(step("dockerfile", { lookup: { status: "loading" } })).toContain("Reading the repository");
    expect(step("dockerfile", { lookup: { status: "error", error: "GitHub has no such repository." } })).toContain("GitHub has no such repository.");
  });

  it("shows the error of an attempt to go on without a choice", () => {
    expect(step("", { errors: { preset: "Choose how the project is built: click one." } })).toContain("Choose how the project is built");
  });

  it("marks the card the repository points to, says why, and leaves the choice open", () => {
    const out = step("nextjs", { suggested: { id: "nextjs", reason: "package.json depends on next." } });
    expect(out).toContain("Detected");
    expect(out).toContain("package.json depends on next.");
    expect(out).toContain("Pick another card if that is not how it should be built");
    expect((out.match(/>Detected</g) ?? []).length).toBe(1);
    expect(checked(out)).toBe(1);
    expect(step("nextjs")).not.toContain("Detected");
  });

  it("says nothing was recognised, once the repository is read and no card is chosen", () => {
    expect(step("", { lookup: { status: "ready", candidates: [], truncated: false } })).toContain("Nothing in the repository says how it is built");
    expect(step("", { lookup: { status: "loading" } })).not.toContain("Nothing in the repository says");
    expect(step("vite", { lookup: { status: "ready", candidates: [], truncated: false } })).not.toContain("Nothing in the repository says");
  });

  it("warns that the chosen Dockerfile needs BuildKit, and not for one that does not", () => {
    const lookup = (c: Record<string, unknown>) => ({ status: "ready", candidates: [candidate(c)], truncated: false });
    const warned = step("dockerfile", { lookup: lookup({ buildkit: true }), candidate: "Dockerfile" });
    expect(warned).toContain("This Dockerfile needs BuildKit");
    expect(warned).toContain("the build would fail");
    expect(step("dockerfile", { lookup: lookup({}), candidate: "Dockerfile" })).not.toContain("needs BuildKit");
    // another candidate chosen: the warning follows the choice
    expect(step("dockerfile", { lookup: { status: "ready", candidates: [candidate({ buildkit: true }), candidate({ path: "Dockerfile.prod" })], truncated: false }, candidate: "Dockerfile.prod" })).not.toContain("needs BuildKit");
  });
});

describe("the options of a framework, from the registry", () => {
  for (const p of PRESET_LIST) {
    it(`${p.label}: shows the fields it reads, with its defaults as placeholders`, () => {
      const out = html(createElement(PresetOptionsFields, { preset: p.id, options: {}, onChange: () => {}, errors: {}, idPrefix: "t" }));
      const fields = visibleFields(p.id, {});
      for (const f of fields) expect(out).toContain(`id="t-opt-${f}"`);
      for (const f of ["context", "install", "build_command", "start", "output_dir", "node", "spa", "standalone", "dockerfile", "target"] as const) {
        if (!fields.includes(f)) expect(out).not.toContain(`id="t-opt-${f}"`);
      }
      const attr = (v: string) => `placeholder="${v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")}"`;
      if (p.defaults.node && fields.includes("node")) expect(out).toContain(attr(p.defaults.node));
      if (p.defaults.output_dir) expect(out).toContain(attr(p.defaults.output_dir));
      for (const f of fields) {
        const placeholder = p.placeholders[f];
        if (placeholder) expect(out).toContain(attr(placeholder));
      }
    });
  }

  it("shows the install command and Node.js version of a static site only once it has a build command", () => {
    const without = html(createElement(PresetOptionsFields, { preset: "static", options: {}, onChange: () => {}, errors: {}, idPrefix: "t" }));
    expect(without).not.toContain('id="t-opt-install"');
    const built = html(createElement(PresetOptionsFields, { preset: "static", options: { build_command: "npm run build" }, onChange: () => {}, errors: {}, idPrefix: "t" }));
    expect(built).toContain('id="t-opt-install"');
    expect(built).toContain('id="t-opt-node"');
  });

  it("shows the standalone and SPA switches with the registry's defaults, and an error beside its field", () => {
    const next = html(createElement(PresetOptionsFields, { preset: "nextjs", options: {}, onChange: () => {}, errors: { node: "A Node.js major version" }, idPrefix: "t" }));
    expect(next).toContain("Standalone output");
    expect(next).toContain('data-state="unchecked"');
    expect(next).toContain("A Node.js major version");
    expect(html(createElement(PresetOptionsFields, { preset: "vite", options: {}, onChange: () => {}, errors: {}, idPrefix: "t" }))).toContain('data-state="checked"');
    expect(html(createElement(PresetOptionsFields, { preset: "vite", options: { spa: false }, onChange: () => {}, errors: {}, idPrefix: "t" }))).toContain('data-state="unchecked"');
  });
});

describe("the configure step", () => {
  const base = (preset: string): ReviewInput => (preset === "" ? initialInput({ name: "shop", branch: "main", hostPort: 8101, domains: true }) : chooseFramework(initialInput({ name: "shop", branch: "main", hostPort: 8101, domains: true }), preset as never));
  const step = (input: ReviewInput, extra: Record<string, unknown> = {}, srv: ProjectServer = server()) =>
    html(
      createElement(ConfigureStep, {
        input,
        onField: () => {},
        onOptions: () => {},
        errors: {},
        servers: [srv],
        serverId: srv.id,
        serverFixed: false,
        onServer: () => {},
        candidate: undefined,
        dnsState: { create: true, proxied: true, allowPrivate: false },
        onDns: () => {},
        advancedOpen: true,
        onAdvancedOpen: () => {},
        previewsOffered: false,
        nameTaken: false,
        repo: "acme/shop",
        branches: [],
        ...extra,
      }),
    );

  it("asks for the name, the branch, the port and how it is exposed, with the framework's port filled in", () => {
    const out = step(base("node"));
    expect(out).toContain('value="shop"');
    expect(out).toContain('value="main"');
    expect(out).toContain('value="3000"');
    expect(out).toContain("The generated image listens on this port");
    expect(out).toContain("Run before each deploy");
    expect(out).toContain("npx prisma migrate deploy");
    expect(out).toContain("if it fails, the deployment stops");
    expect(out).toContain("with the app&#x27;s variables");
  });

  it("offers the repository's branches as a menu when they are known, and a text box when they are not", () => {
    const comboBranch = /<button[^>]*role="combobox"[^>]*id="[^"]*-branch"|<button[^>]*id="[^"]*-branch"[^>]*role="combobox"/;
    expect(step(base("node"), { branches: ["develop", "main", "release/1.0"] })).toMatch(comboBranch);
    expect(step({ ...base("node"), branch: "feature/x" }, { branches: ["main"] })).toMatch(comboBranch);
    const typed = step(base("node"), { branches: [] });
    expect(typed).not.toMatch(comboBranch);
    expect(typed).toMatch(/<input[^>]*id="[^"]*-branch"[^>]*value="main"|<input[^>]*value="main"[^>]*id="[^"]*-branch"/);
  });

  it("says what the chosen server is, under the menu and in a server that is not the choice of a menu: its CPUs, memory and disk", () => {
    const a = server({ id: "a", name: "vps-1", stats: { online: true, cpus: 2, memTotal: 4 * 1024 ** 3, memAvailable: 1.2 * 1024 ** 3, diskFree: 20 * 1024 ** 3 } });
    const b = server({ id: "b", name: "vps-2", stats: { online: true, cpus: 8, memTotal: 16 * 1024 ** 3, memAvailable: 11 * 1024 ** 3, diskFree: 90 * 1024 ** 3 } });
    const chosen = step(base("node"), { servers: [a, b], serverId: "b" });
    expect(chosen).toContain("8 CPUs");
    expect(chosen).toContain("11 GB of 16 GB RAM free · 90 GB disk free");
    expect(chosen).not.toContain("1.2 GB of 4.0 GB");
    // one server only: named, with its numbers
    const only = step(base("node"), { servers: [a], serverId: "a" });
    expect(only).toContain("1.2 GB of 4.0 GB RAM free · 20 GB disk free");
    expect(step(base("node"), { servers: [server({ stats: { online: false } })] })).toContain("not answering");
  });

  it("shows the framework's options under Advanced, with the build limits and the environment file", () => {
    const out = step(base("vite"));
    expect(out).toContain("Advanced: build options, build limits, environment file");
    expect(out).toContain("Vite options");
    expect(out).toContain('id="'); // fields
    expect(out).toContain("Build memory");
    expect(out).toContain("Build on the server&#x27;s network");
    expect(out).toContain("Single-page app fallback");
    const closed = step(base("vite"), { advancedOpen: false });
    expect(closed).not.toContain("Build memory");
    expect(closed).not.toContain("Build on the server&#x27;s network");
    expect(closed).toContain("Advanced: build options");
  });

  it("shows the release command the repository proposed, with why, and says nothing when it was typed", () => {
    const proposed = { ...base("nextjs"), release: "npx prisma migrate deploy" };
    expect(step(proposed, { releaseHint: "Suggested: prisma/migrations exists." })).toContain("Suggested: prisma/migrations exists.");
    expect(step(proposed)).not.toContain("Suggested:");
  });

  it("shows no framework options for the Dockerfile card, and the port help from the Dockerfile", () => {
    const out = step({ ...base("dockerfile"), port: "3000" }, { candidate: candidate() });
    expect(out).not.toContain("Dockerfile options");
    expect(out).toContain("Read from the Dockerfile&#x27;s EXPOSE");
    expect(out).toContain("Advanced: build limits, environment file");
    expect(step({ ...base("dockerfile"), port: "" }, { candidate: candidate({ port: null }) })).toContain("Enter the port the app listens on");
    expect(step({ ...base("dockerfile"), port: "" }, { candidate: candidate({ port: null, portFromVariable: true }) })).toContain("uses a variable");
    expect(step({ ...base("dockerfile"), port: "3000" }, { candidate: candidate({ healthcheck: true }) })).toContain("already waits for");
  });

  it("offers a domain, with the DNS plan, only on a Caddy server, and a local port with the reason otherwise", () => {
    const domain = step({ ...base("node"), domain: "shop.example.com" });
    expect(domain).toContain('value="domain"');
    expect(domain).toContain("Caddy obtains the certificate");
    expect(domain).toContain('data-testid="dns-plan-manual"');
    expect(domain).toContain("Create this DNS record yourself");
    for (const [proxy, reason] of [["other", "only offered with the Caddy proxy"], ["none", "has no proxy"]] as const) {
      const local = step({ ...base("node"), exposure: "local" }, {}, server({ context: ctx({ proxy }) }));
      expect(local).not.toContain('value="domain"');
      expect(local).toContain(reason);
      expect(local).toContain('value="8101"');
    }
  });

  it("fixes the port of a framework on a local port, and says why", () => {
    const out = step({ ...base("nextjs"), exposure: "local", port: "4000" });
    expect(out).toContain('value="3000"');
    expect(out).toContain("listens on 3000 on a local port");
    expect(step({ ...base("dockerfile"), exposure: "local", port: "4000" })).toContain('value="4000"');
  });

  it("offers previews only when the agent has a template, and the server only when there is a choice", () => {
    expect(step(base("node"))).not.toContain("preview of each pull request");
    expect(step(base("node"), { previewsOffered: true })).toContain("preview of each pull request");
    expect(step(base("node"))).not.toContain("Online servers that are not read-only here");
    const two = step(base("node"), { servers: [server(), server({ id: "b", name: "prod" })] });
    expect(two).toContain("Online servers that are not read-only here");
    expect(step(base("node"), { servers: [server(), server({ id: "b", name: "prod" })], serverFixed: true })).not.toContain("Online servers that are not read-only here");
  });

  it("shows the problems it is given beside their fields, and the name collision note", () => {
    const out = step(base("node"), { errors: { name: "This server already has an app named shop.", "options.node": "A Node.js major version, 18 or later", release: "One line." }, nameTaken: true });
    expect(out).toContain("This server already has an app named shop.");
    expect(out).toContain("A Node.js major version, 18 or later");
    expect(out).toContain("One line.");
    expect(out).toContain("another one");
  });
});

describe("the variables step", () => {
  const SECRET = "hunter2-very-secret-value";
  const vars = [{ key: "DATABASE_URL", value: SECRET, build: false }, { key: "NEXT_PUBLIC_API", value: "https://pub.example.org/xyz", build: true }];
  const step = (extra: Record<string, unknown> = {}) =>
    html(createElement(VariablesStep, { vars: [], onChange: () => {}, rules: {}, supported: true, serverId: "srv", serverName: "staging", issues: [], ...extra }));

  it("is optional: says so, offers the paste and the one-by-one form, and keeps the value field masked", () => {
    const out = step();
    expect(out).toContain("Optional");
    expect(out).toContain("Paste a .env file");
    expect(out).toContain("Add one variable");
    expect(out).toContain('type="password"');
    expect(out).toContain("No variable yet");
    expect(out).toContain("before</strong> the first build");
    expect(out).toContain("not in the address bar or the browser");
  });

  it("lists the names with a mask, the build-time box, and the warning, never a value", () => {
    const out = step({ vars });
    expect(out).toContain("DATABASE_URL");
    expect(out).toContain("NEXT_PUBLIC_API");
    expect(out).toContain(MASK);
    expect(out).toContain("baked into the image");
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("pub.example.org");
    expect((out.match(/checked=""/g) ?? []).length).toBe(1); // only the build-time one
  });

  it("flags a name that looks like a secret ticked for build time", () => {
    const out = html(createElement(VariableList, { vars: [{ key: "API_SECRET", value: "s", build: true }], onChange: () => {} }));
    expect(out).toContain("looks secret");
  });

  it("is disabled with the agent-too-old message, and a way to update, on an agent without the API", () => {
    const out = step({ supported: false });
    expect(out).toContain("This agent is too old to manage variables");
    expect(out).toContain('href="/servers/srv/update"');
    expect(out).not.toContain("Paste a .env file");
    expect(out).not.toContain('type="password"');
  });

  it("shows what the checks found, by name", () => {
    const out = step({ issues: [{ key: "KEELSON_X", message: "is set by Keelson" }] });
    expect(out).toContain("KEELSON_X");
    expect(out).toContain("is set by Keelson");
  });
});

describe("the review step", () => {
  const review = {
    name: "shop",
    branch: "main",
    preset: "nextjs" as const,
    options: { standalone: true, install: "pnpm i" },
    release: "npx prisma migrate deploy",
    dockerfile: "",
    context: ".",
    port: 3000,
    exposure: { kind: "domain" as const, domain: "shop.example.com" },
    healthPath: "/",
    memory: "2g",
    cpus: 2,
    timeout: "15m",
    buildHostNetwork: false,
    buildDatabase: false,
    envFile: "",
    buildOnPush: true,
    previews: false,
  };
  const step = (extra: Record<string, unknown> = {}) =>
    html(createElement(ReviewStep, { repo: "acme/shop", serverName: "staging", review, variables: [{ key: "DATABASE_URL", build: false }, { key: "NEXT_PUBLIC_API", build: true }], envSupported: true, database: false, dns: "Keelson creates A shop.example.com → 203.0.113.7 at Cloudflare, proxied.", errorCount: 0, ...extra }));

  it("lists everything that will be written, in the order it happens", () => {
    const out = step();
    for (const text of ["acme/shop, branch main", "staging", "keelson-local/shop", "Next.js", "Standalone output", "pnpm i", "3000", "https://shop.example.com", "npx prisma migrate deploy", "2g memory"]) expect(out).toContain(text);
    const order = ["Write the app into the server&#x27;s configuration", "Create the app&#x27;s PostgreSQL database", "Set the variables on the server", "Link the app to the repository", "Point the domain at the server", "Start the first build"].map((l) => out.indexOf(l));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(out).toContain("Keelson creates A shop.example.com");
  });

  it("summarises a database that is asked for as a line and a step, and says none was asked for otherwise", () => {
    const asked = step({ database: true });
    expect(asked).toContain("a new PostgreSQL database for shop");
    expect(asked).toContain("the backup key is shown once");
    expect(step()).not.toContain("a new PostgreSQL database for shop");
    expect(step()).toContain("none asked for");
  });

  it("names the variables with their build flag, and says the values are not shown", () => {
    const out = step();
    expect(out).toContain("Variables (2)");
    expect(out).toContain("DATABASE_URL");
    expect(out).toContain("available at build time");
    expect(out).toContain("Values are not shown");
  });

  it("says the variables are not set on an agent that is too old, and what a Dockerfile project writes", () => {
    expect(step({ envSupported: false })).toContain("too old to manage variables");
    const dockerfile = step({ review: { ...review, preset: "dockerfile", options: {}, dockerfile: "Dockerfile", release: "", exposure: { kind: "local", hostPort: 8101 }, healthPath: "" } });
    expect(dockerfile).toContain("Build context");
    expect(dockerfile).toContain("127.0.0.1:8101");
    expect(dockerfile).toContain("nothing");
  });

  it("is a notice, not a summary, while the form still has problems", () => {
    const out = step({ review: null, errorCount: 2 });
    expect(out).toContain("The form is not complete");
    expect(out).toContain("2 fields need attention");
  });
});

describe("the wizard", () => {
  const wizard = (extra: Record<string, unknown> = {}) => html(createElement(NewProjectWizard, { repos: REPOS, servers: [server()], ...extra }));

  it("starts on the repository step with nothing chosen, and shows its progress", () => {
    const out = wizard();
    for (const s of WIZARD_STEPS) expect(out).toContain(s.label);
    expect(out).toContain('aria-current="step"');
    expect(out).toContain("Step 1 of 5");
    expect(out).toContain("Choose the repository");
    expect(checked(out)).toBe(0); // no repository, no framework
    expect(out).toContain("Cancel");
    expect(out).toContain("Next");
  });

  it("opens on the framework step with the repository chosen from the address, and still no framework", () => {
    const out = wizard({ initialRepo: "acme/blog" });
    expect(out).toContain("Step 2 of 5");
    expect(out).toContain('value="blog"');
    expect(out).toContain('value="trunk"');
    expect(checked(out)).toBe(1); // the repository only
    expect(wizard({ initialRepo: "someone/else" })).toContain("Step 1 of 5"); // a repository the App cannot reach is not chosen
  });

  it("fills the domain in from the server's apps domain once a repository is chosen, and says where it comes from", () => {
    const withDomain = html(createElement(NewProjectWizard, { repos: REPOS, servers: [server({ appsDomain: "apps.example.com" })], initialRepo: "acme/blog", initialStep: "configure" }));
    expect(withDomain).toContain('value="blog.apps.example.com"');
    expect(withDomain).toContain("Filled in from this server&#x27;s apps domain (apps.example.com)");
    const without = html(createElement(NewProjectWizard, { repos: REPOS, servers: [server()], initialRepo: "acme/blog", initialStep: "configure" }));
    expect(without).not.toContain("blog.apps.example.com");
    expect(without).not.toContain("apps domain");
    // a server that cannot serve domains gets no domain, whatever its apps domain
    const noProxy = html(createElement(NewProjectWizard, { repos: REPOS, servers: [server({ appsDomain: "apps.example.com", context: ctx({ proxy: "none" }) })], initialRepo: "acme/blog", initialStep: "configure" }));
    expect(noProxy).not.toContain("blog.apps.example.com");
  });

  it("renders every step, with the later ones hidden and not lost, and the last button only on the review", () => {
    for (const s of WIZARD_STEPS) {
      const out = wizard({ initialStep: s.id });
      expect(out).toContain(`Step ${WIZARD_STEPS.findIndex((x) => x.id === s.id) + 1} of 5`);
      expect(out).toContain(s.id === "review" ? "Create the project and build it" : "Next");
      if (s.id !== "review") expect(out).not.toContain("Create the project and build it");
    }
  });

  it("takes the server from the address when given, and a server list otherwise", () => {
    const two = [server(), server({ id: "b", name: "prod" })];
    expect(wizard({ servers: two, initialStep: "configure" })).toContain("Online servers that are not read-only here");
    expect(wizard({ servers: two, initialServer: "b", initialStep: "configure" })).not.toContain("Online servers that are not read-only here");
  });

  it("puts nothing of the form in the markup that could be a secret: the variables start empty and stay in memory", () => {
    const out = wizard({ initialStep: "variables" });
    expect(out).toContain("No variable yet");
    expect(out).not.toMatch(/localStorage|sessionStorage/);
  });
});

describe("the outcome of an attempt", () => {
  const todo = (detail: string) => ({ state: "todo" as const, detail });
  const steps = (over: Record<string, { state: "done" | "failed" | "todo" | "skipped"; detail: string }> = {}) => ({
    config: { state: "done" as const, detail: "Written." },
    database: { state: "skipped" as const, detail: "No database asked for." },
    env: { state: "done" as const, detail: "2 variables set on the agent." },
    link: todo("Not done."),
    dns: todo("Not done."),
    build: todo("Not started."),
    ...over,
  });

  it("lists the steps in order, in a focusable block, with the retry of the failed one", () => {
    const outcome = { steps: steps({ link: { state: "failed", detail: "GitHub said no." } }), issues: [], retry: "link" as const };
    const out = html(createElement(ProgressPanel, { outcome, onRetry: () => {}, pending: false }));
    expect(out).toContain('tabindex="-1"');
    expect(out).toContain("The project was created, but not everything is done");
    expect(out).toContain("GitHub said no.");
    expect(out).toContain("Retry: link the app to the repository");
    const order = ["Write the app into the server&#x27;s configuration", "Create the app&#x27;s PostgreSQL database", "Set the variables on the server", "Link the app to the repository", "Point the domain at the server", "Start the first build"].map((l) => out.indexOf(l));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(order.every((i) => i >= 0)).toBe(true);
  });

  it("shows the variables the agent refused by name, and a retry of that step", () => {
    const outcome = { steps: steps({ env: { state: "failed", detail: "The variables could not be set: refused." } }), issues: [], retry: "env" as const, varIssues: [{ key: "DATABASE_URL", message: "too large" }] };
    const out = html(createElement(ProgressPanel, { outcome, onRetry: () => {}, pending: false }));
    expect(out).toContain("DATABASE_URL");
    expect(out).toContain("too large");
    expect(out).toContain("Retry: set the variables on the server");
  });

  it("says nothing was created when the first step failed", () => {
    const out = html(createElement(ProgressPanel, { outcome: { steps: steps({ config: { state: "failed", detail: "Nothing was written." } }), issues: [] }, onRetry: () => {}, pending: false }));
    expect(out).toContain("Nothing was created");
  });

  it("shows a skipped step with its own mark, and a blocked retry until the DNS decision is made", () => {
    const outcome = { steps: steps({ dns: { state: "failed", detail: "shop.example.com already has A 198.51.100.9." } }), issues: [], retry: "dns" as const };
    const out = html(createElement(ProgressPanel, { outcome, onRetry: () => {}, pending: false, retryBlocked: true, dnsDecision: createElement("p", null, "the decision") }));
    expect(out).toContain("the decision");
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*(<svg[^>]*><\/svg>)?Retry: point/);
    const skipped = html(createElement(ProgressPanel, { outcome: { steps: steps({ dns: { state: "skipped", detail: "Create A shop.example.com -> 203.0.113.7 yourself." }, env: { state: "skipped", detail: "No variables." } }), issues: [] }, onRetry: () => {}, pending: false }));
    expect(skipped).toContain("lucide-circle-minus");
  });
});

describe("the database option", () => {
  const card = (extra: Record<string, unknown> = {}) =>
    html(createElement(DatabaseCard, { enabled: false, onChange: () => {}, supported: true, serverId: "srv", serverName: "staging", existingUrl: false, buildDatabase: true, onBuildDatabase: () => {}, ...extra }));

  it("is offered on the variables step of a server whose agent can create databases, off until chosen", () => {
    const out = html(createElement(NewProjectWizard, { repos: REPOS, servers: [server()], initialStep: "variables" }));
    expect(out).toContain("Create a PostgreSQL database for this app");
    expect(out.match(/<input[^>]*id="new-project-database"[^>]*>/)?.[0]).not.toContain('checked=""');
  });

  it("says what it does: its own database and role, the variable it fills, the daily encrypted backup, the key given once", () => {
    const out = card();
    for (const text of ["staging runs one PostgreSQL", "DATABASE_URL", "every day at 03:00", "encrypted", "key to read those backups once"]) expect(out).toContain(text);
  });

  it("offers the build the database once it is chosen, says what that costs and what a new empty database lacks, and can be unticked", () => {
    expect(card()).not.toContain("can use this database too");
    const on = card({ enabled: true });
    expect(on).toContain("can use this database too");
    expect(on).toContain("build argument");
    expect(on).toContain("A new database has no tables");
    expect(on).toContain("prisma migrate deploy");
    expect(on.match(/<input[^>]*id="new-project-build-database"[^>]*>/)?.[0]).toContain('checked=""');
    const off = card({ enabled: true, buildDatabase: false });
    expect(off.match(/<input[^>]*id="new-project-build-database"[^>]*>/)?.[0]).not.toContain('checked=""');
  });

  it("tells the operator to remove a variable named like the one the database fills", () => {
    expect(card({ enabled: true, existingUrl: true })).toContain("is also in the variables below");
    expect(card({ enabled: false, existingUrl: true })).not.toContain("is also in the variables below");
  });

  it("says the agent is too old, with the way to update it, instead of offering a checkbox", () => {
    const out = card({ supported: false });
    expect(out).toContain("too old to create databases");
    expect(out).toContain("/servers/srv/update");
    expect(out).not.toContain("Create a PostgreSQL database");
  });

  it("says why the repository suggests a database, and that nothing is created unless it is ticked; the line goes once it is ticked", () => {
    const asked = card({ suggestion: "prisma/schema.prisma uses PostgreSQL." });
    expect(asked).toContain("Suggested: prisma/schema.prisma uses PostgreSQL.");
    expect(asked).toContain("Nothing is created unless you tick the box");
    expect(card({ suggestion: "x" , enabled: true })).not.toContain("Suggested:");
    expect(card()).not.toContain("Suggested:");
  });

  it("lists the variable names of the example file that are not already added, and nothing when all are", () => {
    const hint = (names: string[], already: string[]) => html(createElement(EnvNamesHint, { names, already }));
    const out = hint(["SESSION_SECRET", "API_URL", "NEXT_PUBLIC_X"], ["API_URL"]);
    expect(out).toContain("lists 2 variables");
    expect(out).toContain("SESSION_SECRET, NEXT_PUBLIC_X");
    expect(out).not.toContain("API_URL");
    expect(hint(["A"], [])).toContain("lists a variable");
    expect(hint(["A"], ["A"])).toBe("");
    expect(hint([], [])).toBe("");
  });
});

describe("the backup key notice", () => {
  const KEY = "AGE-SECRET-KEY-1TESTONLYNOTAREALKEY";
  const notice = (extra: Record<string, unknown> = {}) => html(createElement(BackupKeyNotice, { backupKey: KEY, saved: false, onSaved: () => {}, ...extra }));

  it("shows the key and says it is shown only once", () => {
    const out = notice();
    expect(out).toContain(KEY);
    expect(out).toContain("only here, only now");
  });

  it("keeps the way to the deployment closed until the operator says the key is saved, then opens it", () => {
    const href = "/servers/srv/deployments/dep-1";
    expect(notice({ deploymentHref: href })).not.toContain(`href="${href}"`);
    expect(notice({ deploymentHref: href })).toMatch(/<button[^>]*disabled=""[^>]*>Open the deployment/);
    expect(notice({ deploymentHref: href, saved: true })).toContain(`href="${href}"`);
  });

  it("offers no way on while a step of the creation is still to be retried", () => {
    expect(notice()).not.toContain("Open the deployment");
  });
});
