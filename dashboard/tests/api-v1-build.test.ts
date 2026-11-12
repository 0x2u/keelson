import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-api-v1-build-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

type Answer = { ok: true; deploymentId: string; serverId: string; sha: string; repo: string } | { ok: false; error: string; asked: boolean };
const asked: { serverId: string; app: string; sha: string | null }[] = [];
let answer: Answer = { ok: true, deploymentId: "dep-build", serverId: "builder", sha: "a".repeat(40), repo: "acme/shop" };
vi.mock("@/lib/build-request", () => ({
  requestBuild: async (serverId: string, app: string, sha: string | null) => {
    asked.push({ serverId, app, sha });
    return answer;
  },
}));

const { db } = await import("@/lib/db");
const tokens = await import("@/lib/api-tokens");
const servers = await import("@/lib/servers");
const store = await import("@/lib/auth/store");
const { POST } = await import("@/app/api/v1/servers/[id]/apps/[app]/build/route");

let prod = "";
let other = "";
let readOnly = "";
beforeAll(() => {
  prod = servers.createServer({ name: "prod", url: "https://prod.example.com", token: "t".repeat(40), deploySecret: "s".repeat(40) });
  other = servers.createServer({ name: "other", url: "https://other.example.com", token: "t".repeat(40), deploySecret: "s".repeat(40) });
  readOnly = servers.createServer({ name: "ro", url: "https://ro.example.com", token: "t".repeat(40) });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  for (const table of ["api_tokens", "audit_log", "login_failures"]) db().exec(`DELETE FROM ${table}`);
  asked.length = 0;
  answer = { ok: true, deploymentId: "dep-build", serverId: "builder", sha: "a".repeat(40), repo: "acme/shop" };
});

let minted = 0;
const mint = (over: Partial<{ scope: "read" | "deploy"; servers: string[] | null }> = {}) => tokens.createApiToken({ name: `ops${++minted}`, scope: "deploy", servers: null, days: 30, ...over }).token;
const call = (token: string | null, id: string, body?: string) =>
  POST(new Request(`http://dash/api/v1/servers/${id}/apps/shop/build`, { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {}, body }), { params: Promise.resolve({ id, app: "shop" }) });
const audited = () => store.recentAudit(10).map((e) => `${e.event}|${e.actor}|${e.detail}`);

describe("POST /api/v1/servers/{id}/apps/{app}/build", () => {
  it("builds the head of the linked branch and says which server holds the deployment", async () => {
    const res = await call(mint(), prod);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ deployment_id: "dep-build", server_id: "builder", sha: "a".repeat(40), repo: "acme/shop" });
    expect(asked).toEqual([{ serverId: prod, app: "shop", sha: null }]);
    expect(audited()).toEqual([`api_build|token:ops1|server=prod app=shop ref=${"a".repeat(40)} outcome=accepted deployment_id=dep-build`]);
  });

  it("builds the commit it is given", async () => {
    const sha = "b".repeat(40);
    expect((await call(mint(), prod, JSON.stringify({ sha }))).status).toBe(202);
    expect(asked[0]!.sha).toBe(sha);
  });

  it("needs the deploy scope, on a server the token may reach, and a server that can deploy", async () => {
    expect((await call(null, prod)).status).toBe(401);
    expect((await call(mint({ scope: "read" }), prod)).status).toBe(403);
    expect((await call(mint({ servers: [other] }), prod)).status).toBe(403);
    const refused = await call(mint(), readOnly);
    expect(refused.status).toBe(409);
    expect(asked).toEqual([]);
    expect(audited().some((l) => l.includes("refused: the server has no deploy secret"))).toBe(true);
  });

  it("refuses a body that is not empty or {sha}, before anything is asked of anyone", async () => {
    const token = mint();
    for (const body of ["not json", "[]", '{"sha": 5}', '{"sha": "a", "extra": 1}', '{"branch": "main"}', "x".repeat(5000)]) {
      expect((await call(token, prod, body)).status, body.slice(0, 20)).toBe(400);
    }
    expect(asked).toEqual([]);
  });

  it("answers what the build request says: 400 when it never reached the agents, 409 when they refused", async () => {
    answer = { ok: false, error: "Link this app to its repository first (Source).", asked: false };
    const notLinked = await call(mint(), prod);
    expect(notLinked.status).toBe(400);
    expect(await notLinked.json()).toMatchObject({ error: expect.stringContaining("Link this app") });
    answer = { ok: false, error: "a deployment or build is already running on the agent", asked: true };
    expect((await call(mint(), prod)).status).toBe(409);
    expect(audited()[0]).toContain("refused: a deployment or build is already running on the agent");
  });
});
