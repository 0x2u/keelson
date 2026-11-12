// Mirrors the JSON of the agent API (agent/internal/docker, store, deploy).

export interface Port {
  ip?: string;
  private_port: number;
  public_port?: number;
  type: string;
}

export interface Container {
  id: string;
  name: string;
  image: string;
  image_id: string;
  command: string;
  created: number;
  state: string;
  status: string;
  labels: Record<string, string>;
  ports: Port[];
}

export interface ContainerState {
  status: string;
  running: boolean;
  paused: boolean;
  restarting: boolean;
  oom_killed: boolean;
  exit_code: number;
  started_at?: string;
  finished_at?: string;
  /** "starting", "healthy" or "unhealthy"; absent without a HEALTHCHECK. */
  health?: string;
}

export interface ContainerDetail {
  id: string;
  name: string;
  image: string;
  created: string;
  tty: boolean;
  restart_count: number;
  state: ContainerState;
  ports: Port[] | null;
}

export interface LogLine {
  time: string;
  stream: "stdout" | "stderr";
  line: string;
}

export interface Stats {
  time: string;
  cpu_percent: number;
  mem_usage: number;
  mem_limit: number;
  mem_percent: number;
  net_rx_bytes: number;
  net_tx_bytes: number;
  pids: number;
}

/** One point of the recorded history: the average over `step_seconds`, and the highest value inside it. */
export interface StatsPoint {
  time: string;
  cpu_percent: number;
  cpu_max: number;
  mem_usage: number;
  mem_max: number;
  mem_limit: number;
}

/** GET /v1/stats/history. For an app's container the points are the app's, across its deployments. */
export interface StatsHistory {
  container: string;
  step_seconds: number;
  points: StatsPoint[];
}

/** One point of the host's history (GET /v1/stats/host): the average over the point and the highest value inside it. A value is absent when the machine does not expose it. */
export interface HostPoint {
  time: string;
  /** The 1 minute load average. */
  load?: number;
  load_max?: number;
  /** Memory in use, percent of the total (without what is reclaimable). */
  mem_percent?: number;
  mem_percent_max?: number;
  /** The disk under the agent's data, percent used. */
  disk_percent?: number;
  disk_percent_max?: number;
}

export interface HostHistory {
  /** How many CPUs the machine has: load reads against it. */
  cpus: number;
  /** The width of a point. */
  step_seconds: number;
  points: HostPoint[];
}

/** A period when an app was down, as the agent's watcher judged it. */
export interface AvailabilityIncident {
  start: string;
  /** Null while it lasts. */
  end: string | null;
  /** Up to the end of the range for an incident that lasts. */
  duration_seconds: number;
}

/** GET /v1/apps/{app}/availability. */
export interface AppAvailability {
  app: string;
  range: "24h" | "7d" | "30d";
  from: string;
  to: string;
  /** Where the recorded part of the range starts (later than `from` when the agent has watched the app for less time); null when the app has not been judged yet. */
  since: string | null;
  covered_seconds: number;
  down_seconds: number;
  /** Over the recorded part; null when nothing is covered yet. */
  uptime_percent: number | null;
  /** Newest first, at most 50. */
  incidents: AvailabilityIncident[];
}

/** One notification the agent raised, with how its delivery ended (GET /v1/notifications/history, newest first, at most 200). */
export interface AlertRecord {
  type: string;
  severity: string;
  server: string;
  app?: string;
  time: string;
  title: string;
  message?: string;
  deployment_id?: string;
  job?: string;
  ref?: string;
  /** delivered, partial, failed, dropped, no_channel or suppressed. */
  status: string;
  /** The channels that failed, by name. */
  failed_channels?: string[];
}

export type DeploymentStatus = "running" | "succeeded" | "failed" | "rolled_back" | "rollback_failed";

/** The phases of a deployment, in pipeline order. */
export type PhaseName = "source" | "build" | "release" | "switch" | "soak" | "live";

/** One phase a deployment reached (or deliberately skipped); `finished_at` is absent while it runs. */
export interface DeploymentPhase {
  name: PhaseName;
  status: "running" | "done" | "failed" | "skipped";
  started_at: string;
  finished_at?: string;
}

