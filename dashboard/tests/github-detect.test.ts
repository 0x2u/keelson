import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GithubAppError } from "@/lib/github-app";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-detect-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;
const { RepoReadError, branchHead, detectRepo } = await import("@/lib/github-detect");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const TOKEN = "ghs_installation_token_abcdef";
const SHA = "a".repeat(40);

/** A fake GitHub: `files` maps a path to its text, `dirs` a directory to its entries. Records every request. */
function fakeGithub(opts: { files: Record<string, string>; dirs: Record<string, { name: string; type: "file" | "dir" }[]>; status?: Record<string, number> }) {
  const asked: { method: string; path: string; ref: string | null; auth: string }[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    asked.push({ method: init.method ?? "GET", path: u.pathname, ref: u.searchParams.get("ref"), auth: String((init.headers as Record<string, string>).Authorization) });
    const forced = opts.status?.[u.pathname];
    if (forced) return new Response("{}", { status: forced });
    if (u.pathname === "/repos/acme/shop") return Response.json({ default_branch: "main", private: true });
    if (u.pathname === "/repos/acme/shop/commits/main") return Response.json({ sha: SHA });
    const prefix = "/repos/acme/shop/contents/";
    if (u.pathname.startsWith(prefix)) {
      const p = decodeURIComponent(u.pathname.slice(prefix.length));
      if (Object.hasOwn(opts.dirs, p)) return Response.json(opts.dirs[p]);
      if (Object.hasOwn(opts.files, p)) {
        const text = opts.files[p]!;
        return Response.json({ type: "file", size: text.length, encoding: "base64", content: Buffer.from(text).toString("base64") });
      }
    }
    return new Response("{}", { status: 404 });
  };
  return { fetch, asked };
}

const deps = (fetch: (url: string, init: RequestInit) => Promise<Response>) => ({ fetch, token: async () => TOKEN });

