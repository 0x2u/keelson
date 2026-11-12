import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeLifecycleAgent } from "./fake-lifecycle-agent";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-project-actions-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

const session = vi.hoisted(() => ({ require: vi.fn(async () => {}) }));
const stepUp = vi.hoisted(() => ({ error: vi.fn<(verdict: { required: boolean }, what: string) => Promise<string | null>>(async () => null) }));
vi.mock("@/lib/session", () => ({ requireSession: session.require, clientInfo: async () => ({ ip: "127.0.0.1" }) }));
vi.mock("@/lib/step-up", () => ({ stepUpError: stepUp.error }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const actions = await import("@/app/project-lifecycle-actions");
const servers = await import("@/lib/servers");

const ALPHA_FILE = `apps:
  - name: shop
    image: ghcr.io/acme/shop
    port: 3000
  - name: shop-worker
    project: shop
    image: ghcr.io/acme/worker
  - name: blog
    image: ghcr.io/acme/blog
jobs:
  - name: nightly
    project: shop
    schedule: "0 3 * * *"
`;
const BETA_FILE = `apps:
  - name: shop-eu
    project: shop
    environment: staging
    image: ghcr.io/acme/shop
`;

const alpha = new FakeLifecycleAgent({
  apps: [
    { name: "shop", image: "ghcr.io/acme/shop", project: "", environment: "" },
    { name: "shop-worker", image: "ghcr.io/acme/worker", project: "shop", environment: "" },
    { name: "blog", image: "ghcr.io/acme/blog", project: "", environment: "" },
  ],
  content: ALPHA_FILE,
  model: {
    apps: [
      { name: "shop", image: "ghcr.io/acme/shop", port: 3000, env: { API_KEY: "secret" }, domains: ["shop.example.com"], volumes: ["shop-data:/data"] },
      { name: "shop-worker", project: "shop", image: "ghcr.io/acme/worker" },
      { name: "blog", image: "ghcr.io/acme/blog" },
    ],
    jobs: [{ name: "nightly", project: "shop", schedule: "0 3 * * *" }],
  },
});
const beta = new FakeLifecycleAgent({
  apps: [{ name: "shop-eu", image: "ghcr.io/acme/shop", project: "shop", environment: "staging" }],
  content: BETA_FILE,
  model: { apps: [{ name: "shop-eu", project: "shop", environment: "staging", image: "ghcr.io/acme/shop" }] },
});
let alphaId = "";
let betaId = "";
const extra: string[] = [];

beforeAll(async () => {
  await alpha.start();
  await beta.start();
  alphaId = servers.createServer({ name: "alpha", url: alpha.url, token: "t".repeat(40), deploySecret: "s".repeat(40) });
  betaId = servers.createServer({ name: "beta", url: beta.url, token: "t".repeat(40), deploySecret: "s".repeat(40) });
});
afterAll(async () => {
  await alpha.stop();
  await beta.stop();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  for (const a of [alpha, beta]) {
    a.requests.length = 0;
    a.opts.saveStatus = undefined;
    a.opts.hash = undefined;
  }
  for (const id of extra.splice(0)) servers.deleteServer(id);
  session.require.mockClear();
  stepUp.error.mockClear();
  stepUp.error.mockImplementation(async () => null);
});

describe("renameFactsAction", () => {
  it("reads every server that holds an app of the project, and the names that are taken", async () => {
    const result = await actions.renameFactsAction("shop");
    if (!result.ok) throw new Error(result.message);
    expect(result.facts.map((f) => f.server.name).sort()).toEqual(["alpha", "beta"]);
    const a = result.facts.find((f) => f.server.name === "alpha")!;
    expect(a.entities).toContainEqual({ kind: "app", name: "shop", label: "", inAppsFile: true });
    expect(a.entities).toContainEqual({ kind: "job", name: "nightly", label: "shop", inAppsFile: true });
    expect(result.existingProjects).toEqual(expect.arrayContaining(["shop", "blog"]));
    expect(alpha.writes()).toEqual([]);
  });
  it("says so for a project that has no app", async () => {
    expect((await actions.renameFactsAction("nothing")).ok).toBe(false);
  });
});

describe("renameProjectAction", () => {
  it("saves each server once, on the hash it read, with only the labels changed", async () => {
    const result = await actions.renameProjectAction("shop", "store");
    if (!result.ok) throw new Error(result.message);
    expect(result.servers.map((s) => [s.serverName, s.ok, s.changed]).sort()).toEqual([
      ["alpha", true, 3],
      ["beta", true, 1],
    ]);
    for (const [agent, original] of [[alpha, ALPHA_FILE], [beta, BETA_FILE]] as const) {
      const writes = agent.writes();
      expect(writes).toHaveLength(1);
      expect(writes[0].line).toBe("PUT /v1/config");
      expect(writes[0].body.base_hash).toBe("h1");
      const content = writes[0].body.content as string;
      expect(content).not.toContain("project: shop");
      expect(content.split("\n").length - original.split("\n").length).toBe(agent === alpha ? 1 : 0);
    }
    expect(alpha.writes()[0].body.content).toContain("  - name: shop\n    project: store\n    image: ghcr.io/acme/shop\n");
    expect(alpha.writes()[0].body.content).toContain("  - name: blog\n    image: ghcr.io/acme/blog\n");
    expect(stepUp.error).toHaveBeenCalledWith(expect.objectContaining({ required: true }), expect.stringContaining("shop"));
  });

  it("refuses a project that exists, and writes nothing", async () => {
    const result = await actions.renameProjectAction("shop", "blog");
    expect(result.ok).toBe(false);
    expect(alpha.writes()).toEqual([]);
    expect(beta.writes()).toEqual([]);
  });

  it("writes nothing when the session is not unlocked", async () => {
    stepUp.error.mockImplementation(async () => "Unlock changes first");
    const result = await actions.renameProjectAction("shop", "store");
    expect(result).toEqual({ ok: false, message: "Unlock changes first" });
    expect(alpha.writes()).toEqual([]);
    expect(beta.writes()).toEqual([]);
  });

  it("stops everything for a read-only server that holds the project, naming it", async () => {
    const readOnly = new FakeLifecycleAgent({
      apps: [{ name: "shop-ro", image: "x", project: "shop", environment: "" }],
      content: "apps:\n  - name: shop-ro\n    project: shop\n    image: x\n",
      model: { apps: [{ name: "shop-ro", project: "shop", image: "x" }] },
    });
    await readOnly.start();
    try {
      extra.push(servers.createServer({ name: "gamma", url: readOnly.url, token: "t".repeat(40) }));
      const result = await actions.renameProjectAction("shop", "store");
      expect(result.ok).toBe(false);
      expect(!result.ok && result.message).toContain("gamma");
      expect(alpha.writes()).toEqual([]);
      expect(beta.writes()).toEqual([]);
      expect(readOnly.writes()).toEqual([]);
    } finally {
      await readOnly.stop();
    }
  });

  it("stops everything when a server did not answer: the project may have apps there", async () => {
    extra.push(servers.createServer({ name: "down", url: "http://127.0.0.1:1", token: "t".repeat(40), deploySecret: "s".repeat(40) }));
    const result = await actions.renameProjectAction("shop", "store");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("down");
    expect(alpha.writes()).toEqual([]);
  });

  it("reports the server that refused its save, and the ones that were saved", async () => {
    beta.opts.saveStatus = { status: 400, body: { error: "invalid", issues: [{ severity: "error", path: "apps[shop-eu]", message: "image is not allowed", line: 4 }] } };
    const result = await actions.renameProjectAction("shop", "store");
    if (!result.ok) throw new Error(result.message);
    expect(result.servers.find((s) => s.serverName === "alpha")?.ok).toBe(true);
    const failed = result.servers.find((s) => s.serverName === "beta");
    expect(failed?.ok).toBe(false);
    expect(failed?.message).toContain("image is not allowed");
  });

  it("reports a server whose configuration changed after it was read, and does not overwrite it", async () => {
    alpha.opts.saveStatus = { status: 409, body: { error: "changed", hash: "newer" } };
    const result = await actions.renameProjectAction("shop", "store");
    if (!result.ok) throw new Error(result.message);
    const stale = result.servers.find((s) => s.serverName === "alpha");
    expect(stale?.ok).toBe(false);
    expect(stale?.message).toBeTruthy();
    expect(result.servers.find((s) => s.serverName === "beta")?.ok).toBe(true);
  });
});

describe("addEnvironmentAction", () => {
  const request = (over: Partial<Parameters<typeof actions.addEnvironmentAction>[0]> = {}) => ({
    project: "shop",
    environment: "qa",
    serverId: betaId,
    from: { serverId: alphaId, app: "shop" },
    ...over,
  });

  it("saves the app `<project>-<environment>` on the chosen server, copying the configuration without variables or domains", async () => {
    const result = await actions.addEnvironmentAction(request());
    expect(result.ok).toBe(true);
    const writes = beta.writes();
    expect(writes).toHaveLength(1);
    expect(writes[0].line).toBe("PUT /v1/config/apps/shop-qa");
    expect(writes[0].body.base_hash).toBe("h1");
    expect(writes[0].body.app).toEqual({ name: "shop-qa", project: "shop", environment: "qa", image: "ghcr.io/acme/shop", port: 3000, volumes: ["shop-data:/data"] });
    expect(alpha.writes()).toEqual([]);
    expect(stepUp.error).toHaveBeenCalledWith(expect.objectContaining({ required: true }), expect.stringContaining("shop-qa"));
  });

  it("refuses an environment the project has, and writes nothing", async () => {
    const result = await actions.addEnvironmentAction(request({ environment: "staging" }));
    expect(result.ok).toBe(false);
    expect(beta.writes()).toEqual([]);
  });

  it("makes the name unique on the server", async () => {
    alpha.opts.model = { ...alpha.opts.model, apps: [...(alpha.opts.model.apps ?? []), { name: "shop-qa", image: "x" }] };
    try {
      const result = await actions.addEnvironmentAction(request({ serverId: alphaId }));
      expect(result.ok).toBe(true);
      expect(alpha.writes()[0].line).toBe("PUT /v1/config/apps/shop-qa-2");
    } finally {
      alpha.opts.model = { ...alpha.opts.model, apps: (alpha.opts.model.apps ?? []).filter((a) => a.name !== "shop-qa") };
    }
  });

  it("starts from an image when nothing is copied, and does not write a read-only server", async () => {
    const fromImage = await actions.addEnvironmentAction(request({ from: null, image: "ghcr.io/acme/other" }));
    expect(fromImage.ok).toBe(true);
    expect(beta.writes()[0].body.app).toEqual({ name: "shop-qa", project: "shop", environment: "qa", image: "ghcr.io/acme/other" });
    const readOnly = new FakeLifecycleAgent({ apps: [], content: "apps: []\n", model: { apps: [] } });
    await readOnly.start();
    try {
      const id = servers.createServer({ name: "delta", url: readOnly.url, token: "t".repeat(40) });
      extra.push(id);
      const result = await actions.addEnvironmentAction(request({ serverId: id }));
      expect(result.ok).toBe(false);
      expect(readOnly.writes()).toEqual([]);
    } finally {
      await readOnly.stop();
    }
  });
});
