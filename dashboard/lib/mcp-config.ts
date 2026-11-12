/** The block to paste into an MCP client (Claude Desktop, Claude Code, Cursor...) to connect the Keelson MCP server with a token. */
export function mcpConfig(url: string, token: string): string {
  return JSON.stringify(
    { mcpServers: { keelson: { command: "node", args: ["/path/to/keelson/mcp/dist/index.js"], env: { KEELSON_URL: url, KEELSON_TOKEN: token } } } },
    null,
    2,
  );
}
