import { describe, expect, it } from "vitest";
import type { AppConfig, ConfigDocument, SaveOptions, SaveResult } from "@/lib/agent-types";
import {
  buildImageApp,
  createImageProject,
  imageStepOf,
  parseImage,
  reachOf,
  retryImageProject,
  suggestImageName,
  validateImageProject,
  type ImageDeps,
  type ImageProjectInput,
  type ImageReview,
} from "@/lib/new-project-image-core";
import type { DnsChoice, ProjectVar } from "@/lib/new-project-core";
import type { ReviewContext } from "@/lib/repo-detect-core";

const DIGEST = `sha256:${"ab".repeat(32)}`;
const ctx = (extra: Partial<ReviewContext> = {}): ReviewContext => ({ existingNames: [], usedDomains: [], usedHostPorts: [], proxy: "none", previewApps: [], ...extra });
const input = (extra: Partial<ImageProjectInput> = {}): ImageProjectInput => ({ name: "whoami", image: "traefik/whoami:v1.10.3", port: "80", domain: "", hostPort: "8100", open: false, healthPath: "", ...extra });
const review = (extra: Partial<ImageProjectInput> = {}, context: ReviewContext = ctx()): ImageReview => {
  const out = validateImageProject(input(extra), context);
  if (!out.ok) throw new Error(JSON.stringify(out.errors));
  return out.review;
};

describe("parseImage", () => {
  it("splits the repository from the tag the first deployment asks for", () => {
    expect(parseImage("traefik/whoami:v1.10.3")).toEqual({ ok: true, repository: "traefik/whoami", target: { tag: "v1.10.3" }, version: "v1.10.3" });
    expect(parseImage("  nginx:1.27 ")).toMatchObject({ ok: true, repository: "nginx", target: { tag: "1.27" } });
  });

  it("keeps a registry's port out of the tag", () => {
    expect(parseImage("localhost:5000/shop/web:2")).toMatchObject({ ok: true, repository: "localhost:5000/shop/web", target: { tag: "2" } });
    expect(parseImage("ghcr.io/acme/web:latest")).toMatchObject({ ok: true, repository: "ghcr.io/acme/web", target: { tag: "latest" } });
  });

  it("deploys a digest exactly, and a digest wins over a tag written beside it", () => {
    expect(parseImage(`ghcr.io/acme/web@${DIGEST}`)).toEqual({ ok: true, repository: "ghcr.io/acme/web", target: { digest: DIGEST }, version: DIGEST });
    expect(parseImage(`ghcr.io/acme/web:v1@${DIGEST}`)).toMatchObject({ ok: true, repository: "ghcr.io/acme/web", target: { digest: DIGEST } });
  });

  it("asks for a version, and says what the Deploy button then does", () => {
    const out = parseImage("traefik/whoami");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/Add the version.*traefik\/whoami:1\.2\.3/);
    expect(parseImage("localhost:5000/web").ok).toBe(false); // a registry port is not a tag
  });

  it("refuses what Docker would not accept, each with its own message", () => {
    for (const bad of ["", "Traefik/Whoami:v1", "a b:v1", "web:", "web:-x", "web@sha256:abc", "https://web:v1", "/web:v1"]) expect(parseImage(bad).ok, bad).toBe(false);
    const empty = parseImage("");
    if (!empty.ok) expect(empty.error).toMatch(/traefik\/whoami:v1\.10\.3/);
  });
});

describe("suggestImageName", () => {
  it("is the last part of the repository, as an app name", () => {
    expect(suggestImageName("traefik/whoami:v1.10.3", [])).toBe("whoami");
    expect(suggestImageName("ghcr.io/acme/My.Web:1", [])).toBe("my-web");
    expect(suggestImageName("nginx", [])).toBe("nginx");
  });
  it("numbers it when the server has an app of that name, and falls back for text that is no image yet", () => {
    expect(suggestImageName("traefik/whoami:v1", ["whoami", "whoami-2"])).toBe("whoami-3");
    expect(suggestImageName("traefik/", [])).toBe("app");
  });
});

