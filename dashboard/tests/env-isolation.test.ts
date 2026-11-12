import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPublic } from "@/proxy";

// Managed environment variables are the dashboard's own, behind a session. An API token (the /api/v1 REST API) and the MCP
// server, which speaks through that API, must never reach them: no route, no tool, no call into the code that does.

const root = path.resolve(__dirname, "..");
const mcp = path.resolve(root, "..", "mcp", "src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

/** What would put a variable's name, value or API in reach: the agent routes, the client calls, the action and the parsing modules. */
const REACHES_ENV = /\/env\b|envVars|setEnv|deleteEnv|saveEnvAction|deleteEnvScopeAction|env-actions|env-core|dotenv|EnvVar|EnvChange|environment variable/i;

describe("what an API token and the MCP cannot reach", () => {
  const apiFiles = [...files(path.join(root, "app", "api", "v1")), ...readdirSync(path.join(root, "lib")).filter((f) => f.startsWith("api-v1")).map((f) => path.join(root, "lib", f))];

  it("has no /api/v1 route about variables", () => {
    expect(apiFiles.length).toBeGreaterThan(10);
    for (const f of files(path.join(root, "app", "api", "v1"))) expect(path.relative(root, f), f).not.toMatch(/env/i);
  });

  it("has nothing in the REST API or its views that calls or names the variables", () => {
    for (const f of apiFiles) {
      const text = readFileSync(f, "utf8");
      // The one mention is the view that takes an app's `env_changed_at` out of what the API returns.
      const body = text.replace(/env_changed_at/g, "");
      expect(body, path.relative(root, f)).not.toMatch(REACHES_ENV);
    }
  });

  it("has no MCP tool about variables, and no call to them in the MCP's code", () => {
    if (!existsSync(mcp)) return;
    const sources = files(mcp).filter((f) => f.endsWith(".ts"));
    expect(sources.length).toBeGreaterThan(3);
    for (const f of sources) {
      const text = readFileSync(f, "utf8").replace(/^#!.*\n/, "");
      expect(text, path.relative(root, f)).not.toMatch(REACHES_ENV);
    }
    const tools = readFileSync(path.join(mcp, "tools.ts"), "utf8");
    const names = [...tools.matchAll(/name:\s*"(keelson_[a-z_]+)"/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(10);
    for (const n of names) expect(n, n).not.toMatch(/env|variable|secret/);
  });

  it("keeps the environment page behind the session: it is not one of the public paths", () => {
    for (const p of ["/servers/abc/apps/shop/environment", "/servers/abc/apps/shop/environment?scope=preview"]) expect(isPublic(p), p).toBe(false);
  });
});
