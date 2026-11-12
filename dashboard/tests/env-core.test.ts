import { describe, expect, it } from "vitest";
import type { Deployment, EnvVar } from "@/lib/agent-types";
import { parseDotenv } from "@/lib/dotenv-core";
import {
  BUILD_WARNING,
  changeIssues,
  envPending,
  envSavedNotice,
  keyIssue,
  lastChanged,
  looksSecret,
  MAX_KEYS,
  portKeysOf,
  reviewImport,
  scopeLabel,
  scopeLabels,
  scopeOf,
  shadowLabel,
  suggestsBuild,
  toChange,
  valueIssue,
} from "@/lib/env-core";

const stored = (key: string, over: Partial<EnvVar> = {}): EnvVar => ({ key, updated_at: "2026-10-20T10:00:00Z", build: false, shadows: null, ...over });
const deployment = (over: Partial<Deployment>): Deployment => ({ id: "d", app: "shop", ref: "shop:v1", status: "succeeded", trigger: "api", started_at: "2026-10-21T10:00:00Z", ...over });

describe("names and values, as the agent checks them", () => {
  it("accepts names of letters, digits and _ not starting with a digit, up to 128", () => {
    for (const k of ["A", "_x", "DATABASE_URL", "a1_B2", "X".repeat(128)]) expect(keyIssue(k), k).toBeNull();
    for (const k of ["", "1A", "A-B", "A B", "é", "X".repeat(129), "A.B"]) expect(keyIssue(k), k).not.toBeNull();
  });

  it("refuses the names Keelson sets itself", () => {
    for (const k of ["PATH", "HOME", "HOSTNAME", "KEELSON_TOKEN", "KEELSON_"]) expect(keyIssue(k), k).toMatch(/cannot be overridden/);
    expect(keyIssue("KEELSONX")).toBeNull();
  });

  it("refuses PORT, and the app's port.env, only when the app has a port the agent sets", () => {
    expect(keyIssue("PORT")).toBeNull();
    expect(portKeysOf({ name: "x" } as never)).toEqual([]);
    expect(portKeysOf(undefined)).toEqual([]);
    expect(portKeysOf({ port: 3000 })).toEqual(["PORT"]);
    expect(portKeysOf({ port: { host: [8080, 8081], env: "LISTEN" } })).toEqual(["PORT", "LISTEN"]);
    const rules = { portKeys: portKeysOf({ port: { container: 3000, env: "LISTEN" } }) };
    expect(keyIssue("PORT", rules)).toMatch(/set by Keelson/);
    expect(keyIssue("LISTEN", rules)).toMatch(/set by Keelson/);
    expect(keyIssue("OTHER", rules)).toBeNull();
  });

  it("limits a value to 32 KiB (bytes, not characters) and refuses NUL; empty is allowed", () => {
    expect(valueIssue("")).toBeNull();
    expect(valueIssue("a".repeat(32 * 1024))).toBeNull();
    expect(valueIssue("a".repeat(32 * 1024 + 1))).toMatch(/32 KiB/);
    expect(valueIssue("é".repeat(16 * 1024 + 1))).toMatch(/32 KiB/);
    expect(valueIssue("a\0b")).toMatch(/NUL/);
  });

  it("counts the names already stored toward the 200 keys, and the values toward 256 KiB", () => {
    const existing = Array.from({ length: MAX_KEYS }, (_, i) => `K${i}`);
    expect(changeIssues([{ key: "K1", value: "x", build: false }], [], existing)).toEqual([]);
    expect(changeIssues([{ key: "NEW", value: "x", build: false }], [], existing)).toEqual([{ key: "", message: "A scope can hold at most 200 variables." }]);
    expect(changeIssues([{ key: "NEW", value: "x", build: false }], ["K1"], existing)).toEqual([]);
    const big = Array.from({ length: 9 }, (_, i) => ({ key: `B${i}`, value: "v".repeat(30 * 1024), build: false }));
    expect(changeIssues(big, [], [])).toEqual([{ key: "", message: "The values of a scope can take at most 256 KiB in all." }]);
  });

  it("names the key of each issue and refuses to remove a name that is not valid", () => {
    const issues = changeIssues([{ key: "bad-key", value: "ok", build: false }, { key: "GOOD", value: "a\0", build: false }], ["not valid"], []);
    expect(issues.map((i) => i.key)).toEqual(["bad-key", "GOOD", "not valid"]);
  });
});