export interface Deployment {
  id: string;
  app: string;
  ref: string;
  previous_ref?: string;
  status: DeploymentStatus;
  trigger: string;
  error?: string;
  started_at: string;
  finished_at?: string;
  /** In pipeline order, only the phases reached or skipped on purpose; absent on an agent (or a record) that does not track phases. */
  phases?: DeploymentPhase[];
  /** The image that serves after the deployment finished; absent while it runs and when nothing is known to serve (or the agent does not say). */
  serving_ref?: string;
}

export interface DeploymentEvent {
  seq: number;
  time: string;
  /** "output" is the last output of a failed container, recorded by the agent before it removed it. */
  level: "info" | "warn" | "error" | "output";
  message: string;
  /** The phase that was current when the event happened; absent outside any phase and on an agent that does not track phases. */
  phase?: PhaseName;
}

export interface AppStatus {
  name: string;
  image: string;
  /** The labels of the apps file as written; empty when not set. See lib/projects-core.ts for the defaults. */
  project: string;
  environment: string;
  /** Registry digest ("sha256:...") of the image that serves; empty when nothing runs or the image has none. */
  digest: string;
  container: ContainerDetail | null;
  last_deployment: Deployment | null;
  /**
   * When a managed environment variable of the app (either scope) last changed: RFC 3339, or empty/absent when none was
   * ever set (and for an agent that does not manage variables). Compared with the last deployment, it tells that the
   * running version does not have the current variables yet.
   */
  env_changed_at?: string;
  /** The public hostnames the proxy routes to the app; absent when it has none and for an agent that does not report them. */
  domains?: string[];
}

export interface ProxyRoute {
  /** "app" for a blue/green app, "site" for a `proxy.sites` entry (static files, a fixed upstream or a redirect). */
  kind: "app" | "site";
  /** Empty for a site. */
  app: string;
  domains: string[];
  /** Sites only: what the site serves. */
  site_kind?: "static" | "upstream" | "redirect";
  /** Sites only: the root directory, the upstream, or the redirect as "301 https://...". */
  target?: string;
  /** "host:port" of the container the proxy sends the traffic to; the fixed upstream of an upstream site; empty otherwise. */
  upstream: string;
  /** The nginx upstream block to point proxy_pass at; absent with Caddy. */
  upstream_name?: string;
  /** Empty for a site, as are `ref` and a zero `updated_at`; `running` is false for a site. */
  container: string;
  /** The image the serving version was deployed from. */
  ref: string;
  updated_at: string;
  running: boolean;
}

/** GET /v1/proxy, read-only: what is exposed, where it goes, and whether the proxy serves what the agent generates. */
export interface ProxyView {
  type: "caddy" | "nginx";
  /** The Caddy admin API, or the nginx upstreams file. */
  where: string;
  /** The configuration the agent generates: the upstreams file, or the Caddy routes as JSON. */
  generated: string;
  /** Caddy only: the whole document the agent loads (the routes above, the listener, the certificates). */
  config?: string;
  /** Absent when the proxy could not be read: see `live_error`. */
  in_sync?: boolean;
  live_error?: string;
  routes: ProxyRoute[];
  /** Apps declared behind the proxy that have no route yet. */
  unrouted: { app: string; domains: string[]; reason: string }[];
}

export interface AgentInfo {
  version: string;
  read_only: boolean;
}

/** GET /v1/system: the machine and the engine. A part the agent could not read is absent. */
export interface SystemInfo {
  /** The agent's clock when it answered. */
  time: string;
  host: {
    hostname?: string;
    cpus: number;
    uptime_seconds?: number;
    load?: { one: number; five: number; fifteen: number };
    /** Bytes. `available` is what a new process can get without swapping, not just what is free. */
    memory?: { total: number; available: number; swap_total: number; swap_free: number };
    /** The filesystem holding the engine's data, or "/" when the agent cannot read that directory. */
    disk?: { path: string; total: number; free: number };
  };
  engine?: {
    name: string;
    version: string;
    os: string;
    cpus: number;
    mem_total: number;
    root_dir: string;
    containers: number;
    running: number;
    images: number;
  };
  /** Set instead of `engine` when Docker did not answer. */
  engine_error?: string;
  /** The engine's own platform, normalised (`linux`, `amd64` or `arm64`); absent when the agent does not know it. */
  os?: string;
  arch?: string;
  /** Absent on an agent without `POST /v1/builds`: a server that cannot build for the dashboard. */
  build?: SystemBuild;
}

