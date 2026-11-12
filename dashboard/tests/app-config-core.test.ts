import { describe, expect, it } from "vitest";
import type { AppConfig, ConfigVersion, ConfigVersionContent, Deployment } from "@/lib/agent-types";
import {
  appBlock,
  appChanges,
  configChangedSince,
  containerConfigChanged,
  createdNotice,
  listFields,
  liveNotice,
  redeployHref,
  reviewChanges,
  saveEffect,
  saveImpact,
  saveNotice,
  secretsOnlyChanged,
  versionsToCompare,
} from "@/lib/app-config-core";

const base: AppConfig = { name: "web", image: "ghcr.io/acme/web", env: { A: "1" }, domains: ["web.example.com"], port: 3000 };

describe("appChanges and saveImpact: what saving does to the running container", () => {
  it("what is baked into the container at deploy time needs a redeploy", () => {
    for (const patch of [
      { env: { A: "2" } },
      { env_file: "/srv/web.env" },
      { publish: ["8080:80"] },
      { command: ["run"] },
      { volumes: ["/a:/b"] },
      { image: "other/web" },
      { restart: "always" as const },
      { log: { max_size: "10m" } },
      { port: 3001 },
      { network: "n" },
      { stop_timeout: "30s" },
      { port: { host: [9001, 9002], env: "LISTEN" } },
      { deploy: { strategy: "replace" as const } },
    ]) {
      expect(saveImpact(appChanges(base, { ...base, ...patch })), JSON.stringify(patch)).toBe("redeploy");
    }
  });
  it("domains, project and environment apply live", () => {
    expect(saveImpact(appChanges(base, { ...base, domains: ["a.example.com"] }))).toBe("live");
    expect(saveImpact(appChanges(base, { ...base, domains: ["web.example.com", "b.example.com"] }))).toBe("live");
    expect(saveImpact(appChanges(base, { ...base, project: "shop", environment: "staging" }))).toBe("live");
  });
  it("the first domain and the last one change how the container is deployed, so they need a redeploy", () => {
    const bare: AppConfig = { name: "web", image: "x/web" };
    expect(saveImpact(appChanges(bare, { ...bare, domains: ["web.example.com"] }))).toBe("redeploy");
    expect(saveImpact(appChanges({ ...base, port: undefined }, { ...base, port: undefined, domains: [] }))).toBe("redeploy");
    // Still deployed behind the proxy because of its port: domains stay live.
    expect(saveImpact(appChanges(base, { ...base, domains: [] }))).toBe("live");
  });
  it("the settings of the deployment procedure (health check, release steps...) are for the next deployment, not the container", () => {
    for (const patch of [{ health_path: "/up" }, { health_timeout: "60s" }, { stable_after: "10s" }, { drain: "1s" }, { keep_images: 5 }, { release: { steps: [{ name: "m", host: ["x"] }] } }]) {
      expect(saveImpact(appChanges(base, { ...base, ...patch })), JSON.stringify(patch)).toBe("next-deploy");
    }
  });
  it("the strongest impact wins, and nothing changed is null", () => {
    const c = appChanges(base, { ...base, domains: ["x.example.com"], env: { A: "2" }, drain: "5s" });
    expect(c).toEqual({ redeploy: ["env"], nextDeploy: ["drain"], live: ["domains"] });
    expect(saveImpact(c)).toBe("redeploy");
    expect(saveImpact(appChanges(base, { ...base }))).toBeNull();
  });
  it("ignores key order and equal nested values, and a new app has nothing to redeploy", () => {
    expect(saveImpact(appChanges({ ...base, env: { A: "1", B: "2" } }, { ...base, env: { B: "2", A: "1" } }))).toBeNull();
    expect(saveImpact(appChanges(undefined, base))).toBeNull();
  });
  it("lists fields in words", () => {
    expect(listFields(["env", "publish", "command"])).toBe("environment variables, published ports and command");
    expect(listFields(["env"])).toBe("environment variables");
  });
});

