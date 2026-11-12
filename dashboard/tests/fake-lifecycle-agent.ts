import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AppStatus, ConfigModel } from "@/lib/agent-types";

// A fake agent for the lifecycle of a project: it lists apps, serves its configuration document (the apps file's text, its
// hash and model) and takes the saves of the whole file (PUT /v1/config) and of one app, answering as the real one does
// for a stale hash (409 "changed") and for an invalid file (400 "invalid"). It records what it was asked.

export interface FakeLifecycleOptions {
  apps: Pick<AppStatus, "name" | "image" | "project" | "environment">[];
  content: string;
  model: ConfigModel;
  hash?: string;
  /** The answer of a save of the whole file when it is not simply accepted. */
  saveStatus?: { status: number; body: unknown };
  /** The agent has no apps file (404 on /v1/config). */
  noConfig?: boolean;
}

export class FakeLifecycleAgent {
  readonly requests: { line: string; body: string }[] = [];
  opts: FakeLifecycleOptions;
  private server: Server | null = null;
  url = "";

  constructor(opts: FakeLifecycleOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const line = `${req.method} ${req.url}`;
        this.requests.push({ line, body });
        const answer = this.handle(req.method ?? "", req.url ?? "/", body);
        res.writeHead(answer.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(answer.body));
      });
    });
    const listening = Promise.withResolvers<void>();
    this.server.listen(0, "127.0.0.1", () => listening.resolve());
    await listening.promise;
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    const closed = Promise.withResolvers<void>();
    if (this.server) this.server.close(() => closed.resolve());
    else closed.resolve();
    return closed.promise;
  }

  /** The requests that changed something, as "METHOD url". */
  writes(): { line: string; body: Record<string, unknown> }[] {
    return this.requests.filter((r) => r.line.startsWith("PUT ") || r.line.startsWith("DELETE ")).map((r) => ({ line: r.line, body: JSON.parse(r.body) as Record<string, unknown> }));
  }

  private handle(method: string, url: string, body: string): { status: number; body: unknown } {
    const hash = this.opts.hash ?? "h1";
    if (method === "GET" && url === "/v1/apps") {
      return { status: 200, body: this.opts.apps.map((a) => ({ digest: "", container: null, last_deployment: null, ...a })) };
    }
    if (method === "GET" && url === "/v1/jobs") return { status: 200, body: [] };
    if (method === "GET" && url === "/v1/config") {
      if (this.opts.noConfig) return { status: 404, body: { error: "not found" } };
      return { status: 200, body: { content: this.opts.content, hash, applied_hash: hash, modified_at: "2026-10-30T10:00:00Z", model: this.opts.model } };
    }
    if (method === "PUT" && (url === "/v1/config" || url.startsWith("/v1/config/apps/"))) {
      const req = JSON.parse(body) as { base_hash?: string };
      if (req.base_hash !== hash) return { status: 409, body: { error: "changed", hash } };
      if (this.opts.saveStatus) return this.opts.saveStatus;
      return { status: 200, body: { hash: "h2", version: 2, issues: [] } };
    }
    return { status: 404, body: { error: "not found" } };
  }
}
