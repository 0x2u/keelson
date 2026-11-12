import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { KeelsonClient } from "../src/client.ts";
import { createServer } from "../src/server.ts";
import { TOKEN, type Fake } from "./fake.ts";

export interface Connected {
  client: Client;
  close(): Promise<void>;
}

/** The real MCP server wired to an SDK client in memory, talking HTTP to the fake dashboard. */
export async function connect(fake: Fake, timeoutMs = 2000): Promise<Connected> {
  const server = createServer(new KeelsonClient({ baseUrl: fake.url, token: TOKEN, timeoutMs }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, close: () => client.close() };
}

export function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return content.map((c) => c.text).join("\n");
}