describe("saveEffect: the answer the UI needs after a save", () => {
  it("says a redeploy is needed and names what changed", () => {
    const effect = saveEffect(base, { ...base, env: { A: "2" }, command: ["run"], domains: ["b.example.com"] });
    expect(effect.needsRedeploy).toBe(true);
    expect(effect.impact).toBe("redeploy");
    expect(effect.redeploy).toEqual(["environment variables", "command"]);
    expect(effect.live).toEqual(["domains"]);
  });
  it("needs no redeploy for what applies live or from the next deployment", () => {
    expect(saveEffect(base, { ...base, domains: ["b.example.com"] })).toMatchObject({ needsRedeploy: false, impact: "live", live: ["domains"] });
    expect(saveEffect(base, { ...base, health_path: "/up" })).toMatchObject({ needsRedeploy: false, impact: "next-deploy", nextDeploy: ["health check path"] });
    expect(saveEffect(base, { ...base })).toMatchObject({ needsRedeploy: false, impact: null });
  });
});

describe("redeployHref: the app page with its deploy dialog prefilled with the serving version", () => {
  it("prefills the tag of the serving image", () => {
    expect(redeployHref("s1", "web", "ghcr.io/acme/web:v1.4.2")).toBe("/servers/s1/apps/web?deploy=v1.4.2");
  });
  it("prefills the full digest of an image served by digest", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(redeployHref("s1", "web", `ghcr.io/acme/web@${digest}`)).toBe(`/servers/s1/apps/web?deploy=${encodeURIComponent(digest)}`);
  });
  it("prefills nothing when there is no exact version to name, and escapes the app name", () => {
    expect(redeployHref("s1", "web", "")).toBe("/servers/s1/apps/web");
    expect(redeployHref("s1", "web", "ghcr.io/acme/web")).toBe("/servers/s1/apps/web");
    expect(redeployHref("s1", "my app", "x/y:1")).toBe("/servers/s1/apps/my%20app?deploy=1");
  });
});

describe("saveNotice: what the user is told after saving", () => {
  const where = { serverId: "s1", app: "web", servingImage: "ghcr.io/acme/web:v1" };
  it("a change that needs a redeploy stays on screen, says it is not running yet, and offers Deploy with the serving tag", () => {
    const notice = saveNotice(saveEffect(base, { ...base, env: { A: "2" } }), where);
    expect(notice.title).toBe("Saved. Not running yet: deploy to apply");
    expect(notice.description).toContain("environment variables");
    expect(notice.persistent).toBe(true);
    expect(notice.action).toEqual({ label: "Deploy", href: "/servers/s1/apps/web?deploy=v1" });
  });
  it("a change that applies live says so and has no Deploy button", () => {
    const notice = saveNotice(saveEffect(base, { ...base, domains: ["b.example.com"] }), where);
    expect(notice.title).toBe("Saved. Applied live");
    expect(notice.action).toBeUndefined();
    expect(notice.persistent).toBe(false);
  });
  it("a change for the next deployment says the running container does not change, with no Deploy button", () => {
    const notice = saveNotice(saveEffect(base, { ...base, drain: "1s" }), where);
    expect(notice.title).toBe("Saved. Applies from the next deployment");
    expect(notice.action).toBeUndefined();
  });
  it("saving without a change says so", () => {
    expect(saveNotice(saveEffect(base, base), where).title).toBe("Saved. Nothing changed");
  });
  it("a new app is not running until it is deployed; entities that always apply live say so", () => {
    expect(createdNotice({ serverId: "s1", app: "web" })).toMatchObject({ persistent: true, action: { label: "Deploy", href: "/servers/s1/apps/web" } });
    expect(liveNotice("Job backup")).toEqual({ title: "Job backup saved. Applied live", persistent: false });
  });
});

