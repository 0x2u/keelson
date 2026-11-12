import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { KeelsonApiError, KeelsonClient } from "./client.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { redact } from "./redact.ts";
import { createServer } from "./server.ts";
import { VERSION } from "./version.ts";

export interface Io {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const USAGE = `keelson-mcp ${VERSION}: MCP server (stdio) for Keelson, a client of the dashboard API v1.

Usage: keelson-mcp [--check | --help | --version]

Environment:
  KEELSON_URL    dashboard address (https required, http only for localhost)
  KEELSON_TOKEN  API token from the dashboard's API tokens page (kst_...)

  --check        call GET /api/v1/servers and print OK or the error, to test the token`;

/** Returns the exit code, or "serve" when the MCP server was started on stdio and keeps running. */
export async function main(argv: string[], env: Record<string, string | undefined>, io: Io): Promise<number | "serve"> {
  const flags = argv.filter((a) => a.startsWith("-"));
  const known = new Set(["--check", "--help", "-h", "--version", "-v"]);
  if (flags.some((f) => !known.has(f)) || argv.length > flags.length || flags.length > 1) {
    io.stderr(`keelson-mcp: unknown argument.\n${USAGE}`);
    return 2;
  }
  const flag = flags[0];
  if (flag === "--help" || flag === "-h") {
    io.stdout(USAGE);
    return 0;
  }
  if (flag === "--version" || flag === "-v") {
    io.stdout(VERSION);
    return 0;
  }

  let client: KeelsonClient;
  try {
    client = new KeelsonClient(loadConfig(env));
  } catch (err) {
    if (err instanceof ConfigError) {
      io.stderr(`keelson-mcp: ${redact(err.message, env.KEELSON_TOKEN)}`);
      return 2;
    }
    throw err;
  }

  if (flag === "--check") {
    try {
      const body = await client.get("/api/v1/servers");
      const servers = body && typeof body === "object" && "servers" in body && Array.isArray(body.servers) ? body.servers : undefined;
      if (!servers) throw new KeelsonApiError("Unexpected response from Keelson: no server list.");
      const deploy = servers.filter((s) => s && typeof s === "object" && "can_deploy" in s && s.can_deploy === true).length;
      io.stdout(`OK: ${client.origin} accepts the token; it sees ${servers.length} server(s), ${deploy} where it can deploy.`);
      return 0;
    } catch (err) {
      const message = err instanceof KeelsonApiError ? err.message : "Unexpected error while checking the token.";
      io.stderr(`Error: ${redact(message, client.token)}`);
      return 1;
    }
  }

  await createServer(client).connect(new StdioServerTransport());
  return "serve";
}
