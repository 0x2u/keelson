// Runtime checks of what the dashboard cannot afford to misread in the agent's answers. lib/agent-types.ts says what the
// dashboard expects; these say whether an answer has it, so that an agent that renamed a key (databases `backup` →
// `backups`, `host_ports` → `port.host`) is caught where the key is read instead of showing as an empty page.
//
// Each check returns the problems it found, one line each, naming the path of the key: [] means the answer is as expected.
// Keys the dashboard does not read are not looked at, except the legacy spellings of schema v1, which are reported by
// name. tests/contract runs every check on what a real agent answered (contract/agent) and in development lib/agent.ts
// warns with the first problem. No dependency: the answers are plain JSON.

type Problems = string[];

/** One expectation: pushes a line to `out` for each way `value`, found at `at`, is not as expected. */
interface Check {
  (value: unknown, at: string, out: Problems): void;
  /** A key that may be absent. */
  optional?: true;
}

const kind = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "an array" : typeof v === "object" ? "an object" : `a ${typeof v}`);

const primitive =
  (type: "string" | "number" | "boolean"): Check =>
  (v, at, out) => {
    if (typeof v !== type) out.push(`${at}: expected a ${type}, got ${kind(v)}`);
  };

const str = primitive("string");
const num = primitive("number");
const bool = primitive("boolean");

const oneOf =
  (...values: string[]): Check =>
  (v, at, out) => {
    if (typeof v !== "string" || !values.includes(v)) out.push(`${at}: expected one of ${values.join(", ")}, got ${JSON.stringify(v)}`);
  };

/** The value may be absent (a key the agent leaves out when it is empty). */
const opt = (check: Check): Check => Object.assign((v: unknown, at: string, out: Problems) => (v === undefined ? undefined : check(v, at, out)), { optional: true as const });

/** The value may be null. */
const nullable =
  (check: Check): Check =>
  (v, at, out) => {
    if (v !== null) check(v, at, out);
  };

const orElse =
  (...checks: Check[]): Check =>
  (v, at, out) => {
    const attempts = checks.map((check) => {
      const found: Problems = [];
      check(v, at, found);
      return found;
    });
    if (attempts.every((found) => found.length > 0)) out.push(`${at}: expected ${checks.length === 2 ? "either of two shapes" : "one of the shapes"}, got ${kind(v)}`);
  };

const list =
  (check: Check): Check =>
  (v, at, out) => {
    if (!Array.isArray(v)) {
      out.push(`${at}: expected an array, got ${kind(v)}`);
      return;
    }
    v.forEach((item, i) => check(item, `${at}[${i}]`, out));
  };

const dict =
  (check: Check): Check =>
  (v, at, out) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      out.push(`${at}: expected an object, got ${kind(v)}`);
      return;
    }
    for (const [k, item] of Object.entries(v)) check(item, `${at}.${k}`, out);
  };

/**
 * An object with these keys. `retired` names spellings the agent no longer sends (key → what the dashboard reads
 * instead): finding one means the agent speaks another schema than this dashboard.
 */
const shape =
  (fields: Record<string, Check>, retired: Record<string, string> = {}): Check =>
  (v, at, out) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      out.push(`${at}: expected an object, got ${kind(v)}`);
      return;
    }
    const o = v as Record<string, unknown>;
    for (const [key, check] of Object.entries(fields)) {
      if (!(key in o) && !check.optional) out.push(`${at}.${key}: missing`);
      else check(o[key], `${at}.${key}`, out);
    }
    for (const [key, instead] of Object.entries(retired)) if (key in o) out.push(`${at}.${key}: a legacy key; the dashboard reads ${instead}`);
  };

const strings = list(str);

// ---- Containers and deployments -----------------------------------------------------------------------------------------

const port = shape({ private_port: num, type: str, ip: opt(str), public_port: opt(num) });

const containerDetail = shape({
  id: str,
  name: str,
  image: str,
  created: str,
  tty: bool,
  restart_count: num,
  state: shape({ status: str, running: bool, paused: bool, restarting: bool, oom_killed: bool, exit_code: num, started_at: opt(str), finished_at: opt(str), health: opt(str) }),
  ports: nullable(list(port)),
});