describe("reviewChanges: the exact changes, field by field", () => {
  it("lists only what changed, with the impact of each field", () => {
    const changes = reviewChanges(base, { ...base, port: 3001, domains: ["web.example.com"], drain: "2s", env: { A: "1" } });
    expect(changes.map((c) => [c.label, c.impact])).toEqual([
      ["app port", "redeploy"],
      ["drain time", "next-deploy"],
    ]);
    expect(changes[0].rows).toEqual([{ kind: "changed", before: "3000", after: "3001" }]);
    expect(changes[1].rows).toEqual([{ kind: "added", after: "2s" }]);
  });
  it("never carries an environment value: a variable is only added, removed or changed", () => {
    const changes = reviewChanges({ ...base, env: { KEEP: "<hidden>", OLD: "<hidden>", REPLACED: "<hidden>" } }, { ...base, env: { KEEP: "<hidden>", REPLACED: "hunter2", NEW: "s3cret" } });
    expect(changes).toHaveLength(1);
    expect(changes[0].rows).toEqual([
      { name: "NEW", kind: "added" },
      { name: "OLD", kind: "removed" },
      { name: "REPLACED", kind: "changed" },
    ]);
    expect(JSON.stringify(changes)).not.toMatch(/hunter2|s3cret/);
  });
  it("lists added and removed items of a list, and the command as one ordered line", () => {
    const changes = reviewChanges({ ...base, volumes: ["/a:/a", "/b:/b"], command: ["run", "--x"] }, { ...base, volumes: ["/b:/b", "/c:/c"], command: ["run", "--y"] });
    expect(changes.find((c) => c.field === "volumes")?.rows).toEqual([
      { kind: "removed", before: "/a:/a" },
      { kind: "added", after: "/c:/c" },
    ]);
    expect(changes.find((c) => c.field === "command")?.rows).toEqual([{ kind: "changed", before: "run --x", after: "run --y" }]);
  });
  it("shows a reordered list as changed instead of dropping the change", () => {
    expect(reviewChanges({ ...base, domains: ["a", "b"] }, { ...base, domains: ["b", "a"] })[0].rows).toEqual([{ kind: "changed", before: "a, b", after: "b, a" }]);
  });
  it("shows nested settings by path", () => {
    const rows = reviewChanges(base, { ...base, release: { steps: [{ name: "migrate", host: ["./m.sh"] }], on_rollback: true } })[0].rows;
    expect(rows).toEqual([
      { name: "on_rollback", kind: "added", after: "true" },
      { name: "steps[0].host[0]", kind: "added", after: "./m.sh" },
      { name: "steps[0].name", kind: "added", after: "migrate" },
    ]);
  });
  it("shows a removed setting as removed", () => {
    expect(reviewChanges(base, { ...base, port: undefined })[0].rows).toEqual([{ kind: "removed", before: "3000" }]);
  });
  it("is empty when nothing changed", () => {
    expect(reviewChanges(base, { ...base })).toEqual([]);
  });
  it("lists every field a new app sets as added, secrets hidden", () => {
    const changes = reviewChanges(undefined, base);
    expect(changes.map((c) => c.field)).toEqual(["name", "domains", "image", "env", "port"]);
    expect(changes.every((c) => c.rows.every((r) => r.kind === "added"))).toBe(true);
    expect(changes.find((c) => c.field === "env")?.rows).toEqual([{ name: "A", kind: "added" }]);
  });
});

const FILE = (extra = "", domain = "web.example.com") => `apps:
  - name: web
    image: ghcr.io/acme/web
    env:
      A: <hidden>${extra}
    domains:
      - ${domain}
  - name: api
    image: ghcr.io/acme/api
    port: 4000
jobs:
  - name: j
    schedule: "* * * * *"
`;

