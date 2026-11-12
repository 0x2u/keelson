import { describe, expect, it } from "vitest";
import { cleanDnsChoice, cleanVars, createProject, retryCreateProject, type DatabaseCreation, type DnsChoice, type DnsStep, type ProjectDeps, type ProjectVar } from "@/lib/new-project-core";
import type { AppConfig, ConfigDocument, ConfigIssue, EnvIssue, SaveOptions, SaveResult } from "@/lib/agent-types";
import { PRESET_LIST } from "@/lib/presets-core";
import type { Review, ReviewInput } from "@/lib/repo-detect-core";

const CHOICE: DnsChoice = { create: true, proxied: true };

const SECRET_TOKEN = "ghs_installation_secret_1234";
const BACKUP_KEY = "AGE-SECRET-KEY-1TESTONLYNOTAREALKEY0000000000000000000000000000000000";

const doc = (apps: AppConfig[] = [], extra: Partial<ConfigDocument> = {}): ConfigDocument => ({
  content: "",
  hash: "hash-1",
  modified_at: "2026-01-01T00:00:00Z",
  applied_hash: "hash-1",
  model: { proxy: {}, apps },
  deprecations: [],
  ...extra,
});

const input = (extra: Partial<ReviewInput> = {}): ReviewInput => ({
  name: "shop",
  branch: "main",
  preset: "dockerfile",
  options: {},
  release: "",
  dockerfile: "Dockerfile",
  context: ".",
  port: "3000",
  exposure: "domain",
  domain: "shop.example.com",
  hostPort: "8100",
  healthPath: "",
  memory: "2g",
  cpus: "2",
  timeout: "15m",
  buildHostNetwork: false,
  buildDatabase: false,
  envFile: "",
  buildOnPush: true,
  previews: false,
  ...extra,
});

interface Fake {
  calls: string[];
  saved: { name: string; app: AppConfig; opts: SaveOptions }[];
  linked: Review[];
  audits: [string, string][];
  dnsAsked: { hostname: string; choice: DnsChoice }[];
  /** What was sent to the agent as variables: app and the pairs. */
  envSet: { app: string; vars: { key: string; value: string; build: boolean }[] }[];
  deps: ProjectDeps;
}

function fake(options: { doc?: ConfigDocument | null | Error; save?: SaveResult | Error; link?: Error; check?: string | null; build?: { ok: true; deploymentId: string } | { ok: false; error: string }; dns?: DnsStep | Error; envSupported?: boolean | Error; env?: { ok: true } | { ok: false; error: string; issues?: EnvIssue[] } | Error; database?: DatabaseCreation | Error } = {}): Fake {
  const f: Fake = { calls: [], saved: [], linked: [], audits: [], dnsAsked: [], envSet: [], deps: undefined as unknown as ProjectDeps };
  f.deps = {
    async config() {
      f.calls.push("config");
      const d = options.doc === undefined ? doc() : options.doc;
      if (d instanceof Error) throw d;
      return d;
    },
    async envSupported() {
      f.calls.push("envSupported");
      if (options.envSupported instanceof Error) throw options.envSupported;
      return options.envSupported ?? true;
    },
    async setEnv(app, vars) {
      f.calls.push("env");
      f.envSet.push({ app, vars });
      const r = options.env ?? { ok: true };
      if (r instanceof Error) throw r;
      return r.ok ? r : { ok: false, error: r.error, issues: r.issues ?? [] };
    },
    async check() {
      f.calls.push("check");
      return options.check ?? null;
    },
    async saveApp(name, app, opts) {
      f.calls.push("save");
      f.saved.push({ name, app, opts });
      const r = options.save ?? { ok: true, hash: "hash-2", issues: [] };
      if (r instanceof Error) throw r;
      return r;
    },
    async dns(hostname, choice) {
      f.calls.push("dns");
      f.dnsAsked.push({ hostname, choice });
      const r = options.dns ?? { kind: "created", zone: "example.com", record: { type: "A", content: "203.0.113.7", proxied: true } };
      if (r instanceof Error) throw r;
      return r;
    },
    link(review) {
      f.calls.push("link");
      if (options.link) throw options.link;
      f.linked.push(review);
    },
    async firstBuild() {
      f.calls.push("build");
      return options.build ?? { ok: true, deploymentId: "dep-1" };
    },
    async createDatabase(app) {
      f.calls.push("database");
      const r = options.database ?? { ok: true, database: { name: app, envKey: "DATABASE_URL", created: true, backupKey: BACKUP_KEY, backupRecipient: "age1publichalf" } };
      if (r instanceof Error) throw r;
      return r;
    },
    audit(event, detail) {
      f.audits.push([event, detail]);
    },
    describe: (err) => (err instanceof Error ? err.message : "unexpected"),
  };
  return f;
}

