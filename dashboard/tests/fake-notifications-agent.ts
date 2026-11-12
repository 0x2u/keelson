import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ConfigIssue, NotificationsConfig, Proof } from "../lib/agent-types";

// A fake agent for the notification settings of one server: it answers GET /v1/config the way an agent does (the model's
// notifications section as written, with every secret URL shown as "<hidden>"), and PUT /v1/config/notifications with the
// agent's contract (a stale base_hash is a 409 "changed", a success stores the section, bumps the hash and answers
// {hash, version, issues}). It records every request, so a test can see what was sent and, above all, what was not.
// Self-contained (type imports only), like the readiness agent.

const HIDDEN = "<hidden>";

export interface FakeNotificationsOptions {
  /** The section as the agent reports it (secrets already "<hidden>"); absent: the file has no notifications section. */
  notifications?: NotificationsConfig;
  /** The hash of the file on disk now. */
  hash?: string;
  /** GET /v1/config answers 404, like an agent without an apps file. */
  readOnlyNoFile?: boolean;
  /** GET /v1/config answers 200 with `error`: the file on disk is invalid. */
  invalidFile?: boolean;
  /** Every request is cut off without an answer (the agent is up but the network is not). */
  unreachable?: boolean;
  proofs?: Proof[];
  /** A scripted answer of PUT /v1/config/notifications, given before anything else is checked. */
  save?: { status: number; body: unknown };
  /** What POST /v1/notifications/test answers. */
  alert?: { status: number; body: unknown };
}

export interface RecordedRequest {
  method: string;
  url: string;
  body: string;
  headers: IncomingHttpHeaders;
}

/** The section as GET /v1/config shows it: no webhook URL and no heartbeat URL, whatever was saved. */
function redacted(n: NotificationsConfig): NotificationsConfig {
  return {
    ...n,
    ...(n.webhooks ? { webhooks: n.webhooks.map((w) => ({ ...w, url: HIDDEN })) } : {}),
    ...(n.heartbeat ? { heartbeat: { ...n.heartbeat, url: HIDDEN } } : {}),
  };
}

export class FakeNotificationsAgent {
  readonly requests: RecordedRequest[] = [];
  opts: FakeNotificationsOptions;
  /** The section of the last accepted save, exactly as submitted (the URLs in it are the typed ones). */
  lastSaved: NotificationsConfig | null | undefined;
  /** The body of every PUT /v1/config/notifications, parsed. */
  readonly saves: { notifications: NotificationsConfig | null; base_hash?: string; comment?: string }[] = [];
  private server: Server | null = null;
  private stored: NotificationsConfig | undefined;
  private version = 0;
  url = "";

  constructor(opts: FakeNotificationsOptions = {}) {
    this.opts = { ...opts };
    this.stored = opts.notifications;
  }

  /** The hash of the file now. */
  get hash(): string {
    return this.opts.hash ?? "h1";
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        this.requests.push({ method: req.method ?? "", url: req.url ?? "/", body, headers: req.headers });
        if (this.opts.unreachable) {
          req.socket.destroy();
          return;
        }
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
    // A restart takes the port it had, so that a server registered with the url comes back.
    const port = this.url === "" ? 0 : Number(new URL(this.url).port);
    this.server.listen(port, "127.0.0.1", () => listening.resolve());
    await listening.promise;
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    const closed = Promise.withResolvers<void>();
    if (this.server) {
      this.server.close(() => closed.resolve());
      this.server.closeAllConnections();
    } else closed.resolve();
    return closed.promise;
  }

  /** The bodies of the requests made to a route ("PUT /v1/config/notifications"), as text. */
  rawBodies(line: string): string[] {
    return this.requests.filter((r) => `${r.method} ${r.url.split("?")[0]}` === line).map((r) => r.body);
  }

  /** The routes asked, in order ("GET /v1/config"). */
  routes(): string[] {
    return this.requests.map((r) => `${r.method} ${r.url.split("?")[0]}`);
  }

  private handle(method: string, url: string, body: string): { status: number; body: unknown } | null {
    const o = this.opts;
    const path = url.split("?")[0];
    if (method === "GET" && path === "/v1/info") return { status: 200, body: { version: "v1", read_only: false } };
    if (method === "GET" && path === "/v1/config") {
      if (o.readOnlyNoFile) return { status: 404, body: { error: "no apps file" } };
      const model = this.stored === undefined ? {} : { notifications: redacted(this.stored) };
      return {
        status: 200,
        body: {
          content: "",
          hash: this.hash,
          applied_hash: this.hash,
          modified_at: "2026-11-01T00:00:00Z",
          model,
          deprecations: [],
          ...(o.invalidFile ? { error: "apps.yml: line 3: invalid" } : {}),
        },
      };
    }
    if (method === "GET" && path === "/v1/proofs") return { status: 200, body: o.proofs ?? [] };
    if (method === "POST" && path === "/v1/notifications/test") return o.alert ?? { status: 200, body: { channels: [{ channel: "telegram", ok: true }] } };
    if (method === "PUT" && path === "/v1/config/notifications") return this.save(body);
    return { status: 404, body: { error: "not found" } };
  }

  private save(body: string): { status: number; body: unknown } {
    const parsed = JSON.parse(body) as { notifications: NotificationsConfig | null; base_hash?: string; comment?: string };
    this.saves.push(parsed);
    if (this.opts.save) return this.opts.save;
    if (parsed.base_hash !== this.hash) return { status: 409, body: { error: "changed", hash: this.hash } };
    this.stored = parsed.notifications ?? undefined;
    this.lastSaved = parsed.notifications;
    this.version++;
    this.opts.hash = `h${Number(this.hash.replace(/\D/g, "") || 0) + 1}`;
    const issues: ConfigIssue[] = [];
    return { status: 200, body: { hash: this.hash, version: this.version, issues } };
  }
}