describe("appBlock and containerConfigChanged: did this app's container configuration change between two files?", () => {
  it("reads the fields of one app", () => {
    const block = appBlock(FILE(), "api");
    expect(block && Object.keys(block)).toEqual(["name", "image", "port"]);
    expect(appBlock(FILE(), "web")?.env).toContain("A: <hidden>");
    expect(appBlock(FILE(), "nope")).toBeNull();
  });
  it("reads a file whose list items sit at the margin and that has comments", () => {
    const text = "# my apps\napps:\n# first\n- name: web\n  image: x/web\n  # why\n  port: 80\n- name: api\n  image: x/api\n";
    expect(appBlock(text, "web") && Object.keys(appBlock(text, "web")!)).toEqual(["name", "image", "port"]);
    expect(appBlock(text, "api")?.image).toBe("image: x/api\n");
  });
  it("is false when only another app, a job or the app's domains changed", () => {
    expect(containerConfigChanged(FILE(), FILE("", "other.example.com"), "web")).toBe(false);
    expect(containerConfigChanged(FILE(), FILE().replace("port: 4000", "port: 4001"), "web")).toBe(false);
    expect(containerConfigChanged(FILE(), FILE().replace('"* * * * *"', '"0 * * * *"'), "web")).toBe(false);
  });
  it("is false for settings only the next deployment reads (health check, release steps, drain)", () => {
    expect(containerConfigChanged(FILE(), FILE("\n    health_path: /up"), "web")).toBe(false);
    expect(containerConfigChanged(FILE(), FILE("\n    drain: 1s"), "web")).toBe(false);
  });
  it("is true when a field of the container changed, or the app appeared or disappeared", () => {
    expect(containerConfigChanged(FILE(), FILE("\n      B: x"), "web")).toBe(true);
    expect(containerConfigChanged(FILE(), FILE().replace("acme/web", "acme/web2"), "web")).toBe(true);
    expect(containerConfigChanged(FILE(), "apps:\n  - name: api\n    image: x\n", "web")).toBe(true);
  });
  it("is true when the app gains its first domain or loses its last one (it is then deployed another way)", () => {
    const without = "apps:\n  - name: web\n    image: x/web\n";
    const withDomain = "apps:\n  - name: web\n    image: x/web\n    domains:\n      - web.example.com\n";
    expect(containerConfigChanged(without, withDomain, "web")).toBe(true);
    expect(containerConfigChanged(withDomain, without, "web")).toBe(true);
    expect(containerConfigChanged(withDomain, withDomain.replace("web.example", "b.example"), "web")).toBe(false);
  });
});

describe("versionsToCompare", () => {
  const v = (id: number, at: string, hash: string): ConfigVersion => ({ id, at, hash, source: "api" });
  const list = [v(3, "2026-10-20T12:00:00Z", "c"), v(2, "2026-10-20T10:00:00Z", "b"), v(1, "2026-10-19T09:00:00Z", "a")];
  it("compares the version in force at the last deployment with the latest", () => {
    expect(versionsToCompare(list, "2026-10-20T10:30:00Z")).toEqual({ then: list[1], now: list[0] });
  });
  it("is null when nothing was saved since the deployment, or the history does not reach back", () => {
    expect(versionsToCompare(list, "2026-10-20T12:30:00Z")).toBeNull();
    expect(versionsToCompare(list, "2026-10-01T00:00:00Z")).toBeNull();
    expect(versionsToCompare([], "2026-10-20T10:30:00Z")).toBeNull();
  });
  it("is null when a restore brought back the same file", () => {
    expect(versionsToCompare([v(4, "2026-10-20T12:00:00Z", "b"), ...list.slice(1)], "2026-10-20T10:30:00Z")).toBeNull();
  });
  it("compares instants, not text: fractional seconds and offsets are what the agent sends", () => {
    const frac = [v(2, "2026-10-20T10:00:00.5Z", "b"), v(1, "2026-10-20T09:00:00Z", "a")];
    // As text "…10:00:00.5Z" < "…10:00:00Z" ('.' < 'Z'), as instants it is the later one.
    expect(versionsToCompare(frac, "2026-10-20T10:00:00Z")).toEqual({ then: frac[1], now: frac[0] });
    expect(versionsToCompare(frac, "2026-10-20T12:00:00+02:00")).toEqual({ then: frac[1], now: frac[0] });
  });
});