/** What the agent accepts in a build request: the ceilings of its `build_limits`, or the agent's defaults. A request above one is refused (400), never clamped. */
export interface BuildLimits {
  /** Bytes; 0 = no ceiling. */
  memory: number;
  cpus: number;
  timeout_seconds: number;
  /** Bytes. */
  max_source: number;
  source_hosts: string[];
  host_network: boolean;
  /** How many built images of an app are kept before the oldest are pruned. */
  keep_images: number;
}

export interface SystemBuild {
  enabled: boolean;
  limits: BuildLimits;
}

export interface UnusedImage {
  id: string;
  /** Empty for a dangling image. */
  tags: string[] | null;
  /** Unix seconds. */
  created: number;
  /** What removing it frees: its size without the layers other images share. */
  size: number;
}

/** GET /v1/system/disk: the engine's accounting of the disk it uses, in bytes. */
export interface DiskUsage {
  images: { count: number; unused: number; size: number; reclaimable: number; largest: UnusedImage[] };
  containers: { count: number; size: number };
  volumes: { count: number; unused: number; size: number };
  build_cache: { count: number; size: number; reclaimable: number };
}

/** One live preview environment (an instance of an app's `previews:` template): GET /v1/previews. */
export interface Preview {
  /** `<app>-pr-<n>`. */
  name: string;
  /** The parent app whose template made it. */
  app: string;
  /** The pull request number. */
  pr: number;
  domain: string;
  /** `https://<domain>`. */
  url: string;
  /** The image the instance was last deployed from. */
  ref: string;
  status: "deploying" | "running" | "failed";
  deployment_id: string;
  created_at: string;
  updated_at: string;
  /** When the sweeper removes it unless it is deployed again first. */
  expires_at: string;
}

/** PUT /v1/previews/{app}/{pr}: accepted; the deployment runs on. */
export interface PreviewDeployment {
  deployment_id: string;
  name: string;
  url: string;
  /** Older instances removed to stay within the template's `max`. */
  evicted: string[];
}

/** Where the agent downloads the source of a build from: a short-lived address and the token that reads it. The token is never stored or logged. */
export interface BuildSource {
  url: string;
  token: string;
}

/** POST /v1/builds: build `<image>:<sha>` from the source on this server, which keeps it (nothing is deployed there). The build block carries neither `only` nor `database`. */
export interface BuildRequestBody {
  app: string;
  /** The repository of the image, without a tag. */
  image: string;
  sha: string;
  source: BuildSource;
  build: BuildConfig;
  port?: number;
  health_path?: string;
}

/** Exactly one of tag or digest. */
export type DeployTarget = { tag: string; digest?: never } | { digest: string; tag?: never };

export type JobRunStatus = "running" | "succeeded" | "failed" | "skipped" | "missed";

export interface JobRun {
  id: string;
  job: string;
  trigger: "schedule" | "manual" | "catch-up";
  status: JobRunStatus;
  detail?: string;
  output?: string;
  started_at: string;
  finished_at?: string;
}

export interface JobStatus {
  name: string;
  schedule: string;
  timezone: string;
  kind: "http" | "host" | "container" | "backup";
  /** What the job does, without secrets: "GET http://host/path", the program, or "container of app". */
  target: string;
  /** The project the job or its file says it belongs to; omitted when neither does (a backup job has its database's). */
  project?: string;
  paused: boolean;
  running: boolean;
  next_run?: string;
  last_run?: JobRun;
}

// ---- Databases (see the agent's databases API) ------------------------------------------------------------------------

export interface DatabaseBackupRun {
  id: string;
  status: JobRunStatus;
  started_at: string;
  finished_at?: string | null;
  detail?: string;
}

export interface DatabaseBackupStatus {
  schedule: string;
  timezone: string;
  keep: number;
  keep_days: number;
  paused: boolean;
  /** "local:/dir" or "s3:bucket/prefix". */
  destination: string;
  /** How many age public keys the backups are encrypted to. */
  recipients: number;
  /** The scheduled job that makes the backups: "backup-<name>". */
  job: string;
  next_run: string | null;
  last_run: DatabaseBackupRun | null;
}