describe("build-time hints", () => {
  it("suggests build time for the names frameworks expose to the browser, and nothing else", () => {
    for (const k of ["NEXT_PUBLIC_API", "VITE_URL", "PUBLIC_KEY_X"]) expect(suggestsBuild(k), k).toBe(true);
    for (const k of ["DATABASE_URL", "PUBLIC", "MY_VITE_X", "NEXT_PUBLICX"]) expect(suggestsBuild(k), k).toBe(false);
  });

  it("recognises names that look like secrets, and the warning says what happens to a build-time value", () => {
    for (const k of ["API_KEY", "STRIPE_SECRET", "GITHUB_TOKEN", "DB_PASSWORD", "PRIVATE_KEY", "AWS_ACCESS_KEY_ID", "OAUTH_CREDENTIALS"]) expect(looksSecret(k), k).toBe(true);
    for (const k of ["NEXT_PUBLIC_API_URL", "NODE_ENV", "LOG_LEVEL"]) expect(looksSecret(k), k).toBe(false);
    expect(BUILD_WARNING).toMatch(/baked into the image/);
    expect(BUILD_WARNING).toMatch(/visible in its history/);
    expect(BUILD_WARNING).toMatch(/Never use it for a secret/);
  });
});

describe("toChange", () => {
  it("sends the exact list of build arguments after the change, starting from the ones stored", () => {
    const vars = [stored("A", { build: true }), stored("B"), stored("C", { build: true })];
    const change = toChange("app", [{ key: "B", value: "v", build: true }, { key: "C", value: "w", build: false }, { key: "D", value: "x", build: false }], ["A"], vars);
    expect(change).toEqual({ scope: "app", set: { B: "v", C: "w", D: "x" }, build: ["B"], unset: ["A"] });
  });

  it("keeps the stored value when the edit has none: only the flag moves", () => {
    const change = toChange("preview", [{ key: "A", value: null, build: true }], [], [stored("A")]);
    expect(change).toEqual({ scope: "preview", set: {}, build: ["A"] });
  });

  it("uses the last edit of a name", () => {
    expect(toChange("app", [{ key: "A", value: "1", build: true }, { key: "A", value: "2", build: false }], [], [])).toEqual({ scope: "app", set: { A: "2" }, build: [] });
  });
});

describe("reviewImport", () => {
  const review = (text: string, existing: EnvVar[] = [], rules = {}) => reviewImport(parseDotenv(text), existing, rules);

  it("tells new names from the ones that replace a stored value, and pre-ticks build time for browser-exposed names", () => {
    const out = review("NEW=1\nOLD=2\nNEXT_PUBLIC_X=3\n", [stored("OLD")]);
    expect(out.rows.map((r) => [r.key, r.status, r.build])).toEqual([
      ["NEW", "new", false],
      ["OLD", "replace", false],
      ["NEXT_PUBLIC_X", "new", true],
    ]);
  });

  it("marks what cannot be imported, with the reason, and lists unreadable lines and repeats", () => {
    const out = review("PATH=/bin\nKEELSON_X=1\nOK=1\nOK=2\nnot a line\nPORT=1\n", [], { portKeys: ["PORT"] });
    expect(out.rows.map((r) => [r.key, r.status])).toEqual([
      ["PATH", "invalid"],
      ["KEELSON_X", "invalid"],
      ["OK", "new"],
      ["PORT", "invalid"],
    ]);
    expect(out.rows[0].issue).toMatch(/cannot be overridden/);
    expect(out.unreadable).toEqual([{ line: 5, reason: "no = sign" }]);
    expect(out.repeated).toEqual([{ key: "OK", lines: [3, 4] }]);
  });

  it("flags an import that would go over the number of variables", () => {
    const text = Array.from({ length: 201 }, (_, i) => `V${i}=x`).join("\n");
    expect(review(text).issues).toEqual([{ key: "", message: "A scope can hold at most 200 variables." }]);
    expect(review("A=1").issues).toEqual([]);
  });

  it("never carries a value in its rows", () => {
    const out = review("TOKEN=very-secret-value\nOTHER=\"multi\nline-secret\"\n");
    expect(JSON.stringify(out)).not.toMatch(/secret/);
  });
});

