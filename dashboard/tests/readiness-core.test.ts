import { describe, expect, it } from "vitest";
import type { AppConfig, AppStatus, BackupDestinationConfig, ConfigModel, DatabaseBackupRun, DatabaseStatus, Deployment, Proof, RestoreTest } from "@/lib/agent-types";
import {
  answerOf,
  configAnswer,
  dashboardReadiness,
  forProject,
  forServer,
  ownedKey,
  readinessHref,
  readinessSummary,
  serverReadiness,
  STALE_AFTER_DAYS,
  type Answer,
  type ReadinessItem,
  type ServerReadinessInput,
} from "@/lib/readiness-core";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const ok = <T>(value: T) => ({ kind: "ok" as const, value });
const OLD: Answer<never> = { kind: "old" };

const run = (over: Partial<DatabaseBackupRun> = {}): DatabaseBackupRun => ({ id: "r", status: "succeeded", started_at: ago(2 * HOUR), finished_at: ago(2 * HOUR), ...over });

const db = (name: string, backup: Partial<NonNullable<DatabaseStatus["backup"]>> | null = {}): DatabaseStatus => ({
  name,
  engine: "postgres",
  host: "db",
  port: 5432,
  database: name,
  user: "u",
  version: 16,
  network: "",
  has_password: true,
  backup: backup === null ? null : { schedule: "0 3 * * *", timezone: "UTC", keep: 7, keep_days: 0, paused: false, destination: "local:/b", recipients: 1, job: `backup-${name}`, next_run: ago(-HOUR), last_run: run(), ...backup },
});

const app = (name: string, over: Partial<AppStatus> = {}): AppStatus =>
  ({ name, image: `r:${name}`, project: "", environment: "", digest: "", container: { id: "c", name, image: "r:v2", created: "", tty: false, restart_count: 0, state: { status: "running", running: true, paused: false, restarting: false, oom_killed: false, exit_code: 0 }, ports: null }, last_deployment: null, ...over }) as AppStatus;

const dep = (ref: string, status: Deployment["status"], minute: number): Deployment => ({ id: `d${minute}`, app: "web", ref, status, trigger: "api", started_at: `2026-11-01T10:${String(minute).padStart(2, "0")}:00Z` });

const s3 = (endpoint: string): BackupDestinationConfig => ({ s3: { endpoint, region: "r", bucket: "bk", access_key_id: "k", secret_key_file: "/f" } });
const local: BackupDestinationConfig = { local: { dir: "/b" } };

const model = (over: Partial<ConfigModel> = {}): ConfigModel => ({
  apps: [{ name: "web", image: "r:web", health_path: "/healthz" } as AppConfig],
  databases: [{ name: "main", host: "db", database: "main", user: "u", backups: { schedule: "0 3 * * *", recipients: ["age1x"], destinations: [local, s3("https://s3.eu.example.com")] } }],
  notifications: { telegram: { bot_token_file: "/t", chat_id: "1" } },
  ...over,
});

const proof = (kind: Proof["kind"], subject: string, ms: number): Proof => ({ kind, subject, at: ago(ms) });

const input = (over: Partial<ServerReadinessInput> = {}): ServerReadinessInput => ({
  server: { id: "s1", name: "alpha" },
  reachable: true,
  version: "v1",
  bundledVersion: "v1",
  apps: [app("web")],
  databases: [db("main")],
  config: ok(model()),
  proofs: ok([proof("restore", "main", 5 * DAY), proof("key", "main", 5 * DAY), proof("alert", "", 2 * DAY)]),
  restoreTests: { main: ok([]) },
  histories: { web: ok([dep("r:v2", "succeeded", 30), dep("r:v1", "succeeded", 10)]) },
  ...over,
});

const find = (items: ReadinessItem[], check: ReadinessItem["check"], subject?: string) => {
  const hit = items.find((i) => i.check === check && (subject === undefined || i.subject === subject));
  if (!hit) throw new Error(`no ${check} item`);
  return hit;
};