describe("configChangedSince: has the config changed since the running version was deployed?", () => {
  const v = (id: number, at: string, hash: string, source: ConfigVersion["source"] = "api"): ConfigVersion => ({ id, at, hash, source });
  const dep = (over: Partial<Deployment>): Deployment => ({ id: "d", app: "web", ref: "x/web:1", status: "succeeded", trigger: "api", started_at: "2026-10-20T10:00:00Z", finished_at: "2026-10-20T10:01:00Z", ...over });
  const versions = [v(3, "2026-10-20T12:00:00Z", "c"), v(2, "2026-10-20T09:00:00Z", "b"), v(1, "2026-10-19T09:00:00Z", "a", "startup")];

  it("returns the versions to compare when one was saved after the last successful deployment started", () => {
    expect(configChangedSince(versions, [dep({})], "web")).toEqual({ deployedAt: "2026-10-20T10:00:00Z", then: versions[1], now: versions[0] });
  });
  it("is null once a successful deployment started after the last save (the badge clears at the next deployment)", () => {
    expect(configChangedSince(versions, [dep({}), dep({ id: "e", started_at: "2026-10-20T13:00:00Z" })], "web")).toBeNull();
  });
  it("counts from when the deployment started: a save made while it ran was not in it", () => {
    const during = [v(2, "2026-10-20T10:00:30Z", "b"), v(1, "2026-10-19T09:00:00Z", "a", "startup")];
    expect(configChangedSince(during, [dep({})], "web")).not.toBeNull();
  });
  it("ignores failed, rolled back and running deployments, and those of other apps", () => {
    const later = (status: Deployment["status"]) => dep({ id: "z", status, started_at: "2026-10-20T13:00:00Z" });
    for (const status of ["failed", "rolled_back", "rollback_failed", "running"] as const) {
      expect(configChangedSince(versions, [dep({}), later(status)], "web")).not.toBeNull();
    }
    expect(configChangedSince(versions, [dep({}), dep({ id: "o", app: "api", started_at: "2026-10-20T13:00:00Z" })], "web")).not.toBeNull();
  });
  it("is null with no successful deployment of the app, or when the deployments could not be loaded", () => {
    expect(configChangedSince(versions, [dep({ status: "failed" })], "web")).toBeNull();
    expect(configChangedSince(versions, [], "web")).toBeNull();
    expect(configChangedSince(versions, null, "web")).toBeNull();
  });
  it("never counts the first (startup) version, nor versions older than the deployment", () => {
    expect(configChangedSince([v(1, "2026-10-20T11:00:00Z", "a", "startup")], [dep({})], "web")).toBeNull();
    expect(configChangedSince([v(2, "2026-10-20T09:30:00Z", "b"), v(1, "2026-10-19T09:00:00Z", "a", "startup")], [dep({})], "web")).toBeNull();
  });
  it("is null when the file is back to what it was when deployed", () => {
    expect(configChangedSince([v(3, "2026-10-20T12:00:00Z", "b"), versions[1], versions[2]], [dep({})], "web")).toBeNull();
  });
  it("uses the latest successful deployment whatever the order of the list", () => {
    const old = dep({ id: "old", started_at: "2026-10-18T10:00:00Z" });
    expect(configChangedSince(versions, [old, dep({})], "web")?.deployedAt).toBe("2026-10-20T10:00:00Z");
    expect(configChangedSince(versions, [dep({}), old], "web")?.deployedAt).toBe("2026-10-20T10:00:00Z");
  });
});

describe("secretsOnlyChanged", () => {
  const c = (hash: string, content: string): ConfigVersionContent => ({ id: 1, at: "2026-10-20T10:00:00Z", hash, source: "api", content });
  it("is true when the hashes differ but the text, secrets hidden, is the same", () => {
    expect(secretsOnlyChanged(c("a", FILE()), c("b", FILE()))).toBe(true);
  });
  it("is false when the file is the same, or when something visible changed", () => {
    expect(secretsOnlyChanged(c("a", FILE()), c("a", FILE()))).toBe(false);
    expect(secretsOnlyChanged(c("a", FILE()), c("b", FILE("", "x.example.com")))).toBe(false);
  });
});