describe("createProject", () => {
  it("writes the config, sets the variables, links, points the DNS, then starts the first build, in that order", async () => {
    const f = fake();
    const out = await createProject("acme/shop", input(), "staging", f.deps, CHOICE, [{ key: "A", value: "1", build: false }]);
    expect(f.calls).toEqual(["config", "envSupported", "check", "save", "env", "link", "dns", "build"]);
    expect(out.deploymentId).toBe("dep-1");
    expect(out.retry).toBeUndefined();
    expect(Object.values(out.steps).map((s) => s.state)).toEqual(["done", "skipped", "done", "done", "done", "done"]);
    expect(Object.keys(out.steps)).toEqual(["config", "database", "env", "link", "dns", "build"]);
    expect(f.audits.map(([event]) => event)).toEqual(["app_created_from_repo", "env_set", "repo_linked", "build_modes", "first_build_started"]);
  });

  it("skips the variables step, without asking the agent about them, when there are none", async () => {
    const f = fake();
    const out = await createProject("acme/shop", input(), "staging", f.deps, CHOICE);
    expect(f.calls).toEqual(["config", "check", "save", "link", "dns", "build"]);
    expect(out.steps.env).toEqual({ state: "skipped", detail: "No variables." });
  });

  it("writes the app with the hash it read, a comment, and the block built from the form", async () => {
    const f = fake();
    await createProject("acme/shop", input({ healthPath: "/healthz" }), "staging", f.deps, CHOICE);
    expect(f.saved).toHaveLength(1);
    expect(f.saved[0]).toMatchObject({
      name: "shop",
      opts: { base_hash: "hash-1", comment: "Created from acme/shop by the dashboard" },
      app: { name: "shop", image: "keelson-local/shop", port: 3000, domains: ["shop.example.com"], health_path: "/healthz", build: { dockerfile: "Dockerfile", context: ".", memory: "2g", cpus: 2, timeout: "15m" } },
    });
  });

  it("links with the branch and the build modes the form chose", async () => {
    const f = fake();
    await createProject("acme/shop", input({ branch: "release", buildOnPush: false }), "staging", f.deps, CHOICE);
    expect(f.linked[0]).toMatchObject({ name: "shop", branch: "release", buildOnPush: false, previews: false });
  });

  it("links previews for an app that has a previews template, also on a retry", async () => {
    const f = fake({ doc: doc([{ name: "shop", image: "keelson-local/shop", previews: { domain: "pr-{pr}-shop.example.com" } }]) });
    await retryCreateProject(input({ previews: true }), "link", "staging", f.deps, CHOICE);
    expect(f.linked[0]).toMatchObject({ name: "shop", previews: true });
  });

  it("refuses previews for a new app: the template is a key of the app, so it does not exist before the app does", async () => {
    const f = fake();
    const out = await createProject("acme/shop", input({ previews: true }), "staging", f.deps, CHOICE);
    expect(out.fieldErrors?.previews).toMatch(/previews/);
    expect(f.saved).toEqual([]);
  });

  it("refuses an existing name before writing anything", async () => {
    const f = fake({ doc: doc([{ name: "shop", image: "x" }]) });
    const out = await createProject("acme/shop", input(), "staging", f.deps, CHOICE);
    expect(out.fieldErrors?.name).toMatch(/already has an app named shop/);
    expect(f.calls).toEqual(["config"]);
    expect(f.audits).toEqual([]);
  });

  it("refuses an invalid form with the problems by field, and writes nothing", async () => {
    const f = fake();
    const out = await createProject("acme/shop", input({ port: "", name: "Bad Name" }), "staging", f.deps, CHOICE);
    expect(Object.keys(out.fieldErrors ?? {}).sort()).toEqual(["name", "port"]);
    expect(f.calls).toEqual(["config"]);
  });

  it("offers a domain only when the agent's proxy is Caddy", async () => {
    const f = fake({ doc: doc([], { model: { apps: [] } }) });
    const out = await createProject("acme/shop", input(), "staging", f.deps, CHOICE);
    expect(out.fieldErrors?.exposure).toMatch(/no proxy section/);
    expect(f.saved).toEqual([]);
  });

  it("passes the agent's validation issues through verbatim and writes nothing else", async () => {
    const issues: ConfigIssue[] = [
      { severity: "error", path: "apps[shop].build.memory", message: "build: memory must be at least 64m", line: 12 },
      { severity: "warning", path: "apps[shop]", message: "image keelson-local/shop has no tag" },
    ];
    const f = fake({ save: { ok: false, kind: "invalid", message: "the configuration is invalid", issues } });
    const out = await createProject("acme/shop", input(), "staging", f.deps, CHOICE);
    expect(out.issues).toEqual(issues);
    expect(out.steps.config).toEqual({ state: "failed", detail: "the configuration is invalid" });
    expect(out.steps.link.state).toBe("todo");
    expect(out.steps.build.state).toBe("todo");
    expect(out.retry).toBeUndefined();
    expect(f.calls).toEqual(["config", "check", "save"]);
    expect(f.audits).toEqual([]);
  });

  it("keeps the warnings of an accepted write", async () => {
    const warning: ConfigIssue = { severity: "warning", path: "proxy", message: "something to know" };
    const f = fake({ save: { ok: true, hash: "h", issues: [warning] } });
    expect((await createProject("acme/shop", input(), "staging", f.deps, CHOICE)).issues).toEqual([warning]);
  });

  it("says when the configuration changed meanwhile, and when the agent is unreachable", async () => {
    const changed = await createProject("acme/shop", input(), "s", fake({ save: { ok: false, kind: "changed", issues: [], hash: "x" } }).deps, CHOICE);
    expect(changed.steps.config.detail).toMatch(/changed by someone else/);
    const down = await createProject("acme/shop", input(), "s", fake({ doc: new Error("connection refused") }).deps, CHOICE);
    expect(down.steps.config).toEqual({ state: "failed", detail: "The agent's configuration could not be read: connection refused" });
    const lost = fake({ save: new Error("timeout") });
    const out = await createProject("acme/shop", input(), "s", lost.deps, CHOICE);
    expect(out.steps.config.detail).toMatch(/could not be asked to write the app: timeout/);
    expect(lost.linked).toEqual([]);
  });

  it("does not write when the agent has no apps file or an invalid one", async () => {
    expect((await createProject("a/b", input(), "s", fake({ doc: null }).deps, CHOICE)).steps.config.detail).toMatch(/no configuration to write to/);
    const f = fake({ doc: doc([], { error: "yaml: line 3: bad" }) });
    expect((await createProject("a/b", input(), "s", f.deps, CHOICE)).steps.config.detail).toMatch(/currently invalid: yaml: line 3/);
    expect(f.saved).toEqual([]);
  });

  it("does not write when the repository or branch cannot be read", async () => {
    const f = fake({ check: "GitHub has no such branch." });
    const out = await createProject("acme/shop", input(), "s", f.deps, CHOICE);
    expect(out.steps.config).toEqual({ state: "failed", detail: "Nothing was written. GitHub has no such branch." });
    expect(f.calls).toEqual(["config", "check"]);
  });

  it("keeps the written app when the link fails, says so, and offers the link step", async () => {
    const f = fake({ link: new Error("disk full") });
    const out = await createProject("acme/shop", input(), "staging", f.deps, CHOICE);
    expect(f.saved).toHaveLength(1);
    expect(out.steps.config.state).toBe("done");
    expect(out.steps.link.state).toBe("failed");
    expect(out.steps.dns.state).toBe("todo");
    expect(out.steps.build.state).toBe("todo");
    expect(out.retry).toBe("link");
    expect(f.calls).not.toContain("build");
    expect(out.deploymentId).toBeUndefined();
  });

  it("keeps the app and the link when the first build fails, and offers the build step", async () => {
    const f = fake({ build: { ok: false, error: "a deployment is already running" } });
    const out = await createProject("acme/shop", input(), "staging", f.deps, CHOICE);
    expect(out.steps).toEqual({
      config: { state: "done", detail: expect.stringContaining("shop") },
      database: { state: "skipped", detail: "No database asked for." },
      env: { state: "skipped", detail: "No variables." },
      link: { state: "done", detail: expect.stringContaining("Linked") },
      dns: { state: "done", detail: expect.stringContaining("Created A shop.example.com") },
      build: { state: "failed", detail: "a deployment is already running" },
    });
    expect(out.retry).toBe("build");
    expect(f.audits.map(([e]) => e)).toEqual(["app_created_from_repo", "repo_linked", "build_modes", "first_build_failed"]);
  });

  it("is not stopped by an audit that cannot be written when it reports a failed build", async () => {
    const f = fake({ build: { ok: false, error: "nope" } });
    const failing = { ...f.deps, audit: (event: string) => { if (event === "first_build_failed") throw new Error("db locked"); } };
    expect((await createProject("acme/shop", input(), "s", failing, CHOICE)).retry).toBe("build");
  });

  it("never puts a token or secret in the outcome or the audit entries", async () => {
    const f = fake({ build: { ok: false, error: "the agent cannot build this app: bad Dockerfile" } });
    const out = await createProject("acme/shop", input({ envFile: "/etc/keelson/shop.env" }), "staging", f.deps, CHOICE);
    const text = JSON.stringify([out, f.audits, f.saved]);
    expect(text).not.toContain(SECRET_TOKEN);
    expect(text).not.toMatch(/ghs_|BEGIN|password/i);
  });
});