const deployment = shape({
  id: str,
  app: str,
  ref: str,
  status: oneOf("running", "succeeded", "failed", "rolled_back", "rollback_failed"),
  trigger: str,
  started_at: str,
  previous_ref: opt(str),
  error: opt(str),
  finished_at: opt(str),
  serving_ref: opt(str),
  phases: opt(list(shape({ name: oneOf("source", "build", "release", "switch", "soak", "live"), status: oneOf("running", "done", "failed", "skipped"), started_at: str, finished_at: opt(str) }))),
});

const container = shape({ id: str, name: str, image: str, image_id: str, command: str, created: num, state: str, status: str, labels: dict(str), ports: list(port) });

// ---- Apps, jobs, databases, system ----------------------------------------------------------------------------------------

const app = shape({
  name: str,
  image: str,
  project: str,
  environment: str,
  digest: str,
  container: nullable(containerDetail),
  last_deployment: nullable(deployment),
  env_changed_at: opt(str),
  domains: opt(strings),
});

const jobRun = shape({ id: str, job: str, trigger: oneOf("schedule", "manual", "catch-up"), status: oneOf("running", "succeeded", "failed", "skipped", "missed"), started_at: str, detail: opt(str), output: opt(str), finished_at: opt(str) });

const job = shape({
  name: str,
  schedule: str,
  timezone: str,
  kind: oneOf("http", "host", "container", "backup"),
  target: str,
  paused: bool,
  running: bool,
  project: opt(str),
  next_run: opt(str),
  last_run: opt(jobRun),
});

const databaseBackupStatus = shape({
  schedule: str,
  timezone: str,
  keep: num,
  keep_days: num,
  paused: bool,
  destination: str,
  recipients: num,
  job: str,
  next_run: nullable(str),
  last_run: nullable(shape({ id: str, status: oneOf("running", "succeeded", "failed", "skipped", "missed"), started_at: str, finished_at: opt(nullable(str)), detail: opt(str) })),
});

const database = shape({
  name: str,
  engine: str,
  host: str,
  port: num,
  database: str,
  user: str,
  version: num,
  network: str,
  has_password: bool,
  backup: nullable(databaseBackupStatus),
  managed: opt(bool),
  app: opt(str),
  env_key: opt(str),
  project: opt(str),
});

const buildLimits = shape({ memory: num, cpus: num, timeout_seconds: num, max_source: num, source_hosts: strings, host_network: bool, keep_images: num });

const system = shape({
  time: str,
  host: shape({
    cpus: num,
    hostname: opt(str),
    uptime_seconds: opt(num),
    load: opt(shape({ one: num, five: num, fifteen: num })),
    memory: opt(shape({ total: num, available: num, swap_total: num, swap_free: num })),
    disk: opt(shape({ path: str, total: num, free: num })),
  }),
  engine: opt(shape({ name: str, version: str, os: str, cpus: num, mem_total: num, root_dir: str, containers: num, running: num, images: num })),
  engine_error: opt(str),
  os: opt(str),
  arch: opt(str),
  build: opt(shape({ enabled: bool, limits: buildLimits })),
});

const proof = shape({ kind: oneOf("key", "alert", "restore"), subject: str, at: str });

const proxyView = shape({
  type: oneOf("caddy", "nginx"),
  where: str,
  generated: str,
  config: opt(str),
  in_sync: opt(bool),
  live_error: opt(str),
  routes: list(
    shape({
      kind: oneOf("app", "site"),
      app: str,
      domains: strings,
      upstream: str,
      container: str,
      ref: str,
      updated_at: str,
      running: bool,
      site_kind: opt(oneOf("static", "upstream", "redirect")),
      target: opt(str),
      upstream_name: opt(str),
    }),
  ),
  unrouted: list(shape({ app: str, domains: strings, reason: str })),
});

// ---- The configuration ----------------------------------------------------------------------------------------------------

const configIssue = shape({ severity: oneOf("error", "warning"), path: str, message: str, line: opt(num), code: opt(str), file: opt(str), project: opt(str) });

const portConfig = orElse(num, shape({ container: opt(num), host: opt(list(num)), env: opt(str) }));

const durations = str;

