// A Docker engine for scripts/capture-contract.sh, on a unix socket: the part of the Engine API that an agent with an apps
// file touches while it runs, deploys an app without a proxy and answers its read endpoints. It runs nothing and pulls
// nothing: a container exists in memory from `create` until `remove`, an image is "pulled" the moment it is asked for.
// What the agent sends back to the dashboard is still its own code's doing; this only gives it an engine to ask.
//
//   node scripts/contract-engine.mjs SOCKET [LOG]
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import http from "node:http";

const [socket, log] = process.argv.slice(2);
const AT = "2026-01-01T00:00:00.000000000Z";
const sha = (s) => createHash("sha256").update(s).digest("hex");

const containers = new Map(); // name -> container
const images = new Map(); // reference -> image id
const networks = new Set(["bridge", "host", "none"]);

const imageId = (ref) => {
  if (!images.has(ref)) images.set(ref, "sha256:" + sha("image:" + ref));
  return images.get(ref);
};
const ports = (c) => {
  const out = {};
  for (const [port, binds] of Object.entries(c.HostConfig.PortBindings ?? {})) {
    out[port] = (binds ?? []).map((b) => ({ HostIp: b.HostIp || "0.0.0.0", HostPort: b.HostPort || "49153" }));
  }
  return out;
};
const inspect = (c) => ({
  Id: c.Id,
  Name: "/" + c.Name,
  Image: imageId(c.Config.Image),
  Created: AT,
  RestartCount: 0,
  State: c.running
    ? { Status: "running", Running: true, Paused: false, Restarting: false, OOMKilled: false, ExitCode: 0, StartedAt: AT, FinishedAt: "0001-01-01T00:00:00Z" }
    : { Status: "created", Running: false, Paused: false, Restarting: false, OOMKilled: false, ExitCode: 0, StartedAt: "0001-01-01T00:00:00Z", FinishedAt: "0001-01-01T00:00:00Z" },
  Config: c.Config,
  HostConfig: c.HostConfig,
  NetworkSettings: { Ports: c.running ? ports(c) : {}, Networks: { [c.HostConfig.NetworkMode || "bridge"]: {} } },
  Mounts: [],
});
const summary = (c) => ({
  Id: c.Id,
  Names: ["/" + c.Name],
  Image: c.Config.Image,
  ImageID: imageId(c.Config.Image),
  Command: (c.Config.Cmd ?? []).join(" "),
  Created: Date.parse(AT) / 1000,
  State: c.running ? "running" : "created",
  Status: c.running ? "Up 1 second" : "Created",
  Labels: c.Config.Labels ?? {},
  Ports: Object.entries(ports(c)).flatMap(([p, binds]) =>
    binds.map((b) => ({ IP: b.HostIp, PrivatePort: Number(p.split("/")[0]), PublicPort: Number(b.HostPort), Type: p.split("/")[1] ?? "tcp" })),
  ),
});
const labelFilter = (filters) => {
  const want = (JSON.parse(filters || "{}").label ?? []).map((l) => l.split("="));
  return (c) => want.every(([k, v]) => (v === undefined ? k in (c.Config.Labels ?? {}) : (c.Config.Labels ?? {})[k] === v));
};

const engine = (method, path, query, body) => {
  if (path === "/_ping") return ["text", "OK"];
  if (path === "/info") {
    return [200, {
      Name: "contract-engine", ServerVersion: "28.0.0", OperatingSystem: "Contract Linux", OSType: "linux", Architecture: "x86_64",
      NCPU: 4, MemTotal: 8 * 2 ** 30, DockerRootDir: "/var/lib/docker", Containers: containers.size,
      ContainersRunning: [...containers.values()].filter((c) => c.running).length, Images: 3,
    }];
  }
  if (path === "/containers/json") {
    const keep = labelFilter(query.get("filters"));
    const all = query.get("all") === "1" || query.get("all") === "true";
    return [200, [...containers.values()].filter((c) => (all || c.running) && keep(c)).map(summary)];
  }
  if (path === "/containers/create" && method === "POST") {
    const name = query.get("name");
    if (containers.has(name)) return [409, { message: "Conflict. The container name is already in use" }];
    const c = { ...body, Name: name, Id: sha("container:" + name), running: false };
    c.HostConfig ??= {};
    c.Config = { ...body, HostConfig: undefined };
    containers.set(name, c);
    return [201, { Id: c.Id, Warnings: [] }];
  }
  let m = path.match(/^\/containers\/([^/]+)(?:\/(\w+))?$/);
  if (m) {
    const c = [...containers.values()].find((x) => x.Name === m[1] || x.Id === m[1]);
    if (!c) return [404, { message: "No such container: " + m[1] }];
    const act = m[2] ?? "";
    if (method === "GET" && act === "json") return [200, inspect(c)];
    if (method === "POST" && act === "start") { c.running = true; return [204]; }
    if (method === "POST" && ["stop", "kill"].includes(act)) { c.running = false; return [204]; }
    if (method === "POST" && act === "restart") { c.running = true; return [204]; }
    if (method === "DELETE" && act === "") { containers.delete(c.Name); return [204]; }
    if (method === "POST" && act === "wait") return [200, { StatusCode: 0 }];
  }
  if (path === "/images/create" && method === "POST") {
    // A tag that does not exist, as a registry answers for it: the pull, and so the deployment, fails.
    if (query.get("tag") === "missing") return [404, { message: `manifest for ${query.get("fromImage")}:missing not found: manifest unknown: manifest unknown` }];
    imageId(`${query.get("fromImage")}:${query.get("tag") || "latest"}`);
    return [200, { status: "Status: Image is up to date" }];
  }
  if (path === "/images/json") return [200, []];
  m = path.match(/^\/images\/(.+)\/json$/);
  if (m) {
    const ref = decodeURIComponent(m[1]);
    const key = [...images.keys()].find((k) => k === ref || k.startsWith(ref + ":") || images.get(k) === ref);
    if (!key) return [404, { message: "No such image: " + ref }];
    const name = key.replace(/:[^:/]*$/, "");
    return [200, {
      Id: images.get(key), RepoTags: [key], RepoDigests: [name + "@sha256:" + sha("digest:" + key)], Architecture: "amd64", Os: "linux", Size: 1 << 20,
      Config: { Env: [], ExposedPorts: {}, Labels: {} },
    }];
  }
  m = path.match(/^\/networks\/([^/]+)$/);
  if (m && method === "GET") return networks.has(m[1]) ? [200, { Name: m[1], Id: sha("network:" + m[1]) }] : [404, { message: "network " + m[1] + " not found" }];
  if (path === "/networks/create" && method === "POST") { networks.add(body.Name); return [201, { Id: sha("network:" + body.Name) }]; }
  // Volumes are not served, which is what keeps the managed PostgreSQL down: no container of it ever exists, so what
  // the capture reads does not depend on how far it got.
  if (path.startsWith("/volumes/") && method === "GET") return [404, { message: "get " + path + ": no such volume" }];
  return [404, { message: "contract engine: " + method + " " + path + " is not served" }];
};

http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      const url = new URL(req.url, "http://engine");
      const raw = Buffer.concat(chunks).toString();
      let body;
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
      const [status, payload] = engine(req.method, url.pathname.replace(/^\/v[\d.]+(?=\/)/, ""), url.searchParams, body);
      if (log) appendFileSync(log, `${req.method} ${req.url} -> ${status}\n`);
      if (status === "text") {
        res.writeHead(200, { "content-type": "text/plain" }).end(payload);
        return;
      }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(payload === undefined ? undefined : JSON.stringify(payload));
    });
  })
  .listen(socket);