describe("a server that has everything", () => {
  const items = serverReadiness(input(), NOW);
  it("passes every check, once each, with stable ids", () => {
    expect(items.map((i) => `${i.check}:${i.state}`).sort()).toEqual(["alert:ok", "backup:ok", "health:ok", "key:ok", "offsite:ok", "restore:ok", "rollback:ok", "versions:ok"]);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    expect(serverReadiness(input(), NOW).map((i) => i.id)).toEqual(items.map((i) => i.id));
  });
  it("puts each check in its group and scope", () => {
    expect(items.map((i) => `${i.check}:${i.group}:${i.scope}`).sort()).toEqual([
      "alert:alerts:server",
      "backup:data:project",
      "health:deploys:project",
      "key:data:project",
      "offsite:data:project",
      "restore:data:project",
      "rollback:deploys:project",
      "versions:deploys:server",
    ]);
  });
  it("offers no link for what passes", () => {
    expect(items.filter((i) => i.check === "backup" || i.check === "offsite" || i.check === "health").every((i) => i.action === undefined)).toBe(true);
  });
});

describe("backups configured", () => {
  const backup = (db_: DatabaseStatus) => find(serverReadiness(input({ databases: [db_] }), NOW), "backup", db_.name);
  it("is to do, with a link to configure it, when the database has none", () => {
    const i = backup(db("main", null));
    expect(i).toMatchObject({ state: "todo", action: { label: "Configure backups", href: "/servers/s1/config/databases/main" } });
  });
  it("reuses the backup rules: failed is critical, overdue and paused warn, a first backup pending is to do", () => {
    expect(backup(db("main", { last_run: run({ status: "failed", detail: "pg_dump: refused" }) }))).toMatchObject({ state: "critical" });
    expect(backup(db("main", { last_run: run({ status: "failed", detail: "pg_dump: refused" }) })).detail).toContain("pg_dump: refused");
    expect(backup(db("main", { last_run: run({ started_at: ago(6 * DAY), finished_at: ago(6 * DAY) }) })).state).toBe("warning");
    expect(backup(db("main", { paused: true })).state).toBe("warning");
    expect(backup(db("main", { last_run: null })).state).toBe("todo");
  });
});

describe("restore tested", () => {
  const restore = (over: Partial<ServerReadinessInput>) => find(serverReadiness(input(over), NOW), "restore", "main");
  const withProofs = (...p: Proof[]) => ({ proofs: ok(p) });
  it("is to do while nobody has tested one, and offers the test", () => {
    const i = restore(withProofs());
    expect(i).toMatchObject({ state: "todo", fix: "test-restore" });
    expect(i.detail).toMatch(/No restore has been tested/);
  });
  it("passes with a fresh proof and says how long ago", () => {
    expect(restore(withProofs(proof("restore", "main", 3 * DAY)))).toMatchObject({ state: "ok", since: ago(3 * DAY), fix: "test-restore" });
  });
  it(`warns once the proof is older than ${STALE_AFTER_DAYS.restore} days`, () => {
    expect(restore(withProofs(proof("restore", "main", 89 * DAY))).state).toBe("ok");
    expect(restore(withProofs(proof("restore", "main", 91 * DAY))).state).toBe("warning");
  });
  it("uses the newest proof of the database and ignores other kinds and other databases", () => {
    expect(restore(withProofs(proof("restore", "other", DAY), proof("key", "main", DAY), proof("restore", "main", 200 * DAY), proof("restore", "main", DAY))).state).toBe("ok");
    expect(restore(withProofs(proof("restore", "other", DAY), proof("key", "main", DAY))).state).toBe("todo");
  });
  it("is critical when the last test failed after the last proof, with the cause", () => {
    const failed: RestoreTest = { id: "t", backup: "k", backup_time: ago(DAY), started_at: ago(HOUR), finished_at: ago(HOUR), status: "failed", error: "pg_restore: out of memory\nmore", tables: [] };
    const i = restore({ ...withProofs(proof("restore", "main", 3 * DAY)), restoreTests: { main: ok([failed]) } });
    expect(i.state).toBe("critical");
    expect(i.detail).toContain("pg_restore: out of memory");
    expect(i.detail).not.toContain("more");
    // An older failure does not hide a newer proof.
    expect(restore({ ...withProofs(proof("restore", "main", 30 * 60_000)), restoreTests: { main: ok([failed]) } }).state).toBe("ok");
  });
  it("says a test is running", () => {
    const running: RestoreTest = { id: "t", backup: "k", backup_time: ago(DAY), started_at: ago(60_000), status: "running", tables: null };
    expect(restore({ ...withProofs(), restoreTests: { main: ok([running]) } })).toMatchObject({ state: "todo", detail: "A test is running now." });
  });
  it("needs a backup first, and names the fix", () => {
    const i = find(serverReadiness(input({ databases: [db("main", null)] }), NOW), "restore", "main");
    expect(i).toMatchObject({ state: "todo", action: { href: "/servers/s1/config/databases/main" } });
    expect(i.fix).toBeUndefined();
  });
});

