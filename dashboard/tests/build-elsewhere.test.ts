import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentError } from "@/lib/agent";
import { HIDDEN, type BuildConfig, type BuildLimits, type BuildRequestBody, type DeploymentStatus, type SystemBuild, type SystemInfo } from "@/lib/agent-types";
import type { WebhookDeps } from "@/lib/github-webhook";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-build-elsewhere-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

const { db } = await import("@/lib/db");
const { startBuild } = await import("@/lib/github-webhook");
const integrations = await import("@/lib/integrations");
const deliveries = await import("@/lib/webhook-deliveries");
const servers = await import("@/lib/servers");
const store = await import("@/lib/auth/store");

const SHA = "b".repeat(40);
const TOKEN = "ghs_installation_token_5678";
const ARCHIVE = Buffer.from("pretend this is a docker save archive ".repeat(2000));

let runs = "";
let builds = "";
let readOnly = "";
beforeAll(() => {
  runs = servers.createServer({ name: "vps-1", url: "https://vps-1.example.com", token: "t".repeat(40), deploySecret: "s".repeat(40) });
  builds = servers.createServer({ name: "build-1", url: "https://build-1.example.com", token: "t".repeat(40), deploySecret: "s".repeat(40) });
  readOnly = servers.createServer({ name: "ro", url: "https://ro.example.com", token: "t".repeat(40) });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  for (const table of ["webhook_deliveries", "app_repos", "audit_log", "integrations"]) db().exec(`DELETE FROM ${table}`);
  integrations.saveGithubApp({ appId: "4242", slug: "my-keelson", privateKey: "unused" });
  integrations.setAppRepo(runs, "shop", { repo: "Acme/Shop", branch: "main" });
  integrations.setBuildOn(runs, "shop", builds);
});

const LIMITS: BuildLimits = { memory: 4 * 1024 ** 3, cpus: 8, timeout_seconds: 3600, max_source: 2 * 1024 ** 3, source_hosts: ["api.github.com"], host_network: false, keep_images: 3 };
/** The build: block of the app on its own server, as the configuration API shows it: a secret argument is hidden. */
const APP_BUILD = {
  dockerfile: "Dockerfile",
  memory: "3g",
  network: "shop-net",
  database: true,
  args: { NEXT_PUBLIC_A: "1", REGISTRY_AUTH_TOKEN: HIDDEN },
};
/** A builder's system report: an arm64 server with builds enabled within LIMITS unless said otherwise. */
const system = (over: Partial<SystemBuild> = {}): SystemInfo => ({ time: "", host: { cpus: 4 }, arch: "arm64", build: { enabled: true, limits: LIMITS, ...over } });

interface Script {
  /** What the builder reports for its build, one answer per poll. */
  built?: DeploymentStatus[];
  exportError?: AgentError;
  importError?: AgentError;
  /** What the target reports for the deployment of the image. */
  deployed?: DeploymentStatus;
  /** The builder's system report (default: an arm64 server with builds enabled); the app's server is amd64. */
  builderSystem?: SystemInfo;
  /** The app's build block (default: APP_BUILD); null = the app has none. */
  appBuild?: BuildConfig | null;
}