export interface DatabaseStatus {
  name: string;
  engine: string;
  host: string;
  port: number;
  database: string;
  user: string;
  /** The version configured; 0 when the agent detects it. */
  version: number;
  network: string;
  has_password: boolean;
  /** Created by the dashboard for an app (managed): the app it serves and the variable that holds its URL. Empty otherwise. */
  managed?: boolean;
  app?: string;
  env_key?: string;
  /** The project the database or its file says it belongs to; omitted when neither does. */
  project?: string;
  backup: DatabaseBackupStatus | null;
}

/** What the server answers when probed through a throwaway client container. */
export interface DatabaseLive {
  server_version: string;
  size_bytes: number;
  client_image: string;
}

/** One backup found at the destination. */
export interface DatabaseBackup {
  /** The identifier to restore: pass it back unchanged. */
  key: string;
  name: string;
  size_bytes: number;
  created_at: string;
  /** Absent for a scheduled or manual backup. */
  kind?: BackupKind;
}

/** The backups besides a scheduled or manual one: taken before a deployment, and before a restore over the live database. */
export type BackupKind = "pre-deploy" | "pre-restore";

/** One row count of the restore test: the table in the scratch restore and in the live database; null where the table is not there. */
export interface RestoreTestTable {
  name: string;
  backup_rows: number | null;
  live_rows: number | null;
}

/** A restore into a scratch database, as `GET /v1/databases/{name}/restore-tests` lists it, newest first. The agent always drops the scratch database. */
export interface RestoreTest {
  id: string;
  backup: string;
  backup_time: string;
  started_at: string;
  finished_at?: string;
  status: "running" | "passed" | "failed";
  error?: string;
  tables: RestoreTestTable[] | null;
}

/** What the key proof answers: the sample authenticated, or why it did not. */
export type KeyProofReason = "wrong_key" | "not_age" | "no_backup" | "fetch_failed";
export type KeyProof = { ok: true; backup: string; backup_time: string } | { ok: false; reason: KeyProofReason };

/** The latest successful proof the agent holds for a kind and subject (a database, or empty for the alert channels): `GET /v1/proofs`. */
export interface Proof {
  kind: "key" | "alert" | "restore";
  subject: string;
  at: string;
}

/** How a channel of the test alert failed: a class, never the text of the error (it could quote a URL or a token). */
export type AlertFailure = "timeout" | "refused" | "rejected" | "other";
export interface AlertTest {
  channels: { channel: "telegram" | "webhook"; ok: boolean; reason?: AlertFailure }[];
}

export interface RestoreRequest {
  backup: string;
  /** The age secret key: held by the agent in memory for the run, never stored or logged. */
  identity: string;
  target?: string;
  overwrite?: boolean;
  /** The live database's name, required with overwrite. */
  confirm?: string;
}

// ---- Configuration (see the agent's configuration API) ----------------------------------------------------------------

/** Stands for a secret the agent keeps and never sends: send it back unchanged to keep the stored value. */
export const HIDDEN = "<hidden>";

export interface ConfigIssue {
  severity: "error" | "warning";
  /** Where: "apps[web]", "apps[web].env", "jobs[backup]", "notifications", "yaml". */
  path: string;
  /** 1-based line in the submitted YAML when known. */
  line?: number;
  message: string;
  /** Warnings that need acknowledgement: "app_removed", "job_removed", "previews_removed", "proxy_changed", "secret_removed". */
  code?: string;
  /**
   * The file the issue is in, present only when the configuration has project files: "projects.d/<p>.yaml", or the apps
   * file's base name ("apps.yaml"). `line` is then the line in that file.
   */
  file?: string;
  /** The project of `file` when it is a project file. */
  project?: string;
}

/** The app's port: `3000` (the container port the proxy forwards to), or `{host: [3000, 3001], env: "PORT"}` for an app on the host network (the two host ports it alternates between, and the variable that tells it which one to listen on). */
export type PortConfig = number | { container?: number; host?: number[]; env?: string };