describe("an agent without the routes", () => {
  it("is to do with 'update the agent' for every check that needs a proof, never a guess", () => {
    const items = serverReadiness(input({ proofs: OLD, restoreTests: { main: OLD } }), NOW);
    for (const check of ["restore", "key", "alert"] as const) {
      const i = find(items, check);
      expect(i.state, check).toBe("todo");
      expect(i.detail, check).toContain("too old");
      expect(i.detail, check).toContain("alpha");
      expect(i.action, check).toEqual({ label: "Update the agent", href: "/servers/s1/update" });
      expect(i.fix, check).toBeUndefined();
    }
    // What does not need the routes still answers.
    expect(find(items, "backup").state).toBe("ok");
  });
  it("is to do with the reason when the proofs could not be read", () => {
    const i = find(serverReadiness(input({ proofs: { kind: "failed", reason: "the agent answered 500" } }), NOW), "key");
    expect(i).toMatchObject({ state: "todo" });
    expect(i.detail).toContain("the agent answered 500");
  });
  it("turns a null answer into old and an error into failed", () => {
    expect(answerOf({ data: null })).toEqual({ kind: "old" });
    expect(answerOf({ data: [1] })).toEqual({ kind: "ok", value: [1] });
    expect(answerOf({ error: "boom" })).toEqual({ kind: "failed", reason: "boom" });
  });
});

describe("encryption key proven", () => {
  const key = (p: Proof[]) => find(serverReadiness(input({ proofs: ok(p) }), NOW), "key", "main");
  it("is to do without a proof, passes with one, warns when stale", () => {
    expect(key([])).toMatchObject({ state: "todo", fix: "prove-key" });
    expect(key([proof("key", "main", DAY)])).toMatchObject({ state: "ok", fix: "prove-key" });
    expect(key([proof("key", "main", 91 * DAY)]).state).toBe("warning");
  });
  it("never says anything that could be a key", () => {
    expect(JSON.stringify(serverReadiness(input(), NOW))).not.toMatch(/AGE-SECRET-KEY/);
  });
});

describe("off-site copy", () => {
  const offsite = (destinations: BackupDestinationConfig[]) =>
    find(serverReadiness(input({ config: ok(model({ databases: [{ name: "main", host: "db", database: "main", user: "u", backups: { schedule: "0 3 * * *", recipients: ["age1x"], destinations } }] })) }), NOW), "offsite", "main");
  it("counts an S3 destination that is not on the machine", () => {
    expect(offsite([local, s3("https://s3.eu.example.com")])).toMatchObject({ state: "ok" });
    expect(offsite([s3("s3.example.com:9000")]).detail).toContain("s3.example.com/bk");
  });
  it("does not count a local directory or an S3 store on loopback", () => {
    expect(offsite([local])).toMatchObject({ state: "todo", action: { label: "Configure backups" } });
    for (const endpoint of ["http://127.0.0.1:9000", "http://localhost:9000", "http://[::1]:9000", "http://127.1.2.3"]) expect(offsite([s3(endpoint)]).state, endpoint).toBe("todo");
  });
  it("reads the model the real agent sends (captured from GET /v1/config: `backups` with `destinations`)", () => {
    const captured: ConfigModel = {
      databases: [
        {
          backups: { destinations: [{ local: { dir: "/tmp/ks5/bk" } }], recipients: ["age163q3f3h7tzdlmq5ua6ucrz9a9lw43da0mz6psmhssgc8zlqxevyqlx2fvc"], schedule: "0 3 * * *" },
          database: "shop",
          host: "ks5-pg",
          name: "main",
          network: "ks5net",
          password_file: "/tmp/ks5/a/dbpass",
          project: "shop",
          user: "shop",
        },
      ],
    };
    const local = find(serverReadiness(input({ config: ok(captured) }), NOW), "offsite", "main");
    expect(local.state).toBe("todo");
    expect(local.detail).not.toContain("does not list this database");
    const remote = { ...captured.databases![0], backups: { ...captured.databases![0].backups!, destinations: [...captured.databases![0].backups!.destinations, s3("https://s3.eu.example.com")] } };
    expect(find(serverReadiness(input({ config: ok({ databases: [remote] }) }), NOW), "offsite", "main").state).toBe("ok");
  });
  it("cannot tell when the configuration cannot be read", () => {
    const i = find(serverReadiness(input({ config: { kind: "failed", reason: "no answer" } }), NOW), "offsite");
    expect(i.state).toBe("todo");
    expect(i.detail).toContain("Can't tell");
  });
});

