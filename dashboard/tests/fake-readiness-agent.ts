import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AppStatus, ConfigModel, DatabaseBackup, DatabaseStatus, Deployment, Proof, RestoreTest } from "../lib/agent-types";

// A fake agent for the readiness checklist: it answers what the dashboard reads (info, apps, databases, configuration,
// deployments, backups) and speaks the new routes (proofs, key proof, restore test, test alert) as the contract says. It
// records every request, so a test can see what was sent and, above all, what was not. Self-contained (type imports only) so
// a plain node script can run it as well.

export interface FakeReadinessOptions {
  version?: string;
  apps?: AppStatus[];
  databases?: DatabaseStatus[];
  model?: ConfigModel;
  backups?: Record<string, DatabaseBackup[]>;
  deployments?: Record<string, Deployment[]>;
  proofs?: Proof[];
  tests?: Record<string, RestoreTest[]>;
  /** The agent is older than the routes: they answer a plain-text 404, like an unknown path of Go's mux. */
  old?: boolean;
  /** What POST verify-key answers. */
  verify?: { status: number; body: unknown };
  /** What POST notifications/test answers. */
  alert?: { status: number; body: unknown };
  /** What POST restore-test answers; the default is 202 with a test id. */
  startTest?: { status: number; body: unknown };
  /** How many reads of the test list say "running" before the test ends (0: already over). */
  runningReads?: number;
  /** How the started test ends. */
  outcome?: Pick<RestoreTest, "status" | "error" | "tables">;
}

export class FakeReadinessAgent {
  readonly requests: { method: string; url: string; body: string }[] = [];
  opts: FakeReadinessOptions;
  private server: Server | null = null;
  private reads = 0;
  private started: RestoreTest | null = null;
  url = "";

  constructor(opts: FakeReadinessOptions = {}) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        this.requests.push({ method: req.method ?? "", url: req.url ?? "/", body });
        const answer = this.handle(req.method ?? "", req.url ?? "/", body);
        if (answer === null) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("404 page not found\n");
          return;
        }
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

  /** The bodies of the requests made to a route ("POST /v1/notifications/test"), parsed. */
  bodies(line: string): unknown[] {
    return this.requests.filter((r) => `${r.method} ${r.url.split("?")[0]}` === line).map((r) => (r.body === "" ? null : (JSON.parse(r.body) as unknown)));
  }

  private tests(db: string): RestoreTest[] {
    const listed = this.opts.tests?.[db] ?? [];
    if (!this.started) return listed;
    this.reads++;
    const running = this.reads <= (this.opts.runningReads ?? 0);
    const outcome = this.opts.outcome ?? { status: "passed" as const, tables: [{ name: "public.products", backup_rows: 3, live_rows: 5 }] };
    const test: RestoreTest = running
      ? { ...this.started, status: "running", tables: null }
      : { ...this.started, finished_at: "2026-11-02T10:00:09Z", status: outcome.status, ...(outcome.error ? { error: outcome.error } : {}), tables: outcome.tables };
    return [test, ...listed];
  }

  private handle(method: string, url: string, body: string): { status: number; body: unknown } | null {
    const o = this.opts;
    const path = url.split("?")[0];
    const db = /^\/v1\/databases\/([^/]+)\/(.+)$/.exec(path);
    if (method === "GET" && path === "/v1/info") return { status: 200, body: { version: o.version ?? "v1", read_only: false } };
    if (method === "GET" && path === "/v1/containers") return { status: 200, body: [] };
    if (method === "GET" && path === "/v1/apps") return { status: 200, body: o.apps ?? [] };
    if (method === "GET" && path === "/v1/jobs") return { status: 200, body: [] };
    if (method === "GET" && path === "/v1/databases") return { status: 200, body: o.databases ?? [] };
    if (method === "GET" && path === "/v1/config") {
      const model = o.model ?? {};
      return { status: 200, body: { content: "", hash: "h", applied_hash: "h", modified_at: "2026-11-01T00:00:00Z", model } };
    }
    if (method === "GET" && path === "/v1/deployments") {
      const app = new URL(url, "http://x").searchParams.get("app") ?? "";
      return { status: 200, body: o.deployments?.[app] ?? [] };
    }
    if (method === "GET" && db?.[2] === "backups") return { status: 200, body: o.backups?.[decodeURIComponent(db[1])] ?? [] };
    if (o.old) return null;
    if (method === "GET" && path === "/v1/proofs") return { status: 200, body: o.proofs ?? [] };
    if (method === "GET" && db?.[2] === "restore-tests") return { status: 200, body: this.tests(decodeURIComponent(db[1])) };
    if (method === "POST" && db?.[2] === "verify-key") return o.verify ?? { status: 200, body: { ok: true, backup: "k1", backup_time: "2026-11-02T03:00:00Z" } };
    if (method === "POST" && db?.[2] === "restore-test") {
      const answer = o.startTest ?? { status: 202, body: { test_id: "t1" } };
      if (answer.status === 202) {
        const req = JSON.parse(body) as { backup?: string };
        this.reads = 0;
        this.started = { id: "t1", backup: req.backup ?? "k1", backup_time: "2026-11-02T03:00:00Z", started_at: "2026-11-02T10:00:00Z", status: "running", tables: null };
      }
      return answer;
    }
    if (method === "POST" && path === "/v1/notifications/test") return o.alert ?? { status: 200, body: { channels: [{ channel: "telegram", ok: true }] } };
    return { status: 404, body: { error: "not found" } };
  }
}