/** One release step: exactly one of `host`, `container` and `backup`. */
export interface ReleaseStepConfig {
  name: string;
  /** A command on the host, an argument list. */
  host?: string[];
  /** The working directory of a host command. */
  dir?: string;
  /** A command in a throwaway container of the app; `image` replaces the repository for a tool that is not in the app's image. */
  container?: { command?: string[]; image?: string };
  /** The name of a declared database to back up. */
  backup?: string;
  timeout?: string;
  continue_on_failure?: boolean;
}

/** The `previews:` template of an app (the key of the app, not a section of the file). */
export interface PreviewsConfig {
  /** The public host pattern, with `{pr}` for the pull request number. */
  domain: string;
  env_file?: string;
  env?: Record<string, string>;
  ttl?: string;
  max?: number;
}

/** The `database:` of an app: the database the agent creates for it on its managed PostgreSQL. */
export interface AppDatabaseConfig {
  name?: string;
  env_key?: string;
  password_file?: string;
  backups?: DatabaseBackupConfig;
}

/** One gate of an analysis: a PromQL query and the bounds its value must stay within. */
export interface MetricGateConfig {
  name: string;
  query: string;
  max?: number;
  min?: number;
  /** How often the query is asked; the agent's default is 10s. */
  interval?: string;
  /** Bad evaluations in a row that roll the deployment back; the agent's default is 3. */
  failure_limit?: number;
  /** What a query that returns nothing counts as; the agent's default is pass. */
  no_data?: "pass" | "fail";
}

export interface AnalysisConfig {
  /** The base URL of the Prometheus; the agent's default is http://127.0.0.1:9090. */
  address?: string;
  metrics: MetricGateConfig[];
}

export interface AppConfig {
  name: string;
  project?: string;
  environment?: string;
  image: string;
  env_file?: string;
  env?: Record<string, string>;
  /** Fixed port mappings `[hostip:]hostport:containerport[/proto]`. */
  publish?: string[];
  volumes?: string[];
  network?: string;
  restart?: "" | "no" | "always" | "unless-stopped" | "on-failure";
  command?: string[];
  stop_timeout?: string;
  health_timeout?: string;
  stable_after?: string;
  drain?: string;
  /** How long the previous version stays up while the new one is watched after the switch; 0s turns it off. */
  soak?: string;
  /** Pages requested on the new version during the soak; status defaults to any 2xx. */
  verify?: { path: string; status?: number }[];
  /** Prometheus queries that judge the new version during the soak: out of bounds a few times in a row, traffic goes back. */
  analysis?: AnalysisConfig;
  domains?: string[];
  port?: PortConfig;
  health_path?: string;
  release?: { steps: ReleaseStepConfig[]; on_rollback?: boolean };
  log?: { driver?: "json-file" | "local"; max_size?: string; max_file?: number };
  keep_images?: number;
  /** Lets the dashboard have this agent build the image from a repository (a GitHub App installation). */
  build?: BuildConfig;
  /** The per-pull-request environments of this app. */
  previews?: PreviewsConfig;
  /** The database the agent creates for this app. */
  database?: AppDatabaseConfig;
  /** The repository the app is built from; the agent checks its shape and never acts on it. */
  source?: AppSourceConfig;
  deploy?: { strategy?: "switch" | "replace" };
}

/** The `source:` of an app. */
export interface AppSourceConfig {
  repo: string;
  branch?: string;
  deploy_on?: "workflow";
  workflow?: string;
  previews_workflow?: string;
  build_on?: ("push" | "pull_request")[];
  build_server?: string;
}

/** The `build:` block of an app: what the agent needs to build its image from a source archive. Arguments are not secret. */
export interface BuildConfig {
  /** Build presets (see `lib/presets-core.ts`): the agent writes the Dockerfile itself. Exclusive with `dockerfile` and `target`; the options below only apply with one. */
  preset?: "nextjs" | "node" | "vite" | "static";
  install?: string;
  build_command?: string;
  start?: string;
  /** Vite and static: the directory the build writes (agent default `dist`). */
  output_dir?: string;
  /** Node.js major version; a YAML `node: 22` reaches the model as a number. */
  node?: string | number;
  /** Vite and static: unknown paths answer `/index.html` (agent default true). */
  spa?: boolean;
  /** Next.js: ship `.next/standalone` and run `node server.js` (agent default false). */
  standalone?: boolean;
  /** Path of the Dockerfile inside `context`. */
  dockerfile?: string;
  /** Subdirectory of the repository sent to Docker as the build context. */
  context?: string;
  target?: string;
  args?: Record<string, string>;
  timeout?: string;
  memory?: string;
  cpus?: number;
  /** Network of the build's containers: absent for the engine's default bridge, "host" for the server's own network, or a user-defined network's name. */
  network?: string;
  /** The build uses the app's managed database: its URL is a build argument, and the build runs on the network that reaches it. */
  database?: boolean;
  /** The platform the image is built for (`linux/amd64`, `linux/arm64`); absent = the engine's own. */
  platform?: string;
  max_source?: string;
  source_hosts?: string[];
}