describe("validateImageProject", () => {
  it("accepts the default form: a local port on 127.0.0.1, nothing required of GitHub, a domain or variables", () => {
    expect(review()).toEqual({ name: "whoami", repository: "traefik/whoami", target: { tag: "v1.10.3" }, version: "v1.10.3", port: 80, exposure: { kind: "local", hostPort: 8100, open: false }, healthPath: "" });
  });

  it("reports every problem by field", () => {
    const out = validateImageProject(input({ name: "Who Am I", image: "traefik/whoami", port: "99999", hostPort: "0" }), ctx());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(Object.keys(out.errors).sort()).toEqual(["image", "name", "port"]);
    const local = validateImageProject(input({ hostPort: "x" }), ctx());
    if (!local.ok) expect(local.errors.hostPort).toMatch(/1 to 65535/);
  });

  it("refuses a name or a local port the server already has, and a domain it already serves", () => {
    const taken = validateImageProject(input(), ctx({ existingNames: ["whoami"], usedHostPorts: [8100] }));
    if (taken.ok) throw new Error("should fail");
    expect(taken.errors.name).toMatch(/already has an app named whoami/);
    expect(taken.errors.hostPort).toMatch(/8100 is already used/);
    const domain = validateImageProject(input({ domain: "who.example.com" }), ctx({ proxy: "caddy", usedDomains: ["who.example.com"] }));
    if (!domain.ok) expect(domain.errors.domain).toMatch(/already serves/);
  });

  it("serves a domain only with Caddy, and only with a port to forward to", () => {
    const none = validateImageProject(input({ domain: "who.example.com" }), ctx({ proxy: "none" }));
    if (none.ok) throw new Error("should fail");
    expect(none.errors.domain).toMatch(/no proxy section.*local port/);
    const other = validateImageProject(input({ domain: "who.example.com" }), ctx({ proxy: "other" }));
    if (!other.ok) expect(other.errors.domain).toMatch(/only offered with the Caddy proxy/);
    const noPort = validateImageProject(input({ domain: "who.example.com", port: "" }), ctx({ proxy: "caddy" }));
    if (noPort.ok) throw new Error("should fail");
    expect(noPort.errors.port).toMatch(/domain needs the port/);
    expect(validateImageProject(input({ domain: "not a host" }), ctx({ proxy: "caddy" })).ok).toBe(false);
    expect(review({ domain: "Who.Example.com", healthPath: "/up" }, ctx({ proxy: "caddy" })).exposure).toEqual({ kind: "domain", domain: "who.example.com" });
  });

  it("accepts an empty port: the container publishes nothing", () => {
    expect(review({ port: "" }).exposure).toEqual({ kind: "none" });
    expect(review({ port: "" }).port).toBeNull();
  });

  it("checks the health path only with a domain: the agent ignores it on a local port", () => {
    expect(validateImageProject(input({ healthPath: "healthz" }), ctx()).ok).toBe(true);
    expect(review({ healthPath: "healthz" }).healthPath).toBe("");
    const bad = validateImageProject(input({ domain: "who.example.com", healthPath: "healthz" }), ctx({ proxy: "caddy" }));
    if (bad.ok) throw new Error("should fail");
    expect(bad.errors.healthPath).toMatch(/starts with \//);
  });
});

describe("buildImageApp", () => {
  it("stores the repository only, restarts with the server, and publishes the port on loopback (an in-place app: no port, no domains)", () => {
    expect(buildImageApp(review())).toEqual({ name: "whoami", image: "traefik/whoami", restart: "unless-stopped", publish: ["127.0.0.1:8100:80"] });
  });
  it("publishes on every interface only when asked", () => {
    expect(buildImageApp(review({ open: true })).publish).toEqual(["0.0.0.0:8100:80"]);
  });
  it("routes a domain through the proxy with the port, and the health path when there is one", () => {
    const app = buildImageApp(review({ domain: "who.example.com", healthPath: "/up" }, ctx({ proxy: "caddy" })));
    expect(app).toEqual({ name: "whoami", image: "traefik/whoami", restart: "unless-stopped", port: 80, domains: ["who.example.com"], health_path: "/up" });
    expect(app.publish).toBeUndefined();
  });
  it("is just the image when nothing is published", () => {
    expect(buildImageApp(review({ port: "" }))).toEqual({ name: "whoami", image: "traefik/whoami", restart: "unless-stopped" });
  });
});

describe("reachOf", () => {
  it("links a loopback port only when the server is this machine, and otherwise says it is on the server", () => {
    expect(reachOf(review(), "127.0.0.1")).toMatchObject({ kind: "local", address: "127.0.0.1:8100", url: "http://127.0.0.1:8100", loopback: true });
    expect(reachOf(review(), "203.0.113.7")).toMatchObject({ kind: "local", address: "127.0.0.1:8100", url: null, loopback: true });
    expect(reachOf(review(), null)).toMatchObject({ url: null, loopback: true });
  });
  it("links a port that is open to the network at the server's host", () => {
    expect(reachOf(review({ open: true }), "203.0.113.7")).toMatchObject({ address: "203.0.113.7:8100", url: "http://203.0.113.7:8100", loopback: false });
    expect(reachOf(review({ open: true }), "2001:db8::1")).toMatchObject({ address: "[2001:db8::1]:8100", url: "http://[2001:db8::1]:8100" });
    expect(reachOf(review({ open: true }), null)).toMatchObject({ address: ":8100", url: null, loopback: false });
  });
  it("is the domain, or nothing", () => {
    expect(reachOf(review({ domain: "who.example.com" }, ctx({ proxy: "caddy" })), "x")).toEqual({ kind: "domain", url: "https://who.example.com" });
    expect(reachOf(review({ port: "" }), "x")).toEqual({ kind: "none" });
  });
});

// ---- creating ----

const MANUAL: DnsChoice = { create: false, proxied: true };

function fakes(extra: { doc?: ConfigDocument | null; save?: SaveResult; deploy?: { ok: true; deploymentId: string } | { ok: false; error: string }; env?: { ok: true } | { ok: false; error: string; issues: { key: string; message: string }[] } } = {}) {
  const calls: string[] = [];
  const saved: { name: string; app: AppConfig; opts: SaveOptions }[] = [];
  const deployed: { app: string; target: unknown }[] = [];
  const envSet: { app: string; vars: ProjectVar[] }[] = [];
  const audits: string[] = [];
  const doc: ConfigDocument | null = extra.doc === undefined ? { content: "", hash: "h1", modified_at: "", applied_hash: "h1", deprecations: [], model: { apps: [] } } : extra.doc;
  const deps: ImageDeps = {
    config: async () => doc,
    envSupported: async () => true,
    setEnv: async (app, vars) => {
      calls.push("env");
      envSet.push({ app, vars });
      return extra.env ?? { ok: true };
    },
    saveApp: async (name, app, opts) => {
      calls.push("config");
      saved.push({ name, app, opts });
      return extra.save ?? { ok: true, hash: "h2", issues: [] };
    },
    dns: async () => ({ kind: "skipped", message: "create the record yourself" }),
    deploy: async (app, target) => {
      calls.push("deploy");
      deployed.push({ app, target });
      return extra.deploy ?? { ok: true, deploymentId: "dep-1" };
    },
    audit: (event) => {
      audits.push(event);
    },
    describe: (err) => (err instanceof Error ? err.message : "unexpected"),
  };
  return { deps, calls, saved, deployed, envSet, audits };
}

describe("createImageProject", () => {
  it("writes the app, then deploys the typed tag, with no repository, link or database step", async () => {
    const f = fakes();
    const out = await createImageProject(input(), "staging", f.deps, MANUAL, [], "127.0.0.1");
    expect(f.calls).toEqual(["config", "deploy"]);
    expect(f.saved[0]).toMatchObject({ name: "whoami", app: { image: "traefik/whoami", publish: ["127.0.0.1:8100:80"] }, opts: { base_hash: "h1" } });
    expect(f.deployed).toEqual([{ app: "whoami", target: { tag: "v1.10.3" } }]);
    expect(out.deploymentId).toBe("dep-1");
    expect(out.reach).toMatchObject({ kind: "local", url: "http://127.0.0.1:8100" });
    expect(out.steps.database.state).toBe("skipped");
    expect(out.steps.link.state).toBe("skipped");
    expect(out.steps.build).toMatchObject({ state: "done" });
    expect(f.audits).toEqual(["app_created_from_image", "first_deploy_started"]);
  });

  it("sets the variables before the first deployment, and never names a value in its outcome or audit", async () => {
    const f = fakes();
    const out = await createImageProject(input(), "staging", f.deps, MANUAL, [{ key: "TOKEN", value: "hunter2-secret", build: false }], null);
    expect(f.calls).toEqual(["config", "env", "deploy"]);
    expect(out.steps.env).toMatchObject({ state: "done" });
    expect(JSON.stringify([out, f.audits])).not.toContain("hunter2");
  });

  it("deploys a digest as a digest", async () => {
    const f = fakes();
    await createImageProject(input({ image: `ghcr.io/acme/web@${DIGEST}` }), "staging", f.deps, MANUAL, [], null);
    expect(f.deployed[0]!.target).toEqual({ digest: DIGEST });
  });

  it("writes nothing for a form with problems or a name the agent already has, and says which fields", async () => {
    const f = fakes({ doc: { content: "", hash: "h1", modified_at: "", applied_hash: "h1", deprecations: [], model: { apps: [{ name: "whoami", image: "x" }] } } });
    const out = await createImageProject(input(), "staging", f.deps, MANUAL, [], null);
    expect(out.imageErrors?.name).toBeDefined();
    expect(f.calls).toEqual([]);
    expect((await createImageProject(input({ image: "traefik/whoami" }), "staging", fakes().deps, MANUAL, [], null)).imageErrors?.image).toBeDefined();
  });

  it("refuses a variable the agent would refuse before writing anything", async () => {
    const f = fakes();
    const out = await createImageProject(input(), "staging", f.deps, MANUAL, [{ key: "bad name", value: "x", build: false }], null);
    expect(out.varIssues?.length).toBeGreaterThan(0);
    expect(f.calls).toEqual([]);
  });

  it("stops with the agent's own words when it refuses the app, and deploys nothing", async () => {
    const f = fakes({ save: { ok: false, kind: "invalid", message: "invalid configuration", issues: [{ severity: "error", path: "apps[whoami].image", message: "image has a tag" }] } });
    const out = await createImageProject(input(), "staging", f.deps, MANUAL, [], null);
    expect(out.steps.config).toEqual({ state: "failed", detail: "invalid configuration" });
    expect(out.issues).toHaveLength(1);
    expect(f.deployed).toEqual([]);
  });

  it("keeps the app when the deployment cannot start, says so, and offers the retry of that step only", async () => {
    const f = fakes({ deploy: { ok: false, error: "a deployment is already running" } });
    const out = await createImageProject(input(), "staging", f.deps, MANUAL, [], null);
    expect(out.steps.config.state).toBe("done");
    expect(out.steps.build).toEqual({ state: "failed", detail: "a deployment is already running" });
    expect(out.retry).toBe("build");
    expect(out.deploymentId).toBeUndefined();
    expect(f.audits).toContain("first_deploy_failed");
  });

  it("reads a read-only agent and an invalid file as the reason, before writing", async () => {
    expect((await createImageProject(input(), "s", fakes({ doc: null }).deps, MANUAL, [], null)).steps.config.detail).toMatch(/read-only/);
    const broken = fakes({ doc: { content: "", hash: "h", modified_at: "", applied_hash: "h", deprecations: [], model: {}, error: "line 3: bad" } });
    expect((await createImageProject(input(), "s", broken.deps, MANUAL, [], null)).steps.config.detail).toMatch(/currently invalid: line 3/);
  });
});

describe("retryImageProject", () => {
  const written = { content: "", hash: "h2", modified_at: "", applied_hash: "h2", deprecations: [], model: { apps: [{ name: "whoami", image: "traefik/whoami", publish: ["127.0.0.1:8100:80"] }] } } satisfies ConfigDocument;

  it("deploys again without writing the configuration, and its own app does not make the name or the port taken", async () => {
    const f = fakes({ doc: written });
    const out = await retryImageProject(input(), "build", "staging", f.deps, MANUAL, [], "127.0.0.1");
    expect(f.calls).toEqual(["deploy"]);
    expect(out.deploymentId).toBe("dep-1");
    expect(out.steps.config.state).toBe("done");
  });

  it("from the variables, sets them and goes on to deploy", async () => {
    const f = fakes({ doc: written });
    await retryImageProject(input(), "env", "staging", f.deps, MANUAL, [{ key: "A", value: "1", build: false }], null);
    expect(f.calls).toEqual(["env", "deploy"]);
  });

  it("says the app is gone when it is not in the configuration any more", async () => {
    const out = await retryImageProject(input(), "build", "staging", fakes().deps, MANUAL, [], null);
    expect(out.steps.config.detail).toMatch(/not in the agent's configuration any more/);
  });

  it("reads any step name from a client as one of the three that exist", () => {
    expect(imageStepOf("dns")).toBe("dns");
    expect(imageStepOf("build")).toBe("build");
    expect(imageStepOf("database")).toBe("env");
    expect(imageStepOf(42)).toBe("env");
  });
});
