import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const TOKEN = "kst_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";

export interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface Reply {
  status?: number;
  body?: unknown;
  /** A raw body, sent as is (to test non-JSON answers). */
  raw?: string;
  headers?: Record<string, string>;
  /** Wait this long before answering. */
  delayMs?: number;
}

export interface Fake {
  url: string;
  requests: Recorded[];
  /** Answers `METHOD /path` (query ignored). Unregistered routes answer 404. */
  on(route: string, reply: Reply | ((req: Recorded) => Reply)): void;
  close(): Promise<void>;
}

/** An in-process dashboard that implements the contract's authentication: Bearer token, 401 for anything else. */
export async function startFake(options: { token?: string } = {}): Promise<Fake> {
  const token = options.token ?? TOKEN;
  const requests: Recorded[] = [];
  const routes = new Map<string, Reply | ((req: Recorded) => Reply)>();

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake");
      const recorded: Recorded = {
        method: req.method ?? "",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(recorded);
      let reply: Reply;
      if (req.headers.authorization !== `Bearer ${token}`) {
        reply = { status: 401, body: { error: "unauthorized" } };
      } else {
        const route = routes.get(`${recorded.method} ${recorded.path}`);
        reply = route === undefined ? { status: 404, body: { error: "not found" } } : typeof route === "function" ? route(recorded) : route;
      }
      const send = () => {
        res.writeHead(reply.status ?? 200, { "content-type": "application/json", "cache-control": "no-store", ...reply.headers });
        res.end(reply.raw ?? JSON.stringify(reply.body ?? {}));
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    on: (route, reply) => void routes.set(route, reply),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