export interface JobConfig {
  name: string;
  /** The project the job belongs to; set by the agent for what comes from a project file. */
  project?: string;
  schedule: string;
  timezone?: string;
  /** Exactly one of http, host, container. */
  http?: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    bearer?: { file?: string; app?: string; env?: string };
    expect_status?: number[];
  };
  /** A command on the host, an argument list. */
  host?: string[];
  dir?: string;
  container?: { app: string; command: string[] };
  timeout?: string;
  alert_after?: number;
  /** How long a continuing failure streak waits before job.failed is sent again; 0s never repeats. */
  realert_after?: string;
  /** Run the job once, late, when scheduled runs were missed because the agent was not running. */
  catch_up?: boolean;
  paused?: boolean;
}

export interface DatabaseBackupConfig {
  schedule: string;
  timezone?: string;
  /** age X25519 public keys: required, not secret. */
  recipients: string[];
  keep?: number;
  keep_days?: number;
  /** How many backups taken before a deployment (and before a restore) are kept, apart from keep. Default 5. */
  keep_pre_deploy?: number;
  timeout?: string;
  alert_after?: number;
  paused?: boolean;
  /** The places backups go (schema v1: always a list, one to a few; the legacy single `destination` is read by the agent with a deprecation warning and never written). Every one holds every backup, or the backup failed. */
  destinations: BackupDestinationConfig[];
}

export interface BackupDestinationConfig {
  local?: { dir: string };
  s3?: {
    endpoint: string;
    region: string;
    bucket: string;
    prefix?: string;
    access_key_id: string;
    secret_key_file: string;
  };
}

export interface DatabaseConfig {
  name: string;
  /** The project the database belongs to; set by the agent for what comes from a project file. */
  project?: string;
  engine?: "postgres";
  host: string;
  port?: number;
  database: string;
  user: string;
  password_file?: string;
  ssl_mode?: "" | "disable" | "allow" | "prefer" | "require" | "verify-ca" | "verify-full";
  version?: number;
  network?: string;
  /** Schema v1 spells it `backups`; the legacy `backup` is read by the agent with a deprecation warning and never written. */
  backups?: DatabaseBackupConfig;
}

export interface NotificationsConfig {
  name?: string;
  events?: string[];
  webhooks?: { url: string; secret_file?: string }[];
  telegram?: { bot_token_file: string; chat_id: string; api_url?: string };
  heartbeat?: { url: string; every?: string };
  disk_alert_percent?: number;
  memory_alert_percent?: number;
  alert_cooldown?: string;
  /** Days before a certificate expires at which certificate.expiring is raised; the agent's default is 14. */
  cert_warn_days?: number;
}

/** A non-app site of the Caddy proxy: exactly one of `root`, `upstream` and `redirect`. */
export interface ProxySiteConfig {
  hosts: string[];
  root?: string;
  not_found?: string;
  immutable?: string[];
  try_files?: string[];
  index?: string;
  upstream?: string;
  redirect?: { to: string; code?: number };
  headers?: Record<string, string>;
}

/** The `proxy` section of the apps file. nginx keys and Caddy keys do not mix. */
export interface ProxyConfig {
  type?: "caddy" | "nginx";
  admin?: string;
  acme_email?: string;
  tls?: string;
  sites?: ProxySiteConfig[];
  trusted_proxies?: string[];
  client_ip_header?: string;
  upstreams_file?: string;
  test?: string[];
  reload?: string[];
}

