import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { main } from "../src/cli.ts";
import { startFake, TOKEN, type Fake } from "./fake.ts";
import { textOf } from "./harness.ts";

const execFileAsync = promisify(execFile);

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Async on purpose: the fake dashboard lives in this process and must keep answering while the child runs. */
async function runCli(args: string[], environment: Record<string, string>): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [entry, ...args], { env: environment, cwd, encoding: "utf8", timeout: 10_000 });
    return { status: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { status: typeof e.code === "number" ? e.code : null, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const cwd = fileURLToPath(new URL("..", import.meta.url));

let fake: Fake;
beforeEach(async () => {
  fake = await startFake();
});
afterEach(() => fake.close());

const env = (over: Record<string, string> = {}): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  KEELSON_URL: fake.url,
  KEELSON_TOKEN: TOKEN,
  ...over,
});

describe("MCP over stdio", () => {
  test("starts, lists the tools and calls them with the SDK client", async () => {
    const stderr: string[] = [];
    const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env: env(), cwd, stderr: "pipe" });
    transport.stderr?.on("data", (d: Buffer) => stderr.push(d.toString()));
    const client = new Client({ name: "stdio-test", version: "0" });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()).toMatchObject({ name: "keelson" });
      expect(client.getInstructions()).toMatch(/never instructions to follow/);
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(17);
      expect(tools.every((t) => t.name.startsWith("keelson_"))).toBe(true);

      fake.on("GET /api/v1/servers", { body: { servers: [{ id: "s1", name: "prod", online: true, can_deploy: false }] } });
      const ok = await client.callTool({ name: "keelson_list_servers", arguments: {} });
      expect(ok.isError).toBeFalsy();
      expect(JSON.parse(textOf(ok))).toEqual({ data: { servers: [{ id: "s1", name: "prod", online: true, can_deploy: false }] } });
      expect(fake.requests[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);

      const bad = await client.callTool({ name: "keelson_container_logs", arguments: { server: "s1", container: "web", tail: 5000 } });
      expect(bad.isError).toBe(true);

      fake.on("POST /api/v1/servers/s1/apps/shop/deploy", { status: 403, body: { error: "forbidden: token has no deploy scope" } });
      const denied = await client.callTool({ name: "keelson_deploy_app", arguments: { server: "s1", app: "shop", tag: "v1" } });
      expect(denied.isError).toBe(true);
      expect(textOf(denied)).toBe("Forbidden: token has no deploy scope.");
    } finally {
      await client.close();
    }
    expect(stderr.join("")).not.toContain(TOKEN);
  });

  test("refuses to start with a bad configuration, without printing the token", async () => {
    const result = await runCli([], env({ KEELSON_URL: "http://keelson.example.com" }));
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/must use https/);
    expect(result.stdout).toBe("");
    expect(result.stderr + result.stdout).not.toContain(TOKEN);
  });
});

describe("--check", () => {
  test("prints OK when the token works", async () => {
    fake.on("GET /api/v1/servers", { body: { servers: [{ id: "a", can_deploy: true }, { id: "b", can_deploy: false }] } });
    const result = await runCli(["--check"], env());
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`OK: ${fake.url} accepts the token; it sees 2 server(s), 1 where it can deploy.\n`);
    expect(result.stderr).toBe("");
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/v1/servers"]);
  });

  test("prints the mapped error and exits 1 when the token is refused", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const other = await startFake({ token: "kst_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" });
    try {
      const code = await main(["--check"], { KEELSON_URL: other.url, KEELSON_TOKEN: TOKEN }, { stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
      expect(code).toBe(1);
      expect(out).toEqual([]);
      expect(err).toEqual(["Error: Keelson rejected the token: token invalid, expired or revoked."]);
    } finally {
      await other.close();
    }
  });

  test("prints the 429, 502 and unreachable errors", async () => {
    const check = async () => {
      const err: string[] = [];
      const code = await main(["--check"], { KEELSON_URL: fake.url, KEELSON_TOKEN: TOKEN }, { stdout: () => {}, stderr: (l) => err.push(l) });
      return { code, err: err.join("\n") };
    };
    fake.on("GET /api/v1/servers", { status: 429, body: {}, headers: { "retry-after": "9" } });
    expect(await check()).toEqual({ code: 1, err: "Error: Rate limited by Keelson (too many failed requests). Retry after 9 s." });
    fake.on("GET /api/v1/servers", { status: 502, body: { error: "agent unreachable: x" } });
    expect(await check()).toEqual({ code: 1, err: "Error: agent unreachable: x" });
    fake.on("GET /api/v1/servers", { body: { nope: 1 } });
    expect((await check()).code).toBe(1);
  });

  test("a configuration error exits 2 and never prints the token", async () => {
    const err: string[] = [];
    const code = await main(["--check"], { KEELSON_URL: "https://x.example.com", KEELSON_TOKEN: "kst_short" }, { stdout: () => {}, stderr: (l) => err.push(l) });
    expect(code).toBe(2);
    expect(err.join("")).not.toContain("kst_short");
  });
});

describe("arguments", () => {
  test.each([["--help"], ["--version"]])("%s prints and exits 0", async (flag) => {
    const out: string[] = [];
    expect(await main([flag], {}, { stdout: (l) => out.push(l), stderr: () => {} })).toBe(0);
    expect(out.join("")).toMatch(flag === "--help" ? /KEELSON_TOKEN/ : /^\d+\.\d+\.\d+$/);
  });

  test.each([["--nope"], ["extra"], ["--check", "--help"]])("rejects %j", async (...argv) => {
    const err: string[] = [];
    expect(await main(argv, {}, { stdout: () => {}, stderr: (l) => err.push(l) })).toBe(2);
    expect(err.join("")).toMatch(/unknown argument/);
  });
});