describe("detectRepo", () => {
  it("finds the default branch, its head, and the Dockerfiles in the likely places with their port and health check", async () => {
    const gh = fakeGithub({
      dirs: {
        "": [
          { name: "Dockerfile", type: "file" },
          { name: "docker", type: "dir" },
          { name: "api", type: "dir" },
          { name: "node_modules", type: "dir" },
          { name: "README.md", type: "file" },
        ],
        docker: [{ name: "Dockerfile", type: "file" }],
        api: [{ name: "Dockerfile", type: "file" }, { name: "main.go", type: "file" }],
      },
      files: {
        Dockerfile: "FROM node:22\nEXPOSE 3000\nHEALTHCHECK CMD true\n",
        "docker/Dockerfile": "FROM nginx\nEXPOSE 80\n",
        "api/Dockerfile": "FROM golang\nARG P=1\nEXPOSE $P\n",
      },
    });
    const found = await detectRepo("Acme/Shop".toLowerCase(), deps(gh.fetch));
    expect(found).toMatchObject({ repo: "acme/shop", defaultBranch: "main", sha: SHA, private: true, truncated: false });
    expect(found.candidates).toEqual([
      { path: "Dockerfile", context: ".", dockerfile: "Dockerfile", port: 3000, portFromVariable: false, healthcheck: true },
      { path: "docker/Dockerfile", context: ".", dockerfile: "docker/Dockerfile", port: 80, portFromVariable: false, healthcheck: false },
      { path: "api/Dockerfile", context: "api", dockerfile: "Dockerfile", port: null, portFromVariable: true, healthcheck: false },
    ]);
  });

  it("is read-only, reads at the head commit, and never looks into dependency directories", async () => {
    const gh = fakeGithub({ dirs: { "": [{ name: "node_modules", type: "dir" }, { name: "src", type: "dir" }], src: [] }, files: {} });
    await detectRepo("acme/shop", deps(gh.fetch));
    expect(gh.asked.every((r) => r.method === "GET")).toBe(true);
    expect(gh.asked.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(gh.asked.filter((r) => r.path.includes("/contents/")).every((r) => r.ref === SHA)).toBe(true);
    expect(gh.asked.some((r) => r.path.includes("node_modules"))).toBe(false);
    expect(gh.asked.map((r) => r.path)).toContain("/repos/acme/shop/commits/main");
  });

  it("reports no candidate for a repository without a Dockerfile", async () => {
    const gh = fakeGithub({ dirs: { "": [{ name: "README.md", type: "file" }] }, files: {} });
    expect((await detectRepo("acme/shop", deps(gh.fetch))).candidates).toEqual([]);
  });

  it("finds Dockerfile.prod and deploy/Dockerfile", async () => {
    const gh = fakeGithub({
      dirs: { "": [{ name: "Dockerfile.prod", type: "file" }, { name: "deploy", type: "dir" }], deploy: [{ name: "Dockerfile", type: "file" }] },
      files: { "Dockerfile.prod": "FROM a\nEXPOSE 8080\n", "deploy/Dockerfile": "FROM a\nEXPOSE 9090\n" },
    });
    expect((await detectRepo("acme/shop", deps(gh.fetch))).candidates.map((c) => [c.path, c.port])).toEqual([["Dockerfile.prod", 8080], ["deploy/Dockerfile", 9090]]);
  });

  it("explains a repository the App cannot see, a refusal, and an unreachable GitHub, without the token", async () => {
    const hidden = fakeGithub({ dirs: {}, files: {}, status: { "/repos/acme/shop": 404 } });
    await expect(detectRepo("acme/shop", deps(hidden.fetch))).rejects.toThrow(/cannot see it/);
    const refused = fakeGithub({ dirs: {}, files: {}, status: { "/repos/acme/shop/contents/": 403 } });
    await expect(detectRepo("acme/shop", deps(refused.fetch))).rejects.toThrow(/Contents: read/);
    const empty = fakeGithub({ dirs: {}, files: {}, status: { "/repos/acme/shop/commits/main": 409 } });
    await expect(detectRepo("acme/shop", deps(empty.fetch))).rejects.toThrow(/repository is empty/);
    const down = deps(async () => {
      throw new Error(`boom ${TOKEN}`);
    });
    const err = await detectRepo("acme/shop", down).catch((e) => e);
    expect(err).toBeInstanceOf(RepoReadError);
    expect(String(err.message)).not.toContain(TOKEN);
  });

  it("passes on what is wrong with the App (not installed) instead of reading anything", async () => {
    let calls = 0;
    const err = await detectRepo("acme/shop", {
      fetch: async () => {
        calls++;
        return Response.json({});
      },
      token: async () => {
        throw new GithubAppError("The GitHub App is not installed on acme/shop: install it.", 404);
      },
    }).catch((e) => e);
    expect(err.message).toMatch(/not installed/);
    expect(calls).toBe(0);
  });

  it("refuses anything that is not a repository name", async () => {
    await expect(detectRepo("../../etc", deps(async () => Response.json({})))).rejects.toThrow(/not a GitHub repository/);
  });
});

describe("what detectRepo suggests", () => {
  it("reads package.json, the Prisma schema and migrations, and the example environment file of the repository", async () => {
    const gh = fakeGithub({
      dirs: {
        "": [
          { name: "package.json", type: "file" },
          { name: ".env.example", type: "file" },
          { name: "prisma", type: "dir" },
          { name: "app", type: "dir" },
        ],
        prisma: [{ name: "schema.prisma", type: "file" }, { name: "migrations", type: "dir" }],
        app: [],
      },
      files: {
        "package.json": JSON.stringify({ dependencies: { next: "16", "@prisma/client": "6" } }),
        "prisma/schema.prisma": 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
        ".env.example": "DATABASE_URL=postgresql://u:p@localhost/x\nSESSION_SECRET=change-me\n",
      },
    });
    const found = await detectRepo("acme/shop", deps(gh.fetch));
    expect(found.suggestion).toEqual({
      framework: { id: "nextjs", reason: "package.json depends on next." },
      release: { command: "npx prisma migrate deploy", reason: "prisma/migrations exists." },
      database: { reason: "prisma/schema.prisma uses PostgreSQL." },
      envNames: ["SESSION_SECRET"],
    });
    expect(gh.asked.every((r) => r.method === "GET")).toBe(true);
  });

  it("asks only for files the root listing shows: a repository without them costs no request for them", async () => {
    const gh = fakeGithub({ dirs: { "": [{ name: "README.md", type: "file" }] }, files: {} });
    const found = await detectRepo("acme/shop", deps(gh.fetch));
    expect(found.suggestion).toEqual({ framework: null, release: null, database: null, envNames: [] });
    expect(gh.asked.map((r) => r.path).filter((p) => /package\.json|prisma|\.env/.test(p))).toEqual([]);
  });

  it("suggests the Dockerfile over package.json, and flags a Dockerfile that needs BuildKit", async () => {
    const gh = fakeGithub({
      dirs: { "": [{ name: "Dockerfile", type: "file" }, { name: "Dockerfile.prod", type: "file" }, { name: "package.json", type: "file" }] },
      files: {
        Dockerfile: "FROM node:22\nRUN --mount=type=cache,target=/c pnpm install\nEXPOSE 3000\n",
        "Dockerfile.prod": "FROM node:22\nRUN pnpm install\nEXPOSE 3000\n",
        "package.json": JSON.stringify({ dependencies: { next: "16" } }),
      },
    });
    const found = await detectRepo("acme/shop", deps(gh.fetch));
    expect(found.suggestion.framework?.id).toBe("dockerfile");
    expect(found.candidates.map((c) => [c.path, c.buildkit === true])).toEqual([["Dockerfile", true], ["Dockerfile.prod", false]]);
    expect(found.candidates[1]).not.toHaveProperty("buildkit");
  });
});

describe("branchHead", () => {
  it("returns the head commit of a branch, and refuses a bad branch name without asking", async () => {
    const gh = fakeGithub({ dirs: {}, files: {} });
    expect(await branchHead("acme/shop", "main", deps(gh.fetch))).toBe(SHA);
    await expect(branchHead("acme/shop", "bad..name", deps(gh.fetch))).rejects.toThrow(/valid branch/);
    expect(gh.asked).toHaveLength(1);
  });
});