export interface ConfigModel {
  registries?: { host: string; username: string; password_file: string }[];
  apps?: AppConfig[];
  proxy?: ProxyConfig;
  notifications?: NotificationsConfig;
  jobs?: JobConfig[];
  databases?: DatabaseConfig[];
  /** The settings of the managed PostgreSQL of the server. */
  managed_postgres?: ManagedPostgresConfig;
}

/** The `managed_postgres` section of the apps file: every key left out is its default. */
export interface ManagedPostgresConfig {
  version?: number;
  port?: number;
  memory?: string;
}

/** One file of the configuration bundle: GET /v1/config `files`, the apps file first. */
export interface ConfigFile {
  /** "apps.yaml" (the apps file's base name) or "projects.d/<p>.yaml". */
  path: string;
  /** "" for the apps file. */
  project: string;
  /** sha256 of that file: the base_hash of the project file's own PUT. */
  hash: string;
  modified_at: string;
}

export interface ConfigDocument {
  /** The apps file only, secrets redacted. */
  content: string;
  /** Hash of the whole configuration on disk (the apps file's sha256 without project files): send it back as base_hash. */
  hash: string;
  /** The latest change among the files. */
  modified_at: string;
  /** The apps file's model plus the apps, jobs and databases of every project file. */
  model: ConfigModel;
  /** The configuration on disk is currently invalid (names the file and line); the agent keeps running the last good one. */
  error?: string;
  /** Hash of the configuration the agent is running right now. */
  applied_hash: string;
  /** The files of the bundle; only an agent with per-project files sends it. */
  files?: ConfigFile[];
  /** The spellings the files use that have a new name (warnings with the code "deprecated"): the model above is already in the current schema. Empty when the files are current. */
  deprecations: ConfigIssue[];
}

/** One entry of GET /v1/projects: a project's own file. */
export interface ProjectFileSummary {
  name: string;
  path: string;
  hash: string;
  /** Empty: the file on disk is not in force. */
  applied_hash: string;
  modified_at: string;
  /** Counts of list entries. */
  apps: number;
  jobs: number;
  databases: number;
  previews: number;
}

/** GET /v1/projects/{name}/config. */
export interface ProjectConfigDocument {
  project: string;
  path: string;
  /** That file, secrets redacted; the file in force when the one on disk is not. */
  content: string;
  /** sha256 of the file on disk: the base_hash of its PUT. */
  hash: string;
  applied_hash: string;
  /** The bundle hash: the base_hash of server-wide saves. */
  config_hash: string;
  modified_at: string;
  model: { apps?: AppConfig[]; jobs?: JobConfig[]; databases?: DatabaseConfig[] };
  /** Why the file on disk is not the one in force, with file and line. */
  error?: string;
}

export interface SplitKept {
  kind: string;
  name: string;
  reason: string;
}

/** What POST /v1/projects/{name}/split moves out of the apps file, and what stays there. */
export interface SplitPlan {
  project: string;
  file: string;
  apps: string[];
  jobs: string[];
  databases: string[];
  previews: string[];
  kept: SplitKept[];
}

export type SplitResult =
  | { ok: true; dryRun: boolean; hash: string; fileHash?: string; version?: number; issues: ConfigIssue[]; plan: SplitPlan }
  | Extract<SaveResult, { ok: false }>;

export interface ConfigValidation {
  ok: boolean;
  issues: ConfigIssue[];
}

export interface SaveOptions {
  /** The hash of the document the change was made on: a mismatch means someone else edited it. */
  base_hash: string;
  comment?: string;
  /** Acknowledges the warnings that need it (removing an app, changing the proxy...). */
  force?: boolean;
}

/** What a project file's change carries: `base_hash` is that file's hash, and absent when the file is created. */
export type ProjectSaveOptions = Omit<SaveOptions, "base_hash"> & { base_hash?: string };

export type SaveResult =
  | { ok: true; hash: string; /** A project file's save: the hash of the whole configuration. */ config_hash?: string; version?: number; issues: ConfigIssue[] }
  | {
      ok: false;
      kind: "invalid" | "changed" | "needs_acknowledgement" | "busy";
      message?: string;
      issues: ConfigIssue[];
      /** For "changed": the current hash of the file. */
      hash?: string;
    };

export interface ConfigVersion {
  id: number;
  at: string;
  hash: string;
  source: "startup" | "api" | "file" | "restore";
  actor?: string;
  comment?: string;
}