describe("alert channel tested", () => {
  const alert = (over: Partial<ServerReadinessInput>) => find(serverReadiness(input(over), NOW), "alert");
  it("is to do, with the link to set it up, when no channel is configured", () => {
    const i = alert({ config: ok(model({ notifications: undefined })) });
    expect(i).toMatchObject({ state: "todo", action: { href: "/servers/s1/config/notifications" } });
    expect(i.fix).toBeUndefined();
  });
  it("does not count a heartbeat as a channel, and says it cannot be tested", () => {
    const i = alert({ config: ok(model({ notifications: { heartbeat: { url: "https://x" } } })) });
    expect(i.state).toBe("todo");
    expect(i.detail).toContain("heartbeat");
  });
  it("is to do until a test passed, passes when fresh, warns after 30 days", () => {
    expect(alert({ proofs: ok([]) })).toMatchObject({ state: "todo", fix: "test-alert" });
    expect(alert({ proofs: ok([proof("alert", "", 29 * DAY)]) }).state).toBe("ok");
    expect(alert({ proofs: ok([proof("alert", "", 31 * DAY)]) }).state).toBe("warning");
  });
  it("names the channels", () => {
    expect(alert({ config: ok(model({ notifications: { webhooks: [{ url: "https://a" }, { url: "https://b" }], telegram: { bot_token_file: "/t", chat_id: "1" } } })) }).detail).toContain("2 webhooks and Telegram");
  });
  it("is not applicable on an agent without an apps file", () => {
    expect(alert({ config: ok(null) }).state).toBe("na");
  });
});

describe("health check present", () => {
  const health = (config: ConfigModel | null, a = app("web")) => find(serverReadiness(input({ apps: [a], config: ok(config) }), NOW), "health");
  it("passes with a health path, with verify pages, or with the image's HEALTHCHECK", () => {
    expect(health(model()).state).toBe("ok");
    expect(health(model({ apps: [{ name: "web", image: "i", verify: [{ path: "/up" }] }] })).detail).toContain("/up");
    const withHealthcheck = app("web");
    if (withHealthcheck.container) withHealthcheck.container.state.health = "healthy";
    expect(health(model({ apps: [{ name: "web", image: "i" }] }), withHealthcheck).detail).toContain("HEALTHCHECK");
  });
  it("is to do, linking the app's form, with none of them", () => {
    expect(health(model({ apps: [{ name: "web", image: "i" }] }))).toMatchObject({ state: "todo", action: { href: "/servers/s1/config/apps/web" } });
  });
  it("leaves out a preview environment, which is not in the apps file", () => {
    const items = serverReadiness(input({ apps: [app("web"), app("web-pr-4")] }), NOW);
    expect(items.filter((i) => i.check === "health").map((i) => i.subject)).toEqual(["web"]);
  });
});

describe("rollback target exists", () => {
  const rollback = (histories: ServerReadinessInput["histories"], a = app("web")) => find(serverReadiness(input({ apps: [a], histories }), NOW), "rollback");
  it("passes when an earlier version succeeded, naming it", () => {
    expect(rollback({ web: ok([dep("r:v2", "succeeded", 30), dep("r:v1", "succeeded", 10)]) })).toMatchObject({ state: "ok" });
    expect(rollback({ web: ok([dep("r:v2", "succeeded", 30), dep("r:v1", "succeeded", 10)]) }).detail).toContain("v1");
  });
  it("is to do when every success ran what serves now", () => {
    const i = rollback({ web: ok([dep("r:v2", "succeeded", 30)]) });
    expect(i).toMatchObject({ state: "todo", action: { href: "/servers/s1/apps/web" } });
    expect(i.detail).toMatch(/no other version/);
  });
  it("is not applicable before the first deployment", () => {
    expect(rollback({ web: ok([]) }, app("web", { container: null })).state).toBe("na");
  });
  it("cannot tell when the deployments could not be read", () => {
    expect(rollback({ web: { kind: "failed", reason: "timeout" } }).detail).toContain("timeout");
  });
});