function harness(script: Script = {}) {
  const seen = {
    builderBuilds: [] as BuildRequestBody[],
    targetBuilds: 0,
    exported: [] as string[],
    imported: [] as { app: string; tag: string; sha256: string; actual: string; bytes: number }[],
    deploys: [] as { app: string; tag: string; trigger?: string }[],
  };
  const posted: { state: string; description: string; targetUrl?: string }[] = [];
  const background: Promise<void>[] = [];
  let clock = 0;
  const deps: WebhookDeps = {
    agent: () => {
      throw new Error("not used");
    },
    compare: async () => null,
    installationToken: async () => TOKEN,
    buildAgent: () =>
      ({
        build: async () => {
          seen.targetBuilds++;
          return "never";
        },
        // The app's own server: its apps file (secrets hidden by the configuration API) and its architecture.
        config: async () => ({ model: { apps: [{ name: "shop", image: "keelson-local/shop:old", ...(script.appBuild === null ? {} : { build: script.appBuild ?? APP_BUILD }) }] } }),
        system: async () => ({ time: "", host: { cpus: 2 }, arch: "amd64" }),
      }) as never,
    builderAgent: () =>
      ({
        system: async () => script.builderSystem ?? system(),
        startBuild: async (request: BuildRequestBody) => {
          seen.builderBuilds.push(request);
          return "build-1";
        },
        deployment: async () => {
          const status = (script.built ?? ["succeeded"]).shift() ?? "succeeded";
          return { status, error: status === "failed" ? "exit 1" : undefined } as never;
        },
        exportImageByRef: async (ref: { image: string; tag: string }) => {
          seen.exported.push(`${ref.image}:${ref.tag}`);
          if (script.exportError) throw script.exportError;
          return new Response(ARCHIVE) as never;
        },
      }) as never,
    transferAgent: () =>
      ({
        importImage: async (app: string, tag: string, archive: { stream: Readable; sha256: string }) => {
          if (script.importError) throw script.importError;
          const hash = createHash("sha256");
          let bytes = 0;
          for await (const chunk of archive.stream) {
            hash.update(chunk as Buffer);
            bytes += (chunk as Buffer).length;
          }
          seen.imported.push({ app, tag, sha256: archive.sha256, actual: hash.digest("hex"), bytes });
        },
        deploy: async (app: string, target: { tag: string }, trigger?: string) => {
          seen.deploys.push({ app, tag: target.tag, trigger });
          return "dep-target";
        },
        deployment: async () => ({ status: script.deployed ?? "succeeded", error: script.deployed === "failed" ? "health check refused" : undefined }) as never,
      }) as never,
    postBuildStatus: async (_token, _repo, _sha, status) => void posted.push({ state: status.state, description: status.description, targetUrl: status.targetUrl }),
    publicUrl: () => new URL("https://keelson.example.com"),
    background: (task) => void background.push(task()),
    // The reporter polls on the fake clock while the journey does real file and stream work: yield, so that it does not run
    // through its whole timeout before the first byte has moved.
    sleep: async (ms) => {
      clock += ms;
      await new Promise((resolve) => setTimeout(resolve, 2));
    },
    now: () => clock,
    deployBudgetMs: 50,
  };
  return { deps, seen, posted, settle: () => Promise.all(background) };
}

const link = () => ({ serverId: runs, app: "shop" });
const run = { repo: "Acme/Shop", branch: "main", sha: SHA };
const events = () => store.recentAudit(20).map((e) => `${e.event}: ${e.detail}`);