export interface ConfigVersionContent extends ConfigVersion {
  /** The version's apps file, secrets redacted. */
  content: string;
  /** The project files of the version; only when it has some. */
  files?: { path: string; project: string; hash: string; content: string }[];
}

export interface AuditEntry {
  id: number;
  at: string;
  actor?: string;
  ip?: string;
  method: string;
  path: string;
  /** A short route name: deploy, rollback, job.run, config.update, config.restore, app.save, ... */
  action: string;
  status: number;
  detail?: string;
}

/** The two places a managed variable can apply: the running app, and every preview instance of that app. */
export type EnvScope = "app" | "preview";

/** One managed variable as the agent describes it: never its value (the agent keeps that in a 0600 file and never sends it back). */
export interface EnvVar {
  key: string;
  updated_at: string;
  /** Also passed as a docker build argument when the agent builds the app: baked into the image. */
  build: boolean;
  /** The managed value wins over one with the same name from `env_file` or `env:` of the apps file. */
  shadows: "env_file" | "env" | null;
}

/** GET /v1/apps/{app}/env?scope=. */
export interface EnvVars {
  scope: EnvScope;
  vars: EnvVar[];
  /** The latest `updated_at` of the scope; the dashboard falls back to the variables' own when absent. */
  last_changed?: string | null;
}

/** PUT /v1/apps/{app}/env: all or nothing. `build` lists keys of `set` (or already stored) that are also build arguments. */
export interface EnvChange {
  scope: EnvScope;
  set?: Record<string, string>;
  build?: string[];
  unset?: string[];
}

/** One problem the agent found with one key (empty key: the scope as a whole, such as too many variables). */
export interface EnvIssue {
  key: string;
  message: string;
}

export type EnvSaveResult = { ok: true; changed: string[]; removed: string[] } | { ok: false; message: string; issues: EnvIssue[] };

/** One stored build variable of the builder, as GET /v1/build-vars/{app} lists it: never its value. */
export interface BuildVarName {
  name: string;
  changed_at: string;
}

/** GET /v1/build-vars/{app}: the build variables a server keeps for the builds it runs for another server, under the app's name. */
export interface BuildVars {
  names: BuildVarName[];
}

/** PUT /v1/build-vars/{app}: all or nothing; every variable set is a build argument. */
export interface BuildVarsChange {
  set?: Record<string, string>;
  remove?: string[];
}

/** GET /v1/postgres: the managed PostgreSQL of a server (one container, a database and a role per app). Never a secret. */
export interface ManagedPostgres {
  /** False until the first database is asked for: a server that never asks never gets an instance. */
  exists: boolean;
  state: "missing" | "running" | "stopped" | "starting" | "unhealthy" | string;
  running: boolean;
  health: string;
  container: string;
  image: string;
  major: number;
  /** Empty while it is not running. */
  server_version: string;
  size_bytes: number;
  volume: string;
  network: string;
  /** The host an app on a Docker network connects to. */
  host: string;
  /** The loopback port an app on the host network connects to; 0 when not published. */
  port: number;
  memory_bytes: number;
  /** False when the apps file asks for another image, port or memory than the container was created with. */
  settings_current: boolean;
  databases: { name: string; app: string; env_key: string }[];
}

/** POST /v1/postgres/databases. Everything but `app` is optional. */
export interface ManagedDatabaseRequest {
  app: string;
  /** The entry, database and role name; the app's name when absent. */
  name?: string;
  /** The variable that receives the URL; DATABASE_URL when absent. */
  env_key?: string;
  backup?: { keep?: number; schedule?: string };
  /** Replace the backup recipients of a database that exists with a fresh key pair (for a lost answer). */
  new_backup_key?: boolean;
}

/** The answer of a create or a password rotation. `backup_key` is returned once, never stored anywhere, and is a secret. */
export interface ManagedDatabaseResult {
  database: { name: string; app: string; database: string; user: string; host: string; port: number; mode: "network" | "host" };
  env_key: string;
  /** False when the database existed and the request only completed it. */
  created: boolean;
  /** Always true: an app reads its variables when it starts. */
  redeploy_required: boolean;
  backup_key?: string;
  backup_recipient?: string;
}
