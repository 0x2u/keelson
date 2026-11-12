import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ConfigDocument, ConfigIssue, ProjectConfigDocument, SplitPlan } from "@/lib/agent-types";

// A fake agent for the per-project configuration: an HTTP server that answers the routes of the Configuration tab and its
// actions the way the real one is documented to (the dashboard contract of docs/per-project-yaml-design.md), and records
// what it was asked.

export interface FakeProjectAgentOptions {
  /** The 404 of an agent that has no per-project files, on every /v1/projects route. */
  old?: boolean;
  /** The project's own file; absent: the project has none. */
  file?: { project: string; content: string; hash: string; applied_hash?: string; apps?: string[]; jobs?: string[]; error?: string };
  /** What a split would do. */
  plan?: SplitPlan;
  /** A split refused with this message (400 invalid). */
  splitRefusal?: string;
  /** The hash of the whole configuration, the base of a split. */
  configHash?: string;
}

export class FakeProjectAgent {
  /** Every request as "METHOD url", then its body. */
  readonly requests: { line: string; body: string }[] = [];
  opts: FakeProjectAgentOptions;
  private server: Server | null = null;
  url = "";

  constructor(opts: FakeProjectAgentOptions = {}) {
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

  /** The bodies of the requests that matched, parsed. */
  bodies(line: string): Record<string, unknown>[] {
    return this.requests.filter((r) => r.line === line).map((r) => JSON.parse(r.body) as Record<string, unknown>);
  }

  private doc(): ProjectConfigDocument {
    const f = this.opts.file!;
    return {
      project: f.project,
      path: `projects.d/${f.project}.yaml`,
      content: f.content,
      hash: f.hash,
      applied_hash: f.applied_hash ?? f.hash,
      config_hash: this.opts.configHash ?? "bundle-hash",
      modified_at: "2026-10-30T10:00:00Z",
      model: {
        apps: (f.apps ?? []).map((name) => ({ name, image: "x" })),
        jobs: (f.jobs ?? []).map((name) => ({ name, schedule: "* * * * *" })),
      },
      ...(f.error === undefined ? {} : { error: f.error }),
    };
  }

  private config(): ConfigDocument {
    return { content: "", hash: this.opts.configHash ?? "bundle-hash", applied_hash: this.opts.configHash ?? "bundle-hash", modified_at: "2026-10-30T10:00:00Z", model: {}, deprecations: [] };
  }

  private handle(method: string, url: URL, body: string): { status: number; body?: unknown; text?: string } {
    const path = url.pathname;
    if (path === "/v1/config" && method === "GET") return { status: 200, body: this.config() };
    if (!path.startsWith("/v1/projects")) return { status: 404, text: "404 page not found\n" };
    if (this.opts.old) return { status: 404, text: "404 page not found\n" };
    if (path === "/v1/projects" && method === "GET") {
      const f = this.opts.file;
      return {
        status: 200,
        body: f
          ? [{ name: f.project, path: `projects.d/${f.project}.yaml`, hash: f.hash, applied_hash: f.applied_hash ?? f.hash, modified_at: "2026-10-30T10:00:00Z", apps: (f.apps ?? []).length, jobs: (f.jobs ?? []).length, databases: 0, previews: 0 }]
          : [],
      };
    }
    const m = /^\/v1\/projects\/([^/]+)\/(config\/validate|config|split)$/.exec(path);
    if (!m) return { status: 404, body: { error: "not found" } };
    const [, name, route] = m;
    const file = this.opts.file;
    const req = body === "" ? {} : (JSON.parse(body) as { content?: string; base_hash?: string; force?: boolean; dry_run?: boolean });

    if (route === "config" && method === "GET") return file && file.project === name ? { status: 200, body: this.doc() } : { status: 404, body: { error: "not found" } };

    if (route === "config/validate") {
      const issues: ConfigIssue[] = (req.content ?? "").includes("BAD")
        ? [{ severity: "error", path: "apps[web]", line: 3, message: "unknown key", file: `projects.d/${name}.yaml`, project: name }]
        : [];
      return { status: 200, body: { ok: issues.length === 0, issues } };
    }

    if (route === "config" && method === "PUT") {
      if (file && req.base_hash !== undefined && req.base_hash !== file.hash) return { status: 409, body: { error: "changed", hash: file.hash } };
      if ((req.content ?? "").includes("BAD")) {
        return { status: 400, body: { error: "invalid", issues: [{ severity: "error", path: "apps[web]", line: 3, message: "unknown key", file: `projects.d/${name}.yaml`, project: name }] } };
      }
      if ((req.content ?? "").includes("DROP") && !req.force) {
        return { status: 409, body: { error: "needs_acknowledgement", issues: [{ severity: "warning", path: "apps[web]", message: "app web is removed", code: "app_removed", file: `projects.d/${name}.yaml`, project: name }] } };
      }
      return { status: 200, body: { hash: "new-file-hash", config_hash: "new-bundle-hash", version: 7, issues: [] } };
    }

    if (route === "config" && method === "DELETE") {
      if (!file || file.project !== name) return { status: 404, body: { error: "not found" } };
      if (req.base_hash !== undefined && req.base_hash !== file.hash) return { status: 409, body: { error: "changed", hash: file.hash } };
      if ((file.apps ?? []).length > 0 && !req.force) {
        return { status: 409, body: { error: "needs_acknowledgement", issues: (file.apps ?? []).map((a) => ({ severity: "warning", path: `apps[${a}]`, message: `app ${a} is removed`, code: "app_removed" })) } };
      }
      return { status: 200, body: { hash: "", config_hash: "after-delete", version: 8, issues: [] } };
    }

    if (route === "split" && method === "POST") {
      if (this.opts.splitRefusal !== undefined) return { status: 400, body: { error: "invalid", message: this.opts.splitRefusal } };
      const plan = this.opts.plan ?? { project: name, file: `projects.d/${name}.yaml`, apps: [], jobs: [], databases: [], previews: [], kept: [] };
      const hash = this.opts.configHash ?? "bundle-hash";
      if (req.base_hash !== undefined && req.base_hash !== hash) return { status: 409, body: { error: "changed", hash } };
      if (req.dry_run) return { status: 200, body: { dry_run: true, hash, plan } };
      return { status: 200, body: { dry_run: false, hash: "split-bundle-hash", file_hash: "split-file-hash", version: 9, issues: [], plan } };
    }
    return { status: 405, body: { error: "method not allowed" } };
  }
}
