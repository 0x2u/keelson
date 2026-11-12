import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { KeelsonApiError, type KeelsonClient } from "./client.ts";
import { redact } from "./redact.ts";
import { INSTRUCTIONS, TOOLS } from "./tools.ts";
import { VERSION } from "./version.ts";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const text = (value: string, isError = false): ToolResult => ({
  content: [{ type: "text", text: value }],
  ...(isError ? { isError: true } : {}),
});

/** Turns whatever a tool threw into a message that is safe to show: mapped API errors as they are, anything else generic. */
export function errorText(err: unknown, token: string): string {
  if (err instanceof KeelsonApiError) return redact(err.message, token);
  if (err instanceof z.ZodError) return redact(`Invalid arguments: ${err.issues.map((i) => i.message).join("; ")}`, token);
  return "Internal error in keelson-mcp while handling the request.";
}

export function createServer(client: KeelsonClient): McpServer {
  const server = new McpServer({ name: "keelson", version: VERSION }, { instructions: INSTRUCTIONS });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.input, annotations: tool.annotations },
      async (args: unknown): Promise<ToolResult> => {
        try {
          return text(redact(await tool.run(args, client), client.token));
        } catch (err) {
          return text(errorText(err, client.token), true);
        }
      },
    );
  }
  return server;
}