describe("a change the running version does not have", () => {
  const app = { env_changed_at: "2026-10-22T10:00:00Z" };

  it("is pending when the variables changed after the last deployment that started", () => {
    expect(envPending(app, [deployment({ started_at: "2026-10-21T10:00:00Z" })])).toEqual({ changedAt: "2026-10-22T10:00:00Z" });
  });

  it("is not pending once a deployment started after the change, including one that is still running", () => {
    expect(envPending(app, [deployment({ started_at: "2026-10-22T11:00:00Z" })])).toBeNull();
    expect(envPending(app, [deployment({ status: "running", started_at: "2026-10-22T11:00:00Z" }), deployment({ started_at: "2026-10-21T10:00:00Z" })])).toBeNull();
  });

  it("ignores failed deployments, which did not serve the variables", () => {
    expect(envPending(app, [deployment({ status: "failed", started_at: "2026-10-22T11:00:00Z" }), deployment({ started_at: "2026-10-21T10:00:00Z" })])).not.toBeNull();
  });

  it("says nothing without a change, without a successful deployment, or when the history is unknown", () => {
    expect(envPending({}, [deployment({})])).toBeNull();
    expect(envPending({ env_changed_at: "" }, [deployment({})])).toBeNull();
    expect(envPending({ env_changed_at: "not a date" }, [deployment({})])).toBeNull();
    expect(envPending(app, [])).toBeNull();
    expect(envPending(app, [deployment({ status: "failed" })])).toBeNull();
    expect(envPending(app, null)).toBeNull();
  });
});

describe("what to tell after saving", () => {
  const o = { serverId: "s1", app: "shop", servingImage: "registry/shop:v1.2", buildKeys: 0 };

  it("keeps the production notice until dismissed, with a Deploy that opens the dialog with the serving tag", () => {
    const n = envSavedNotice("app", o);
    expect(n).toMatchObject({ title: "Saved. Not running yet: deploy to apply", persistent: true, action: { label: "Deploy", href: "/servers/s1/apps/shop?deploy=v1.2" } });
    expect(n.description).not.toMatch(/built again/);
  });

  it("warns that a build-time value needs a new build, not a redeploy", () => {
    expect(envSavedNotice("app", { ...o, buildKeys: 1 }).description).toMatch(/built again, not when it is deployed again/);
  });

  it("tells that previews take the change from their next deployment, with no Deploy of the app", () => {
    const n = envSavedNotice("preview", o);
    expect(n.title).toMatch(/previews deployed from now/);
    expect(n.action).toBeUndefined();
    expect(n.persistent).toBe(false);
  });
});

describe("small helpers", () => {
  it("labels what a managed value overrides", () => {
    expect(shadowLabel("env_file")).toBe("Overrides env_file");
    expect(shadowLabel("env")).toBe("Overrides env");
    expect(shadowLabel(null)).toBeNull();
  });

  it("takes the agent's last change, else the latest of the variables", () => {
    expect(lastChanged({ vars: [], last_changed: "2026-10-23T10:00:00Z" })).toBe("2026-10-23T10:00:00Z");
    expect(lastChanged({ vars: [stored("A", { updated_at: "2026-10-01T00:00:00Z" }), stored("B", { updated_at: "2026-10-05T00:00:00Z" })], last_changed: null })).toBe("2026-10-05T00:00:00Z");
    expect(lastChanged({ vars: [] })).toBeNull();
  });

  it("reads the scope of a query, defaulting to the app", () => {
    expect(scopeOf("preview")).toBe("preview");
    expect(scopeOf(["preview", "app"])).toBe("preview");
    for (const v of [undefined, "app", "x", ""]) expect(scopeOf(v)).toBe("app");
  });

  it("labels the app's scope with the environment's own name and the other Previews", () => {
    expect(scopeLabels("staging")).toEqual([
      { scope: "app", label: "staging" },
      { scope: "preview", label: "Previews" },
    ]);
    expect(scopeLabel("app", "production")).toBe("production");
    expect(scopeLabel("preview", "production")).toBe("Previews");
  });
});
