// What scripts/capture-contract.sh does once its agent runs: deploys the one app that has no proxy (twice), asks the agent for what
// the dashboard reads, makes the answers the same on every machine and every run, and writes them as pretty-printed
// JSON with sorted keys, one file per request, to OUT_DIR.
//
//   node scripts/contract-capture.mjs URL TOKEN_FILE SECRET_FILE APPS_FILE WORK ADMIN_PORT OUT_DIR
import { createHash, createHmac } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

const [url, tokenFile, secretFile, appsFile, work, adminPort, outDir] = process.argv.slice(2);
const token = readFileSync(tokenFile, "utf8").trim();
const secret = readFileSync(secretFile, "utf8").trim();

const request = async (method, route, body) => {
  const headers = { "content-type": "application/json" };
  const payload = body === undefined ? "" : JSON.stringify(body);
  if (method === "GET") {
    headers.authorization = `Bearer ${token}`;
  } else {
    // What the dashboard sends for anything that changes or checks something: see agent/internal/api/signed.go.
    const ts = Math.floor(Date.now() / 1000);
    const digest = createHash("sha256").update(payload).digest("hex");
    headers["x-keelson-timestamp"] = String(ts);
    headers["x-keelson-signature"] = createHmac("sha256", secret).update(`${ts}\n${method}\n${route}\n${digest}`).digest("hex");
  }
  const res = await fetch(url + route, { method, headers, body: payload === "" ? undefined : payload });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${text}`);
  return JSON.parse(text);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- the one deployment -------------------------------------------------------------------------------------------

const deploy = async (app, tag, expected) => {
  const { deployment_id: id } = await request("POST", `/v1/apps/${app}/deploy`, { tag });
  for (let i = 0; i < 300; i++) {
    const latest = await request("GET", `/v1/deployments/${id}`);
    if (latest.status !== "running") {
      if (latest.status !== expected) throw new Error(`the deployment of ${app}:${tag} ${latest.status}, expected ${expected}: ${latest.error}`);
      return;
    }
    await sleep(100);
  }
  throw new Error(`the deployment of ${app}:${tag} did not end`);
};

// --- what the machine and the run decide ---------------------------------------------------------------------------

const paths = [...new Set([work, realpathSync(work)])];
// A time is one fixed instant, a valid one: the dashboard parses them, and tests read "now" relative to it.
const INSTANT = "2026-01-01T00:00:00Z";
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/;

const scrubString = (s) => {
  for (const p of paths) s = s.split(p).join("/work");
  s = s.replaceAll(`127.0.0.1:${adminPort}`, "127.0.0.1:2019");
  if (TIME.test(s)) return INSTANT;
  // Random per run: the SHA-256 of a file's content (its paths are the run's), the id of a deployment.
  if (/^[0-9a-f]{64}$/.test(s)) return "<hash>";
  if (/^[0-9a-f]{16}$/.test(s)) return "<id>";
  return s;
};

const scrub = (v) => {
  if (typeof v === "string") return scrubString(v);
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, scrub(v[k])]));
  return v;
};

// The host: a machine's name, its processors and its disk are its own.
const system = (doc) => {
  doc.host.hostname = "host";
  doc.host.cpus = 4;
  // The engine's directory when the account can read it (a CI runner), "/" when it cannot (a laptop): the same fact to the dashboard.
  doc.host.disk.path = "/";
  doc.host.disk.total = 100_000_000_000;
  doc.host.disk.free = 40_000_000_000;
  return doc;
};

const write = (name, doc, fix = (d) => d) => {
  writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(scrub(fix(doc)), null, 2) + "\n");
};

// --- the capture ---------------------------------------------------------------------------------------------------

mkdirSync(outDir, { recursive: true });
// One that works, then one that fails (the tag does not exist) while the first still serves.
await deploy("worker", "latest", "succeeded");
await deploy("worker", "missing", "failed");

for (const name of ["info", "config", "apps", "databases", "jobs", "system", "deployments", "proofs", "containers", "proxy", "projects"]) {
  write(name, await request("GET", `/v1/${name}`), name === "system" ? system : undefined);
}
write("project-blog-config", await request("GET", "/v1/projects/blog/config"));

// The file the agent runs, as the dashboard's editor sends it back for a check; and the same with a key that does not exist.
const content = readFileSync(appsFile, "utf8");
write("config-validate", await request("POST", "/v1/config/validate", { content }));
write("config-validate-invalid", await request("POST", "/v1/config/validate", { content: content + "colour: red\n" }));