describe("retryCreateProject", () => {
  const written = doc([{ name: "shop", image: "keelson-local/shop", port: 3000, domains: ["shop.example.com"] }]);

  it("from the link step: links, points the DNS, then builds, and writes nothing to the config", async () => {
    const f = fake({ doc: written });
    const out = await retryCreateProject(input(), "link", "staging", f.deps, CHOICE);
    expect(f.calls).toEqual(["config", "link", "dns", "build"]);
    expect(f.saved).toEqual([]);
    expect(out.deploymentId).toBe("dep-1");
    expect(f.audits.map(([e]) => e)).toEqual(["repo_linked", "build_modes", "first_build_started"]);
  });

  it("from the build step: only builds, without linking again", async () => {
    const f = fake({ doc: written });
    const out = await retryCreateProject(input(), "build", "staging", f.deps, CHOICE);
    expect(f.calls).toEqual(["config", "build"]);
    expect(out.deploymentId).toBe("dep-1");
  });

  it("fails again with the build's own reason and keeps offering the retry", async () => {
    const f = fake({ doc: written, build: { ok: false, error: "the agent is shutting down" } });
    const out = await retryCreateProject(input(), "build", "staging", f.deps, CHOICE);
    expect(out.retry).toBe("build");
    expect(out.steps.build.detail).toBe("the agent is shutting down");
  });

  it("does not accept the app's own name, domain or port as a clash", async () => {
    const withPort = doc([{ name: "shop", image: "i", publish: ["127.0.0.1:8100:3000"] }]);
    const f = fake({ doc: withPort });
    const out = await retryCreateProject(input({ exposure: "local", hostPort: "8100" }), "link", "staging", f.deps, CHOICE);
    expect(out.fieldErrors).toBeUndefined();
    expect(out.deploymentId).toBe("dep-1");
  });

  it("says so, and does nothing, when the app is no longer in the agent's configuration", async () => {
    const f = fake({ doc: doc([]) });
    const out = await retryCreateProject(input(), "link", "staging", f.deps, CHOICE);
    expect(out.steps.config.state).toBe("failed");
    expect(out.steps.config.detail).toMatch(/not in the agent's configuration/);
    expect(f.calls).toEqual(["config"]);
  });

  it("reports an agent that cannot be read for the step being retried", async () => {
    const out = await retryCreateProject(input(), "build", "staging", fake({ doc: new Error("refused") }).deps, CHOICE);
    expect(out.steps.build).toEqual({ state: "failed", detail: "The agent could not be read to retry: refused" });
    expect(out.steps.config.state).toBe("done");
    expect(out.retry).toBe("build");
  });
});

describe("the DNS step", () => {
  const written = doc([{ name: "shop", image: "keelson-local/shop", port: 3000, domains: ["shop.example.com"] }]);
  const conflict: DnsStep = { kind: "conflict", zone: "example.com", existing: [{ type: "A", content: "198.51.100.9", proxied: false }], confirm: "A 198.51.100.9" };

  it("runs after the link and before the build, for the domain of the form, with the choice that was made", async () => {
    const f = fake();
    await createProject("acme/shop", input(), "staging", f.deps, { create: true, proxied: false });
    expect(f.calls.indexOf("link")).toBe(f.calls.indexOf("save") + 1);
    expect(f.calls.indexOf("dns")).toBe(f.calls.indexOf("link") + 1);
    expect(f.calls.indexOf("build")).toBe(f.calls.indexOf("dns") + 1);
    expect(f.dnsAsked).toEqual([{ hostname: "shop.example.com", choice: { create: true, proxied: false } }]);
  });

  it("is skipped, without asking anyone, for an app on a local port", async () => {
    const f = fake();
    const out = await createProject("acme/shop", input({ exposure: "local", hostPort: "8100" }), "staging", f.deps, CHOICE);
    expect(f.calls).not.toContain("dns");
    expect(out.steps.dns).toEqual({ state: "skipped", detail: expect.stringContaining("local port") });
    expect(out.deploymentId).toBe("dep-1");
  });

  it("leaves the record to the operator when asked to, with the exact values, and goes on", async () => {
    const f = fake({ dns: { kind: "skipped", message: "Not created by Keelson. Create A shop.example.com -> 203.0.113.7 at your DNS provider yourself." } });
    const out = await createProject("acme/shop", input(), "staging", f.deps, { create: false, proxied: true });
    expect(out.steps.dns).toEqual({ state: "skipped", detail: "Not created by Keelson. Create A shop.example.com -> 203.0.113.7 at your DNS provider yourself." });
    expect(out.steps.link.state).toBe("done");
    expect(out.deploymentId).toBe("dep-1");
  });

  it("stops at a record that is not ours to overwrite: the app stays written, nothing later runs, the retry is the DNS step", async () => {
    const f = fake({ dns: conflict });
    const out = await createProject("acme/shop", input(), "staging", f.deps, CHOICE);
    expect(out.steps.config.state).toBe("done");
    expect(out.steps.dns.state).toBe("failed");
    expect(out.steps.dns.detail).toContain("A 198.51.100.9");
    expect(out.steps.link.state).toBe("done");
    expect(out.steps.build.state).toBe("todo");
    expect(out.retry).toBe("dns");
    expect(out.dnsProblem).toEqual({ kind: "conflict", confirm: "A 198.51.100.9", existing: [{ type: "A", content: "198.51.100.9", proxied: false }] });
    expect(out.deploymentId).toBeUndefined();
    expect(f.calls).toEqual(["config", "check", "save", "link", "dns"]); // never rolled back, never built
    expect(f.audits.map(([e]) => e)).toEqual(["app_created_from_repo", "repo_linked", "build_modes", "dns_failed"]);
  });

  it("retried with the confirmation, replaces, then builds", async () => {
    const f = fake({ doc: written });
    await retryCreateProject(input(), "dns", "staging", f.deps, { create: true, proxied: true, confirmReplace: "A 198.51.100.9" });
    expect(f.dnsAsked[0]!.choice.confirmReplace).toBe("A 198.51.100.9");
    expect(f.calls).toEqual(["config", "dns", "build"]);
    expect(f.saved).toEqual([]);
  });

  it("retried and failing again keeps the retry on the DNS step and the later steps unrun", async () => {
    const f = fake({ doc: written, dns: conflict });
    const out = await retryCreateProject(input(), "dns", "staging", f.deps, CHOICE);
    expect(out.retry).toBe("dns");
    expect(out.dnsProblem?.kind).toBe("conflict");
    expect(f.calls).toEqual(["config", "dns"]);
  });

  it("reports a private address as a decision of the operator", async () => {
    const f = fake({ dns: { kind: "private", ip: "10.0.0.5", message: "10.0.0.5 is a private network address: ..." } });
    const out = await createProject("acme/shop", input(), "staging", f.deps, CHOICE);
    expect(out.dnsProblem).toEqual({ kind: "private", ip: "10.0.0.5" });
    expect(out.retry).toBe("dns");
  });

  it("reports a missing zone, a missing connection or a Cloudflare failure as a failed step with no decision to make", async () => {
    for (const result of [
      { kind: "no_zone", message: "No Cloudflare zone covers shop.example.com" },
      { kind: "not_connected", message: "Cloudflare is not connected" },
      { kind: "failed", message: "Cloudflare's request limit was reached." },
    ] as const) {
      const out = await createProject("acme/shop", input(), "staging", fake({ dns: result }).deps, CHOICE);
      expect(out.steps.dns).toEqual({ state: "failed", detail: result.message });
      expect(out.dnsProblem).toBeUndefined();
      expect(out.retry).toBe("dns");
    }
  });

  it("turns a dependency that throws into a failed step instead of losing the outcome", async () => {
    const out = await createProject("acme/shop", input(), "staging", fake({ dns: new Error("socket hang up with token abc") }).deps, CHOICE);
    expect(out.steps.dns.state).toBe("failed");
    expect(JSON.stringify(out)).not.toContain("abc");
    expect(out.retry).toBe("dns");
  });

  it("is not repeated when the build step is retried, and its earlier outcome stays shown", async () => {
    const done = fake({ doc: written });
    const out = await retryCreateProject(input(), "build", "staging", done.deps, { create: true, proxied: true });
    expect(done.calls).not.toContain("dns");
    expect(out.steps.dns.state).toBe("done");
    const manual = fake({ doc: written });
    expect((await retryCreateProject(input(), "build", "staging", manual.deps, { create: false, proxied: true })).steps.dns.state).toBe("skipped");
  });

  it("is the step reported when the agent cannot be read for its retry", async () => {
    const out = await retryCreateProject(input(), "dns", "staging", fake({ doc: new Error("refused") }).deps, CHOICE);
    expect(out.steps.dns).toEqual({ state: "failed", detail: "The agent could not be read to retry: refused" });
    expect(out.retry).toBe("dns");
  });
});

describe("cleanDnsChoice", () => {
  it("accepts only what a client may decide, and nothing else", () => {
    expect(cleanDnsChoice({ create: true, proxied: false, confirmReplace: "A 1.2.3.4", allowPrivate: true, extra: "x" })).toEqual({ create: true, proxied: false, confirmReplace: "A 1.2.3.4", allowPrivate: true });
    expect(cleanDnsChoice({ create: "yes", allowPrivate: "true", confirmReplace: 5 })).toEqual({ create: false, proxied: true });
    expect(cleanDnsChoice(undefined)).toEqual({ create: false, proxied: true });
    expect(cleanDnsChoice({ confirmReplace: "x".repeat(900) }).confirmReplace).toHaveLength(500);
  });
});

const PW = "SuperSecretPw1-zzz";
const PUBLIC = "https://api.example.com/public-9";
const VARS: ProjectVar[] = [
  { key: "DATABASE_URL", value: PW, build: false },
  { key: "NEXT_PUBLIC_API", value: PUBLIC, build: true },
];

describe("the variables step", () => {
  it("sets them on the agent after the app is written and before the first build, build flags included", async () => {
    const f = fake();
    await createProject("acme/shop", input(), "staging", f.deps, CHOICE, VARS);
    expect(f.calls.indexOf("env")).toBe(f.calls.indexOf("save") + 1);
    expect(f.calls.indexOf("env")).toBeLessThan(f.calls.indexOf("build"));
    expect(f.envSet).toEqual([{ app: "shop", vars: VARS }]);
    expect(f.audits.find(([e]) => e === "env_set")).toEqual(["env_set", "staging: shop (app): DATABASE_URL, NEXT_PUBLIC_API (build: NEXT_PUBLIC_API)"]);
  });

  it("never lets a value into the outcome, the audit entries or the config it writes, success or failure", async () => {
    const ok = fake();
    const done = await createProject("acme/shop", input(), "staging", ok.deps, CHOICE, VARS);
    const echoing = fake({ env: { ok: false, error: `the agent said no to ${PW} and ${PUBLIC}`, issues: [{ key: "DATABASE_URL", message: `bad value ${PW}` }] } });
    const failed = await createProject("acme/shop", input(), "staging", echoing.deps, CHOICE, VARS);
    const thrown = fake({ env: new Error(`socket closed while sending ${PW}`) });
    const crashed = await createProject("acme/shop", input(), "staging", thrown.deps, CHOICE, VARS);
    const retried = await retryCreateProject(input(), "env", "staging", echoing.deps, CHOICE, VARS);
    for (const f of [ok, echoing, thrown]) {
      const text = JSON.stringify([f.audits, f.saved]);
      expect(text).not.toContain(PW);
      expect(text).not.toContain(PUBLIC);
    }
    for (const out of [done, failed, crashed, retried]) {
      const text = JSON.stringify(out);
      expect(text).not.toContain(PW);
      expect(text).not.toContain(PUBLIC);
    }
    expect(failed.steps.env.detail).toContain("[redacted]");
    expect(failed.varIssues).toEqual([{ key: "DATABASE_URL", message: "bad value [redacted]" }]);
  });

  it("keeps the written app when the variables are refused, stops before the link and the build, and offers the variables step", async () => {
    const f = fake({ env: { ok: false, error: "the change was refused and nothing was written", issues: [{ key: "DATABASE_URL", message: "too large" }] } });
    const out = await createProject("acme/shop", input(), "staging", f.deps, CHOICE, VARS);
    expect(f.saved).toHaveLength(1);
    expect(out.steps.config.state).toBe("done");
    expect(out.steps.env).toEqual({ state: "failed", detail: "The variables could not be set: the change was refused and nothing was written" });
    expect(out.steps.link.state).toBe("todo");
    expect(out.steps.build.state).toBe("todo");
    expect(out.retry).toBe("env");
    expect(out.varIssues).toEqual([{ key: "DATABASE_URL", message: "too large" }]);
    expect(f.calls).not.toContain("link");
    expect(f.calls).not.toContain("build");
    expect(f.audits.map(([e]) => e)).toEqual(["app_created_from_repo", "env_set_failed"]);
  });

  it("retried from the variables step, sends them again (nothing kept them) and goes on through link, DNS and build without rewriting the app", async () => {
    const f = fake({ doc: doc([{ name: "shop", image: "keelson-local/shop", port: 3000, domains: ["shop.example.com"] }]) });
    const out = await retryCreateProject(input(), "env", "staging", f.deps, CHOICE, VARS);
    expect(f.calls).toEqual(["config", "env", "link", "dns", "build"]);
    expect(f.envSet[0]!.vars).toEqual(VARS);
    expect(f.saved).toEqual([]);
    expect(out.deploymentId).toBe("dep-1");
  });

  it("is not repeated when a later step is retried, and its earlier outcome stays shown", async () => {
    const written = doc([{ name: "shop", image: "keelson-local/shop", port: 3000, domains: ["shop.example.com"] }]);
    const f = fake({ doc: written });
    const out = await retryCreateProject(input(), "build", "staging", f.deps, CHOICE, VARS);
    expect(f.calls).toEqual(["config", "build"]);
    expect(out.steps.env).toEqual({ state: "done", detail: "The variables were set earlier." });
  });

  it("on an agent without the variables API refuses to write when there are variables, with the agent-too-old message", async () => {
    const f = fake({ envSupported: false });
    const out = await createProject("acme/shop", input(), "staging", f.deps, CHOICE, VARS);
    expect(out.steps.config.state).toBe("failed");
    expect(out.steps.config.detail).toContain("Nothing was written");
    expect(out.steps.config.detail).toContain("too old to manage variables");
    expect(f.calls).toEqual(["config", "envSupported"]);
  });

  it("on that same agent, creates the project when the variables step was left empty", async () => {
    const f = fake({ envSupported: false });
    const out = await createProject("acme/shop", input(), "staging", f.deps, CHOICE, []);
    expect(f.calls).not.toContain("envSupported");
    expect(out.deploymentId).toBe("dep-1");
    expect(out.steps.env.state).toBe("skipped");
  });

  it("writes nothing when the agent cannot be asked about variables", async () => {
    const f = fake({ envSupported: new Error("refused") });
    const out = await createProject("acme/shop", input(), "staging", f.deps, CHOICE, VARS);
    expect(out.steps.config.detail).toMatch(/Nothing was written.*refused/);
    expect(f.saved).toEqual([]);
  });

  it("refuses names the agent reserves, before writing: PORT with a domain or a framework, KEELSON_*", async () => {
    const bad = [{ key: "KEELSON_X", value: "1", build: false }, { key: "PORT", value: "9", build: false }];
    const f = fake();
    const out = await createProject("acme/shop", input(), "staging", f.deps, CHOICE, bad);
    expect(out.varIssues?.map((i) => i.key).sort()).toEqual(["KEELSON_X", "PORT"]);
    expect(f.saved).toEqual([]);
    expect(JSON.stringify(out)).not.toContain('"value"');
    const local = fake();
    const ok = await createProject("acme/shop", input({ exposure: "local", hostPort: "8101" }), "staging", local.deps, CHOICE, [{ key: "PORT", value: "9", build: false }]);
    expect(ok.varIssues).toBeUndefined(); // a Dockerfile app on a local port owns its PORT
    const preset = await createProject("acme/shop", input({ preset: "node", port: "3000", exposure: "local", hostPort: "8101" }), "staging", fake().deps, CHOICE, [{ key: "PORT", value: "9", build: false }]);
    expect(preset.varIssues?.[0]?.key).toBe("PORT");
  });
});

describe("the database step", () => {
  const DB = true;

  it("creates the database after the app is written and before the variables and the build, and hands the backup key back once", async () => {
    const f = fake();
    const out = await createProject("acme/shop", input(), "staging", f.deps, CHOICE, [{ key: "A", value: "1", build: false }], DB);
    expect(f.calls).toEqual(["config", "envSupported", "check", "save", "database", "env", "link", "dns", "build"]);
    expect(out.steps.database).toEqual({ state: "done", detail: expect.stringContaining("DATABASE_URL") });
    expect(out.database).toEqual({ name: "shop", envKey: "DATABASE_URL", created: true, backupKey: BACKUP_KEY, backupRecipient: "age1publichalf" });
    expect(out.deploymentId).toBe("dep-1");
  });

  it("writes the key nowhere but the outcome: not in an audit line, a step detail or an issue", async () => {
    const f = fake();
    const out = await createProject("acme/shop", input(), "staging", f.deps, CHOICE, [], DB);
    expect(f.audits.map(([e]) => e)).toContain("database_created");
    expect(JSON.stringify(f.audits)).not.toContain(BACKUP_KEY);
    expect(JSON.stringify({ steps: out.steps, issues: out.issues })).not.toContain(BACKUP_KEY);
  });

  it("is skipped, and the agent not asked, when no database was asked for", async () => {
    const f = fake();
    const out = await createProject("acme/shop", input(), "staging", f.deps, CHOICE);
    expect(f.calls).not.toContain("database");
    expect(out.steps.database).toEqual({ state: "skipped", detail: "No database asked for." });
    expect(out.database).toBeUndefined();
  });

  it("stops at a failed database, keeps the app, and offers that step; later steps are not run", async () => {
    const f = fake({ database: { ok: false, error: "docker is not answering" } });
    const out = await createProject("acme/shop", input(), "staging", f.deps, CHOICE, [{ key: "A", value: "1", build: false }], DB);
    expect(f.calls).toEqual(["config", "envSupported", "check", "save", "database"]);
    expect(out.steps.config.state).toBe("done");
    expect(out.steps.database).toEqual({ state: "failed", detail: "The database could not be created: docker is not answering" });
    expect(out.steps.env.state).toBe("todo");
    expect(out.retry).toBe("database");
    expect(out.database).toBeUndefined();
    expect(f.audits.map(([e]) => e)).toEqual(["app_created_from_repo", "database_create_failed"]);
  });

  it("treats a thrown error like a refusal", async () => {
    const f = fake({ database: new Error("socket closed") });
    const out = await createProject("acme/shop", input(), "staging", f.deps, CHOICE, [], DB);
    expect(out.steps.database).toEqual({ state: "failed", detail: "The database could not be created: socket closed" });
    expect(out.retry).toBe("database");
  });

  it("still carries the key when a later step fails, so the operator can save it before retrying", async () => {
    const f = fake({ build: { ok: false, error: "a deployment is already running" } });
    const out = await createProject("acme/shop", input(), "staging", f.deps, CHOICE, [], DB);
    expect(out.retry).toBe("build");
    expect(out.database?.backupKey).toBe(BACKUP_KEY);
  });

  it("says the database existed when the agent only completed it, with no key to show", async () => {
    const f = fake({ database: { ok: true, database: { name: "shop", envKey: "DATABASE_URL", created: false } } });
    const out = await createProject("acme/shop", input(), "staging", f.deps, CHOICE, [], DB);
    expect(out.steps.database.detail).toContain("already existed");
    expect(out.database?.backupKey).toBeUndefined();
  });

  it("refuses, before anything is written, a variable typed for the one the database fills", async () => {
    const f = fake();
    const out = await createProject("acme/shop", input(), "staging", f.deps, CHOICE, [{ key: "DATABASE_URL", value: "postgres://x", build: false }], DB);
    expect(out.varIssues?.map((i) => i.key)).toEqual(["DATABASE_URL"]);
    expect(out.steps.config.state).toBe("todo");
    expect(f.calls).not.toContain("save");
    expect(f.calls).not.toContain("database");
    // without a database the same variable is fine
    const ok = fake();
    expect((await createProject("acme/shop", input(), "staging", ok.deps, CHOICE, [{ key: "DATABASE_URL", value: "postgres://x", build: false }])).varIssues).toBeUndefined();
  });

  it("is not created again by a retry of a later step, which reports it as done earlier", async () => {
    const f = fake({ doc: doc([{ name: "shop", image: "keelson-local/shop" }]) });
    const out = await retryCreateProject(input(), "env", "staging", f.deps, CHOICE, [], DB);
    expect(f.calls).not.toContain("database");
    expect(out.steps.database).toEqual({ state: "done", detail: "The database was created earlier." });
    expect(out.database).toBeUndefined();
  });

  it("is created again, idempotently, when the retry is of the database step itself", async () => {
    const f = fake({ doc: doc([{ name: "shop", image: "keelson-local/shop" }]), database: { ok: true, database: { name: "shop", envKey: "DATABASE_URL", created: false } } });
    const out = await retryCreateProject(input(), "database", "staging", f.deps, CHOICE, [], DB);
    expect(f.calls).toContain("database");
    expect(out.steps.database.state).toBe("done");
    expect(out.deploymentId).toBe("dep-1");
  });

  it("writes build.database into the app only when a database is created with the project, however the form was filled", async () => {
    const asked = fake();
    await createProject("acme/shop", input({ buildDatabase: true }), "staging", asked.deps, CHOICE, [], DB);
    expect(asked.saved[0]!.app.build?.database).toBe(true);
    const noDatabase = fake();
    await createProject("acme/shop", input({ buildDatabase: true }), "staging", noDatabase.deps, CHOICE, [], false);
    expect(noDatabase.saved[0]!.app.build).not.toHaveProperty("database");
    const unticked = fake();
    await createProject("acme/shop", input({ buildDatabase: false }), "staging", unticked.deps, CHOICE, [], DB);
    expect(unticked.saved[0]!.app.build).not.toHaveProperty("database");
  });
});

describe("cleanVars", () => {
  it("keeps strings only, the last of a name, and build only when exactly true", () => {
    expect(cleanVars([{ key: "A", value: "1", build: true }, { key: "A", value: "2", build: "yes" }, { key: 3, value: "x" }, null, { key: "B", value: 5 }, { key: "C", value: "" }])).toEqual([
      { key: "A", value: "2", build: false },
      { key: "C", value: "", build: false },
    ]);
    expect(cleanVars("nope")).toEqual([]);
  });
});

describe("the app written for each framework card", () => {
  for (const preset of PRESET_LIST.filter((p) => p.id !== "dockerfile")) {
    it(`${preset.label}: build.preset, no Dockerfile keys, the default port, the build limits`, async () => {
      const f = fake();
      await createProject("acme/shop", input({ preset: preset.id, port: String(preset.defaultPort), healthPath: preset.defaultHealthPath }), "staging", f.deps, CHOICE);
      expect(f.saved[0]!.app.build).toEqual({ preset: preset.id, memory: "2g", cpus: 2, timeout: "15m" });
      expect(f.saved[0]!.app.port).toBe(preset.defaultPort);
      expect(f.saved[0]!.app.health_path).toBe("/");
    });
  }

  it("carries the options of the preset it reads, trimmed, and nothing it does not read", async () => {
    const f = fake();
    await createProject(
      "acme/shop",
      input({ preset: "vite", port: "8080", options: { context: " web ", install: " pnpm i ", build_command: "pnpm build", output_dir: "dist/", node: "20", spa: false, standalone: true, start: "ignored" } }),
      "staging",
      f.deps,
      CHOICE,
    );
    expect(f.saved[0]!.app.build).toEqual({ preset: "vite", context: "web", install: "pnpm i", build_command: "pnpm build", output_dir: "dist", node: "20", spa: false, memory: "2g", cpus: 2, timeout: "15m" });
  });

  it("keeps the Dockerfile card's block as it was, without a preset", async () => {
    const f = fake();
    await createProject("acme/shop", input({ options: { start: "ignored" } }), "staging", f.deps, CHOICE);
    expect(f.saved[0]!.app.build).toEqual({ dockerfile: "Dockerfile", context: ".", memory: "2g", cpus: 2, timeout: "15m" });
  });

  it("refuses no framework, an unknown one, and an option the agent would refuse, by field", async () => {
    const none = await createProject("acme/shop", input({ preset: "" }), "staging", fake().deps, CHOICE);
    expect(none.fieldErrors?.preset).toMatch(/Choose how the project is built/);
    const unknown = await createProject("acme/shop", input({ preset: "rails" }), "staging", fake().deps, CHOICE);
    expect(unknown.fieldErrors?.preset).toBeDefined();
    const f = fake();
    const bad = await createProject("acme/shop", input({ preset: "node", port: "3000", options: { node: "12", start: "a\nb" } }), "staging", f.deps, CHOICE);
    expect(Object.keys(bad.fieldErrors ?? {}).sort()).toEqual(["options.node", "options.start"]);
    expect(f.saved).toEqual([]);
  });

  it("uses the framework's port when none is typed, and refuses another one on a local port (the image listens on its default)", async () => {
    const f = fake();
    await createProject("acme/shop", input({ preset: "nextjs", port: "" }), "staging", f.deps, CHOICE);
    expect(f.saved[0]!.app.port).toBe(3000);
    const local = await createProject("acme/shop", input({ preset: "nextjs", port: "4000", exposure: "local", hostPort: "8101" }), "staging", fake().deps, CHOICE);
    expect(local.fieldErrors?.port).toMatch(/listens on 3000/);
    const ok = fake();
    await createProject("acme/shop", input({ preset: "static", port: "8080", exposure: "local", hostPort: "8101" }), "staging", ok.deps, CHOICE);
    expect(ok.saved[0]!.app.publish).toEqual(["127.0.0.1:8101:8080"]);
    expect(ok.saved[0]!.app.port).toBeUndefined();
  });

  it("refuses a port below 1024 for the nginx frameworks, and a health path the generated image cannot carry", async () => {
    expect((await createProject("acme/shop", input({ preset: "static", port: "80" }), "staging", fake().deps, CHOICE)).fieldErrors?.port).toMatch(/below 1024/);
    expect((await createProject("acme/shop", input({ preset: "node", port: "3000", healthPath: "/a b" }), "staging", fake().deps, CHOICE)).fieldErrors?.healthPath).toBeDefined();
    expect((await createProject("acme/shop", input({ preset: "node", port: "3000", healthPath: "/h\"x" }), "staging", fake().deps, CHOICE)).fieldErrors?.healthPath).toMatch(/Letters, digits/);
  });
});

describe("the command to run before each deploy", () => {
  it("is stored as a release step that runs the command through sh -c, in the new image", async () => {
    const f = fake();
    await createProject("acme/shop", input({ release: "  npx prisma migrate deploy " }), "staging", f.deps, CHOICE);
    expect(f.saved[0]!.app.release).toEqual({ steps: [{ name: "release", container: { command: ["sh", "-c", "npx prisma migrate deploy"] } }] });
  });

  it("is left out when blank, and refused when it is not one line", async () => {
    const f = fake();
    await createProject("acme/shop", input({ release: "   " }), "staging", f.deps, CHOICE);
    expect(f.saved[0]!.app.release).toBeUndefined();
    const bad = await createProject("acme/shop", input({ release: "a\nb" }), "staging", fake().deps, CHOICE);
    expect(bad.fieldErrors?.release).toBeDefined();
  });
});