describe("agent and dashboard versions match", () => {
  const versions = (over: Partial<ServerReadinessInput>) => find(serverReadiness(input(over), NOW), "versions");
  it("passes when equal, warns with the update link when different", () => {
    expect(versions({}).state).toBe("ok");
    expect(versions({ version: "v0.9" })).toMatchObject({ state: "warning", action: { href: "/servers/s1/update" } });
  });
  it("warns, without an update link, when the agent is newer than the dashboard", () => {
    const item = versions({ version: "v0.2.0", bundledVersion: "v0.1.0" });
    expect(item.state).toBe("warning");
    expect(item.detail).toContain("update the dashboard first");
    expect(item.action).toBeUndefined();
    expect(versions({ version: "v0.1.0", bundledVersion: "v0.2.0" })).toMatchObject({ state: "warning", action: { href: "/servers/s1/update" } });
  });
  it("is not applicable when it cannot be compared", () => {
    expect(versions({ bundledVersion: null }).state).toBe("na");
    expect(versions({ version: undefined }).state).toBe("na");
  });
});

describe("what cannot be read", () => {
  it("is one 'to do' item for a server that did not answer, and nothing else of that server", () => {
    const items = serverReadiness(input({ reachable: false, reason: "connect ECONNREFUSED", apps: undefined, databases: undefined }), NOW);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ check: "reachable", state: "todo", scope: "server" });
    expect(items[0].detail).toContain("ECONNREFUSED");
  });
  it("is an item for a part that failed, not an absence", () => {
    const items = serverReadiness(input({ databases: undefined, errors: { databases: "the agent answered 500" } }), NOW);
    expect(items.some((i) => i.check === "reachable" && i.detail.includes("the agent answered 500"))).toBe(true);
    expect(items.some((i) => i.check === "backup")).toBe(false);
  });
  it("reads a configuration document", () => {
    expect(configAnswer({ data: null })).toEqual({ kind: "ok", value: null });
    expect(configAnswer({ error: "x" })).toEqual({ kind: "failed", reason: "x" });
    expect(configAnswer({ data: { content: "", hash: "", modified_at: "", model: model(), error: "line 3", applied_hash: "", deprecations: [] } })).toEqual({ kind: "failed", reason: "its configuration file is invalid" });
    expect(configAnswer({ data: { content: "", hash: "", modified_at: "", model: model(), applied_hash: "", deprecations: [] } }).kind).toBe("ok");
  });
});

describe("the dashboard's own items", () => {
  const dash = (over: Partial<Parameters<typeof dashboardReadiness>[0]> = {}) => dashboardReadiness({ totp: false, passkeys: 0, lastBackupAt: null, ...over }, NOW);
  it("asks for a second factor and a first copy", () => {
    const items = dash();
    expect(find(items, "second-factor")).toMatchObject({ state: "todo", scope: "dashboard", action: { href: "/settings/security" } });
    expect(find(items, "dashboard-backup")).toMatchObject({ state: "todo", action: { label: "Download a copy", href: "/settings/backup" } });
  });
  it("passes with a factor and a fresh copy, warns when the copy is older than 30 days", () => {
    expect(find(dash({ totp: true, lastBackupAt: NOW - 3 * DAY }), "second-factor")).toMatchObject({ state: "ok", detail: "2FA on: an authenticator app" });
    expect(find(dash({ passkeys: 2, lastBackupAt: NOW - 29 * DAY }), "dashboard-backup").state).toBe("ok");
    const stale = find(dash({ lastBackupAt: NOW - 31 * DAY }), "dashboard-backup");
    expect(stale.state).toBe("warning");
    expect(stale.since).toBe(ago(31 * DAY));
  });
});

