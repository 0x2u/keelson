import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AppStatus, ConfigDocument, Deployment, EnvScope } from "@/lib/agent-types";

// A fake agent for the environment variables: an HTTP server that keeps what the dashboard sets, in memory, the way the
// real one keeps it in files. It answers the routes the environment page and its actions use.

interface Stored {
  value: string;
  build: boolean;
  updated_at: string;
  shadows: "env_file" | "env" | null;
}

export interface FakeEnvAgentOptions {
  /** Answer every /env route with the plain 404 of an agent that has none. */
  old?: boolean;
  /** The previews: templates of the apps file. */
  previewApps?: string[];
  /** Fields of the app in the apps file (port, publish, stop_timeout). */
  appConfig?: Record<string, unknown>;
  deployments?: Deployment[];
  envChangedAt?: string;
  /** Names that the apps file already sets (the managed value then shadows them). */
  shadows?: Record<string, "env_file" | "env">;
  /** A message to answer the next PUT with as a 400, to see how a refusal is shown. */
  refuseWith?: { message: string; issues: { key: string; message: string }[] };
}

export class FakeEnvAgent {
  readonly scopes: Record<EnvScope, Map<string, Stored>> = { app: new Map(), preview: new Map() };
  /** Every request as "METHOD url", then its body. */
  readonly requests: { line: string; body: string }[] = [];
  /** The build variables kept per app name (the agent keeps them whether or not the app is in its apps file): names come out, never values. */
  readonly buildVars = new Map<
    string,
    Map<string, { value: string; changed_at: string }>
  >();
  opts: FakeEnvAgentOptions;
  private server: Server | null = null;
  url = "";
  private clock = Date.parse("2026-10-23T10:00:00Z");