const releaseStep = shape(
  {
    name: str,
    host: opt(strings),
    dir: opt(str),
    container: opt(shape({ command: opt(strings), image: opt(str) })),
    backup: opt(str),
    timeout: opt(durations),
    continue_on_failure: opt(bool),
  },
  { run: "host" },
);

const backupDestination = shape({
  local: opt(shape({ dir: str })),
  s3: opt(shape({ endpoint: str, region: str, bucket: str, access_key_id: str, secret_key_file: str, prefix: opt(str) })),
});

const backups = shape({
  schedule: str,
  recipients: strings,
  destinations: list(backupDestination),
  timezone: opt(str),
  keep: opt(num),
  keep_days: opt(num),
  keep_pre_deploy: opt(num),
  timeout: opt(durations),
  alert_after: opt(num),
  paused: opt(bool),
});

const appConfig = shape(
  {
    name: str,
    image: str,
    project: opt(str),
    environment: opt(str),
    env_file: opt(str),
    env: opt(dict(str)),
    publish: opt(strings),
    volumes: opt(strings),
    network: opt(str),
    restart: opt(str),
    command: opt(strings),
    stop_timeout: opt(durations),
    health_timeout: opt(durations),
    stable_after: opt(durations),
    drain: opt(durations),
    soak: opt(durations),
    verify: opt(list(shape({ path: str, status: opt(num) }))),
    domains: opt(strings),
    port: opt(portConfig),
    health_path: opt(str),
    release: opt(shape({ steps: list(releaseStep), on_rollback: opt(bool) })),
    log: opt(shape({ driver: opt(str), max_size: opt(str), max_file: opt(num) })),
    keep_images: opt(num),
    build: opt(
      shape({
        preset: opt(oneOf("nextjs", "node", "vite", "static")),
        install: opt(str),
        build_command: opt(str),
        start: opt(str),
        output_dir: opt(str),
        node: opt(orElse(str, num)),
        spa: opt(bool),
        standalone: opt(bool),
        dockerfile: opt(str),
        context: opt(str),
        target: opt(str),
        args: opt(dict(str)),
        timeout: opt(durations),
        memory: opt(str),
        cpus: opt(num),
        network: opt(str),
        database: opt(bool),
        platform: opt(str),
        max_source: opt(str),
        source_hosts: opt(strings),
      }),
    ),
    previews: opt(shape({ domain: str, env_file: opt(str), env: opt(dict(str)), ttl: opt(durations), max: opt(num) })),
    database: opt(shape({ name: opt(str), env_key: opt(str), password_file: opt(str), backups: opt(backups) }, { backup: "backups" })),
    source: opt(shape({ repo: str, branch: opt(str), deploy_on: opt(str), workflow: opt(str), previews_workflow: opt(str), build_on: opt(strings), build_server: opt(str) })),
    deploy: opt(shape({ strategy: opt(oneOf("switch", "replace")) })),
  },
  { ports: "publish", host_ports: "port.host", port_env: "port.env" },
);

const jobConfig = shape(
  {
    name: str,
    schedule: str,
    project: opt(str),
    timezone: opt(str),
    http: opt(
      shape({
        url: str,
        method: opt(str),
        headers: opt(dict(str)),
        body: opt(str),
        bearer: opt(shape({ file: opt(str), app: opt(str), env: opt(str) })),
        expect_status: opt(list(num)),
      }),
    ),
    host: opt(strings),
    dir: opt(str),
    container: opt(shape({ app: str, command: strings })),
    timeout: opt(durations),
    alert_after: opt(num),
    realert_after: opt(durations),
    catch_up: opt(bool),
    paused: opt(bool),
  },
  { run: "host" },
);

const databaseConfig = shape(
  {
    name: str,
    host: str,
    database: str,
    user: str,
    project: opt(str),
    engine: opt(str),
    port: opt(num),
    password_file: opt(str),
    ssl_mode: opt(str),
    version: opt(num),
    network: opt(str),
    backups: opt(backups),
  },
  { backup: "backups" },
);

const notificationsConfig = shape({
  name: opt(str),
  events: opt(strings),
  webhooks: opt(list(shape({ url: str, secret_file: opt(str) }))),
  telegram: opt(shape({ bot_token_file: str, chat_id: str, api_url: opt(str) })),
  heartbeat: opt(shape({ url: str, every: opt(durations) })),
  disk_alert_percent: opt(num),
  memory_alert_percent: opt(num),
  alert_cooldown: opt(durations),
});