describe("an app built on another server", () => {
  it("is a build request to the build server (no app there), and the image goes to the server that runs the app and is deployed", async () => {
    const h = harness();
    const out = await startBuild(link(), run, h.deps);

    expect(out).toEqual({ ok: true, deploymentId: "build-1", serverId: builds });
    expect(h.seen.builderBuilds).toEqual([
      {
        app: "shop",
        image: "keelson-local/shop",
        sha: SHA,
        source: { url: `https://api.github.com/repos/Acme/Shop/tarball/${SHA}`, token: TOKEN },
        build: { dockerfile: "Dockerfile", memory: "3g", args: { NEXT_PUBLIC_A: "1" }, platform: "linux/amd64" },
      },
    ]);
    expect(h.seen.targetBuilds).toBe(0);

    await h.settle();
    expect(h.seen.exported).toEqual([`keelson-local/shop:${SHA}`]);
    expect(h.seen.imported).toHaveLength(1);
    const got = h.seen.imported[0]!;
    expect(got).toMatchObject({ app: "shop", tag: SHA, bytes: ARCHIVE.length });
    expect(got.sha256).toBe(createHash("sha256").update(ARCHIVE).digest("hex"));
    expect(got.actual).toBe(got.sha256);
    expect(h.seen.deploys).toEqual([{ app: "shop", tag: SHA, trigger: "transfer" }]);
  });

  it("puts the whole journey on the commit as one status, linked to the build server's deployment page", async () => {
    const h = harness();
    await startBuild(link(), run, h.deps);
    await h.settle();
    expect(h.posted.map((p) => p.state)).toEqual(["pending", "success"]);
    expect(h.posted.every((p) => p.targetUrl === `https://keelson.example.com/servers/${builds}/deployments/build-1`)).toBe(true);
    expect(events()).toEqual([expect.stringContaining("build_transferred: shop <- Acme/Shop@bbbbbbb, built on build-1, deployment dep-target")]);
    expect(deliveries.recentBuildDeliveries(runs, "shop")[0]).toMatchObject({ outcome: "deployed", deploymentId: "build-1" });
  });

  it("sends nothing when the build fails, and says so on the commit and in the audit log", async () => {
    const h = harness({ built: ["running", "failed"] });
    await startBuild(link(), run, h.deps);
    await h.settle();
    expect(h.seen.exported).toEqual([]);
    expect(h.seen.deploys).toEqual([]);
    expect(h.posted.at(-1)).toMatchObject({ state: "failure", description: expect.stringContaining("exit 1") });
    expect(events()[0]).toContain("build_transfer_failed");
    expect(events()[0]).toContain("the build did not succeed: exit 1");
  });

  it("says which side refused an image, and deploys nothing", async () => {
    const h = harness({ importError: new AgentError(400, "the archive is not the announced image") });
    await startBuild(link(), run, h.deps);
    await h.settle();
    expect(h.seen.deploys).toEqual([]);
    expect(events()[0]).toContain("the server that runs the app refused the image: the archive is not the announced image");
    expect(h.posted.at(-1)?.state).toBe("failure");

    const h2 = harness({ exportError: new AgentError(404, "not found: no such image was built or received here") });
    await startBuild({ serverId: runs, app: "shop" }, { ...run, sha: "c".repeat(40) }, h2.deps);
    await h2.settle();
    expect(events()[0]).toContain("the build server could not give the image");
  });

  it("is a failure, not a success, when the image arrives but its deployment is rolled back", async () => {
    const h = harness({ deployed: "rolled_back" });
    await startBuild(link(), run, h.deps);
    await h.settle();
    expect(events()[0]).toContain("the new version failed and the previous one serves again");
    expect(h.posted.at(-1)?.state).toBe("failure");
  });

  it("refuses at once, asking nobody to build, when the build server cannot be driven from here", async () => {
    integrations.setBuildOn(runs, "shop", readOnly);
    const h = harness();
    expect(await startBuild(link(), run, h.deps)).toMatchObject({ ok: false, error: expect.stringContaining("no deploy secret") });
    integrations.setBuildOn(runs, "shop", "gone");
    expect(await startBuild(link(), { ...run, sha: "d".repeat(40) }, h.deps)).toMatchObject({ ok: false, error: expect.stringContaining("not registered") });
    expect(h.seen.builderBuilds).toEqual([]);
    expect(h.seen.targetBuilds).toBe(0);
  });

  it("refuses at once when the build server's agent cannot build for others: update the agent", async () => {
    const h = harness({ builderSystem: { time: "", host: { cpus: 2 }, arch: "amd64" } });
    expect(await startBuild(link(), run, h.deps)).toMatchObject({ ok: false, error: expect.stringContaining("update the agent on build-1") });
    expect(h.seen.builderBuilds).toEqual([]);
  });

  it("refuses at once, naming the limit, when the app's block is above the build server's limits", async () => {
    const h = harness({ builderSystem: system({ limits: { ...LIMITS, memory: 512 * 1024 ** 2 } }) });
    const out = await startBuild(link(), run, h.deps);
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining("build.memory 3g") });
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining("build-1 refuses this build") });
    expect(h.seen.builderBuilds).toEqual([]);
  });

  it("sends `network: host` to a build server that allows host-network builds (a database tunnelled on its host), and still no database", async () => {
    const h = harness({
      appBuild: { ...APP_BUILD, network: "host" },
      builderSystem: system({ limits: { ...LIMITS, host_network: true } }),
    });
    expect(await startBuild(link(), run, h.deps)).toMatchObject({
      ok: true,
      serverId: builds,
    });
    expect(h.seen.builderBuilds[0]?.build).toEqual({
      dockerfile: "Dockerfile",
      memory: "3g",
      network: "host",
      args: { NEXT_PUBLIC_A: "1" },
      platform: "linux/amd64",
    });
  });

  it("refuses at once, before sending anything, when the app asks for the host network and the build server does not allow it", async () => {
    const h = harness({ appBuild: { ...APP_BUILD, network: "host" } });
    expect(await startBuild(link(), run, h.deps)).toMatchObject({
      ok: false,
      error:
        "build-1 does not allow host-network builds (build_limits.host_network: true)",
    });
    expect(h.seen.builderBuilds).toEqual([]);
  });

  it("refuses at once when the app has no build block to ask for", async () => {
    const h = harness({ appBuild: null });
    expect(await startBuild(link(), run, h.deps)).toMatchObject({ ok: false, error: expect.stringContaining("no build: block") });
    expect(h.seen.builderBuilds).toEqual([]);
  });

  it("can send an image to an app on a server that connects out: the request is the same", async () => {
    const vps = servers.createRelayServer({ name: "relay-vps", token: "t".repeat(40), deploySecret: "s".repeat(40), credentialHash: "relay-vps-hash", serves: true }).id;
    integrations.setAppRepo(vps, "shop", { repo: "Acme/Shop", branch: "main" });
    integrations.setBuildOn(vps, "shop", builds);
    const h = harness();
    expect(await startBuild({ serverId: vps, app: "shop" }, run, h.deps)).toMatchObject({ ok: true, serverId: builds });
    await h.settle();
    expect(h.seen.deploys).toEqual([{ app: "shop", tag: SHA, trigger: "transfer" }]);
  });

  it("builds where it runs again once the build server is taken away", async () => {
    integrations.setBuildOn(runs, "shop", null);
    const h = harness();
    await startBuild(link(), run, h.deps);
    await h.settle();
    expect(h.seen.targetBuilds).toBe(1);
    expect(h.seen.exported).toEqual([]);
  });
});