  constructor(opts: FakeEnvAgentOptions = {}) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        this.requests.push({ line: `${req.method} ${req.url}`, body });
        const answer = this.handle(req.method ?? "", new URL(req.url ?? "/", "http://x"), body);
        res.writeHead(answer.status, { "Content-Type": answer.text === undefined ? "application/json" : "text/plain" });
        res.end(answer.text ?? JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** Adds a variable as if it had been set earlier. */
  seed(scope: EnvScope, key: string, value: string, over: Partial<Stored> = {}): void {
    this.scopes[scope].set(key, { value, build: false, updated_at: "2026-10-20T10:00:00Z", shadows: this.opts.shadows?.[key] ?? null, ...over });
  }

  private tick(): string {
    this.clock += 60_000;
    return new Date(this.clock).toISOString();
  }

  private app(): AppStatus {
    const changed = [...this.scopes.app.values(), ...this.scopes.preview.values()].map((v) => v.updated_at).sort().pop() ?? "";
    return {
      name: "shop",
      image: "registry.example.com/shop",
      project: "shop",
      environment: "production",
      digest: "",
      container: {
        id: "c1",
        name: "shop-1",
        image: "registry.example.com/shop:v1.2",
        created: "2026-10-21T10:00:00Z",
        tty: false,
        restart_count: 0,
        state: { status: "running", running: true, paused: false, restarting: false, oom_killed: false, exit_code: 0, started_at: "2026-10-21T10:00:00Z" },
        ports: [],
      },
      last_deployment: null,
      env_changed_at: this.opts.envChangedAt ?? changed,
    };
  }

  private config(): ConfigDocument {
    return {
      content: "",
      hash: "h",
      modified_at: "2026-10-20T00:00:00Z",
      applied_hash: "h",
      deprecations: [],
      model: {
        apps: [{ name: "shop", image: "registry.example.com/shop", ...(this.opts.previewApps?.includes("shop") ? { previews: { domain: "pr-{pr}-shop.example.com" } } : {}), ...this.opts.appConfig }],
      },
    };
  }

  private handle(method: string, url: URL, body: string): { status: number; body?: unknown; text?: string } {
    const path = url.pathname;
    if (path === "/v1/apps" && method === "GET")
      return { status: 200, body: [this.app()] };
    if (path === "/v1/deployments" && method === "GET")
      return { status: 200, body: this.opts.deployments ?? [] };
    if (path === "/v1/config" && method === "GET")
      return { status: 200, body: this.config() };
    const bv = /^\/v1\/build-vars\/([^/]+)$/.exec(path);
    if (bv)
      return this.buildVarsAnswer(method, decodeURIComponent(bv[1]), body);
    const m = /^\/v1\/apps\/([^/]+)\/env$/.exec(path);
    if (!m) return { status: 404, text: "404 page not found\n" };
    if (this.opts.old) return { status: 404, text: "404 page not found\n" };
    if (m[1] !== "shop") return { status: 404, body: { error: "not found" } };
    const scope = (url.searchParams.get("scope") ?? "app") as EnvScope;
    if (method === "GET") {
      const vars = [...this.scopes[scope]].map(([key, v]) => ({ key, updated_at: v.updated_at, build: v.build, shadows: v.shadows })).sort((a, b) => a.key.localeCompare(b.key));
      return { status: 200, body: { scope, vars, last_changed: vars.map((v) => v.updated_at).sort().pop() ?? null } };
    }
    if (method === "DELETE") {
      const removed = [...this.scopes[scope].keys()];
      this.scopes[scope].clear();
      return { status: 200, body: { scope, removed } };
    }
    if (method === "PUT") {
      const req = JSON.parse(body) as { scope?: EnvScope; set?: Record<string, string>; build?: string[]; unset?: string[] };
      if (this.opts.refuseWith) {
        const { message, issues } = this.opts.refuseWith;
        this.opts.refuseWith = undefined;
        return { status: 400, body: { error: "invalid", message, issues } };
      }
      const target = this.scopes[req.scope ?? "app"];
      const at = this.tick();
      const changed: string[] = [];
      const removed: string[] = [];
      for (const [key, value] of Object.entries(req.set ?? {})) {
        const before = target.get(key);
        if (before?.value === value) continue;
        target.set(key, { value, build: before?.build ?? false, updated_at: at, shadows: this.opts.shadows?.[key] ?? null });
        changed.push(key);
      }
      for (const key of req.unset ?? []) if (target.delete(key)) removed.push(key);
      if (req.build) for (const [key, v] of target) v.build = req.build.includes(key);
      return { status: 200, body: { scope: req.scope ?? "app", changed, removed } };
    }
    return { status: 405, body: { error: "method not allowed" } };
  }
  /** GET, PUT and DELETE of /v1/build-vars/{app}, as the real agent answers them. */
  private buildVarsAnswer(
    method: string,
    app: string,
    body: string,
  ): { status: number; body?: unknown; text?: string } {
    if (this.opts.old) return { status: 404, text: "404 page not found\n" };
    const vars =
      this.buildVars.get(app) ??
      new Map<string, { value: string; changed_at: string }>();
    this.buildVars.set(app, vars);
    if (method === "GET")
      return {
        status: 200,
        body: {
          names: [...vars]
            .map(([name, v]) => ({ name, changed_at: v.changed_at }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        },
      };
    if (method === "DELETE") {
      const removed = [...vars.keys()].sort();
      vars.clear();
      return { status: 200, body: { removed } };
    }
    if (method !== "PUT")
      return { status: 405, body: { error: "method not allowed" } };
    if (this.opts.refuseWith) {
      const { message, issues } = this.opts.refuseWith;
      this.opts.refuseWith = undefined;
      return { status: 400, body: { error: "invalid", message, issues } };
    }
    const req = JSON.parse(body) as {
      set?: Record<string, string>;
      remove?: string[];
    };
    const at = this.tick();
    const changed: string[] = [];
    const removed: string[] = [];
    for (const [name, value] of Object.entries(req.set ?? {})) {
      if (vars.get(name)?.value === value) continue;
      vars.set(name, { value, changed_at: at });
      changed.push(name);
    }
    for (const name of req.remove ?? [])
      if (vars.delete(name)) removed.push(name);
    return {
      status: 200,
      body: { changed: changed.sort(), removed: removed.sort() },
    };
  }
}