/** The sections of a configuration model the dashboard knows; `build_limits` is the agent's own (the dashboard reads it from /v1/system). */
export const MODEL_SECTIONS = ["registries", "apps", "proxy", "notifications", "jobs", "databases", "managed_postgres", "build_limits"] as const;

const modelSections: Check = (v, at, out) => {
  if (typeof v !== "object" || v === null) return;
  for (const key of Object.keys(v)) if (!(MODEL_SECTIONS as readonly string[]).includes(key)) out.push(`${at}.${key}: a section the dashboard does not know`);
};

const model = (sections: Record<string, Check>, retired: Record<string, string> = {}): Check => {
  const inner = shape(sections, retired);
  return (v, at, out) => {
    inner(v, at, out);
    modelSections(v, at, out);
  };
};

const configModel = model(
  {
    registries: opt(list(shape({ host: str, username: str, password_file: str }))),
    apps: opt(list(appConfig)),
    proxy: opt(shape({ type: opt(str), admin: opt(str), acme_email: opt(str), tls: opt(str), sites: opt(list(shape({ hosts: strings, root: opt(str), upstream: opt(str), redirect: opt(shape({ to: str, code: opt(num) })) }))) })),
    notifications: opt(notificationsConfig),
    jobs: opt(list(jobConfig)),
    databases: opt(list(databaseConfig)),
    managed_postgres: opt(shape({ version: opt(num), port: opt(num), memory: opt(str) })),
    build_limits: opt(dict(orElse(str, num, bool))),
  },
  // The sections of the legacy schema.
  { postgres: "managed_postgres", previews: "the previews key of each app" },
);

const configDocument = shape({
  content: str,
  hash: str,
  modified_at: str,
  applied_hash: str,
  model: configModel,
  deprecations: list(configIssue),
  error: opt(str),
  files: opt(list(shape({ path: str, project: str, hash: str, modified_at: str }))),
});

const projectConfigDocument = shape({
  project: str,
  path: str,
  content: str,
  hash: str,
  applied_hash: str,
  config_hash: str,
  modified_at: str,
  model: shape({ apps: opt(list(appConfig)), jobs: opt(list(jobConfig)), databases: opt(list(databaseConfig)) }),
  error: opt(str),
});

const projectFile = shape({ name: str, path: str, hash: str, applied_hash: str, modified_at: str, apps: num, jobs: num, databases: num, previews: num });

const configValidation = shape({ ok: bool, issues: list(configIssue) });

// ---- What lib/agent.ts and the tests call ---------------------------------------------------------------------------------

/** A check of one answer: the problems found, none when it is as the dashboard reads it. */
export type ContractCheck = (answer: unknown) => string[];

const checker =
  (check: Check, root: string): ContractCheck =>
  (answer) => {
    const out: Problems = [];
    check(answer, root, out);
    return out;
  };

export const checkInfo = checker(shape({ version: str, read_only: bool }), "info");
export const checkSystem = checker(system, "system");
export const checkContainers = checker(list(container), "containers");
export const checkApps = checker(list(app), "apps");
export const checkJobs = checker(list(job), "jobs");
export const checkDatabases = checker(list(database), "databases");
export const checkDeployments = checker(list(deployment), "deployments");
export const checkProofs = checker(list(proof), "proofs");
export const checkProxy = checker(proxyView, "proxy");
export const checkConfigDocument = checker(configDocument, "config");
export const checkProjectConfigDocument = checker(projectConfigDocument, "project config");
export const checkProjects = checker(list(projectFile), "projects");
export const checkConfigValidation = checker(configValidation, "validation");

const reported = new Set<string>();

/**
 * In development, one line on the server's console naming the first thing an answer lacks (and how many more): once per
 * problem, so a page that polls does not repeat it. Never throws: an agent that drifted is the operator's to update, and
 * what the dashboard can show of it, it shows.
 */
export function reportDrift(route: string, problems: string[]): void {
  if (problems.length === 0) return;
  const line = `[contract] ${route.split("?")[0]}: ${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ""}`;
  if (reported.has(line)) return;
  reported.add(line);
  console.warn(line);
}