describe("what a place lists", () => {
  const web = (id: string, name: string, extra: Partial<ServerReadinessInput> = {}) => serverReadiness(input({ server: { id, name }, ...extra }), NOW);
  const all = [...web("s1", "alpha"), ...web("s2", "beta", { databases: [db("other")], restoreTests: { other: ok([]) }, histories: { web: ok([]) } }), ...dashboardReadiness({ totp: true, passkeys: 0, lastBackupAt: NOW }, NOW)];
  const own = { name: "shop", servers: ["s1"], databases: new Set([ownedKey("s1", "main")]), apps: new Set([ownedKey("s1", "web")]) };

  it("gives a project its own databases and apps, its servers' items and the dashboard's, named after it", () => {
    const items = forProject(all, own);
    expect(items.filter((i) => i.scope === "project").every((i) => i.project === "shop" && i.server?.id === "s1")).toBe(true);
    expect(items.some((i) => i.server?.id === "s2")).toBe(false);
    expect(items.map((i) => i.check).sort()).toEqual(["alert", "backup", "dashboard-backup", "health", "key", "offsite", "restore", "rollback", "second-factor", "versions"]);
  });
  it("sorts by group, the worst first inside it", () => {
    const items = forProject(
      [...web("s1", "alpha", { databases: [db("main"), db("zzz", null)], restoreTests: {} })],
      { ...own, databases: new Set([ownedKey("s1", "main"), ownedKey("s1", "zzz")]) },
    );
    const data = items.filter((i) => i.group === "data");
    expect(data[0].state).toBe("todo");
    expect(data.at(-1)?.state).toBe("ok");
    expect(items.map((i) => i.group)).toEqual([...items.map((i) => i.group)].sort((a, b) => ["data", "alerts", "deploys", "access"].indexOf(a) - ["data", "alerts", "deploys", "access"].indexOf(b)));
  });
  it("says a project with no database has nothing to back up, instead of showing nothing or green", () => {
    const items = forProject(all, { ...own, databases: new Set() });
    const none = items.find((i) => i.id === "project:shop:no-database");
    expect(none).toMatchObject({ state: "na", group: "data" });
    expect(none?.detail).toContain("no database");
    expect(items.some((i) => i.check === "restore")).toBe(false);
    expect(readinessSummary(items).total).toBe(items.filter((i) => i.state !== "na").length);
  });
  it("gives a server its own items only", () => {
    expect(forServer(all, "s1").map((i) => i.check).sort()).toEqual(["alert", "versions"]);
    expect(forServer(all, "s2").every((i) => i.server?.id === "s2" && i.scope === "server")).toBe(true);
  });
});

describe("the verdict", () => {
  it("counts what passes against what applies; not applicable counts neither way", () => {
    const items = [...serverReadiness(input({ databases: [db("main", null)] }), NOW), ...dashboardReadiness({ totp: true, passkeys: 0, lastBackupAt: null }, NOW)];
    const summary = readinessSummary(items);
    expect(summary.total).toBe(items.filter((i) => i.state !== "na").length);
    expect(summary.passing).toBe(items.filter((i) => i.state === "ok").length);
    expect(summary.text).toBe(`Trust: ${summary.passing} of ${summary.total} checks pass`);
  });
  it("names the worst first: a failing check before a to do, then the data group first", () => {
    const failing = serverReadiness(input({ databases: [db("main", { last_run: run({ status: "failed" }) })], proofs: ok([]), config: ok(model({ notifications: undefined })) }), NOW);
    expect(readinessSummary(failing).worst).toMatchObject({ check: "backup", state: "critical" });
    const todos = serverReadiness(input({ proofs: ok([]), config: ok(model({ notifications: undefined })) }), NOW);
    expect(readinessSummary(todos).worst).toMatchObject({ group: "data", state: "todo" });
  });
  it("has no worst when everything passes, and says so when nothing applies", () => {
    expect(readinessSummary(serverReadiness(input(), NOW)).worst).toBeNull();
    expect(readinessSummary([]).text).toBe("Trust: no check applies yet");
    expect(readinessSummary(serverReadiness(input({ databases: [db("main")] }), NOW).slice(0, 1)).text).toBe("Trust: 1 of 1 check passes");
  });
  it("links to the project's tab, the server's page or the dashboard's settings", () => {
    const items = serverReadiness(input(), NOW);
    expect(readinessHref({ ...find(items, "key"), project: "shop" })).toBe("/projects/shop/readiness");
    expect(readinessHref(find(items, "versions"))).toBe("/servers/s1");
    expect(readinessHref(find(items, "key"))).toBe("/servers/s1/databases/main");
    const dash = dashboardReadiness({ totp: false, passkeys: 0, lastBackupAt: null }, NOW);
    expect(readinessHref(find(dash, "second-factor"))).toBe("/settings/security");
    expect(readinessHref(find(dash, "dashboard-backup"))).toBe("/settings/backup");
  });
});
