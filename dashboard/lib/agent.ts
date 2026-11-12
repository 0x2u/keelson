import "server-only";
import type { Readable } from "node:stream";
import { Agent, fetch as undiciFetch } from "undici";
import { AGENT_TOO_OLD_FOR_ENV } from "@/lib/env-core";
import {
  checkApps,
  checkConfigDocument,
  checkContainers,
  checkDatabases,
  checkDeployments,
  checkInfo,
  checkJobs,
  checkProjectConfigDocument,
  checkProofs,
  checkProxy,
  checkSystem,
  reportDrift,
  type ContractCheck,
} from "@/lib/contract-shapes";
import { AGENT_TOO_OLD_FOR_PROJECT_FILES } from "@/lib/project-config-core";
import { RelayError, relayFetch } from "@/lib/relay";
import { sign } from "@/lib/sign";
import type { ServerCredentials } from "@/lib/servers";
import type {
  AgentInfo,
  AppStatus,
  Container,
  ContainerDetail,
  DeployTarget,
  DiskUsage,
  Deployment,
  EnvChange,
  EnvIssue,
  EnvSaveResult,
  EnvScope,
  EnvVars,
  ManagedDatabaseRequest,
  ManagedDatabaseResult,
  ManagedPostgres,
  JobRun,
  JobStatus,
  ProxyView,
  AppConfig,
  BuildVars,
  BuildVarsChange,
  BuildRequestBody,
  BuildSource,
  DatabaseBackup,
  DatabaseConfig,
  DatabaseLive,
  DatabaseStatus,
  KeyProof,
  AlertTest,
  Proof,
  RestoreRequest,
  RestoreTest,
  AuditEntry,
  ConfigDocument,
  ConfigIssue,
  ConfigValidation,
  ConfigVersion,
  ConfigVersionContent,
  JobConfig,
  ProjectConfigDocument,
  ProjectSaveOptions,
  ProjectFileSummary,
  SplitPlan,
  SplitResult,
  NotificationsConfig,
  Preview,
  PreviewDeployment,
  SaveOptions,
  SaveResult,
  SystemInfo,
  StatsHistory,
  AlertRecord,
  HostHistory,
  AppAvailability,
} from "@/lib/agent-types";

const REQUEST_TIMEOUT_MS = 10_000;
/** The engine measures every layer and volume for its disk usage: it gets more time than an ordinary request. */
const DISK_USAGE_TIMEOUT_MS = 35_000;
/** The agent probes the database through a throwaway container and gives it up to 60 s. */
const DATABASE_PROBE_TIMEOUT_MS = 70_000;

/** The key proof reads from the backup destination and a test alert waits for every channel: more than an ordinary request. */
const READINESS_TIMEOUT_MS = 30_000;

/** Restarting waits for the stop timeout and the engine's start: more than an ordinary request. */
const CONTAINER_ACTION_TIMEOUT_MS = 60_000;

/** The answer when an agent has no start/restart routes. */
export const AGENT_TOO_OLD_FOR_CONTAINER_ACTIONS =
  "This agent is too old to start or restart containers. Update it from the server's page, then try again.";

/** The answer when an agent has no readiness routes (proofs, key proof, restore test, test alert). */
export const AGENT_TOO_OLD_FOR_READINESS = "This agent is too old for this check. Update it from the server's page, then try again.";

/** The answer when an agent has no managed-database routes. */
export const AGENT_TOO_OLD_FOR_POSTGRES = "This agent is too old to manage databases. Update it from the server's page, then try again.";
export { AGENT_TOO_OLD_FOR_ENV };
export const AGENT_TOO_OLD_FOR_BUILD_VARS =
  "This agent is too old to keep build variables for other servers. Update it from the server's page, then try again.";

/** A failure talking to an agent: status 0 means it could not be reached. */
export class AgentError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The parsed JSON body of the error answer, when there was one. */
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

// One connection pool per server and TLS configuration. The key includes
// updatedAt so editing a server's certificates takes effect at once.
const dispatchers = new Map<string, Agent>();

function newDispatcher(c: AgentConnection): Agent {
  return new Agent({
    connect: { ca: c.caCert ?? undefined, cert: c.clientCert ?? undefined, key: c.clientKey ?? undefined },
  });
}

/** The client for a registered server, reusing its connection pool. */
export function agentFor(s: ServerCredentials, actor = "dashboard"): AgentClient {
  // A machine that connects out has no address to open a pool to: its requests go over its relay connection.
  if (s.transport === "relay") return new AgentClient(s, { relayServerId: s.id }, actor);
  const key = `${s.id}:${s.updatedAt}`;
  let agent = dispatchers.get(key);
  if (!agent) {
    for (const [k, old] of dispatchers) {
      if (k.startsWith(`${s.id}:`)) {
        void old.close();
        dispatchers.delete(k);
      }
    }
    agent = newDispatcher(s);
    dispatchers.set(key, agent);
  }
  return new AgentClient(s, agent, actor);
}

/**
 * Checks that an agent answers with these credentials, using a throwaway
 * connection pool. Used before a server is saved.
 */
export async function probeAgent(c: AgentConnection): Promise<void> {
  const dispatcher = newDispatcher(c);
  try {
    await new AgentClient(c, dispatcher).containers(false);
  } finally {
    await dispatcher.close();
  }
}

/** Reads the code and message of an error's cause, where Node puts socket and TLS failures. */
function causeOf(err: unknown): { code?: string; message?: string } {
  if (!(err instanceof Error) || typeof err.cause !== "object" || err.cause === null) return {};
  const { cause } = err;
  return {
    code: "code" in cause && typeof cause.code === "string" ? cause.code : undefined,
    message: "message" in cause && typeof cause.message === "string" ? cause.message : undefined,
  };
}

/** Turns a network failure into something an operator can act on. */
function describeNetworkError(err: unknown): string {
  const cause = causeOf(err);
  switch (cause.code) {
    case "ECONNREFUSED":
      return "connection refused";
    case "ENOTFOUND":
      return "host not found";
    case "ETIMEDOUT":
    case "UND_ERR_CONNECT_TIMEOUT":
      return "timed out";
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
      return "TLS certificate not trusted (add the agent's CA certificate)";
    case "ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED":
    case "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE":
      return "the agent requires a client certificate";
  }
  if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) return "timed out";
  return cause.message ?? (err instanceof Error ? err.message : String(err));
}

/** An agent that knows a route answers an error as JSON `{"error": ...}`; an older one answers its router's plain 404. */
function answeredWithError(err: AgentError): boolean {
  return typeof err.body === "object" && err.body !== null && "error" in err.body;
}

function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) if (secret !== "") out = out.split(secret).join("[redacted]");
  return out;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: string;
  /** A body too large to hold in memory (an image archive). The signature covers the request without a body: what the body is, is in the signed path. */
  stream?: Readable;
  /** Sign the request with the deploy secret instead of using the bearer token. */
  signed?: boolean;
  signal?: AbortSignal;
}

/** What it takes to talk to an agent. */
export type AgentConnection = Pick<ServerCredentials, "url" | "token" | "deploySecret" | "caCert" | "clientCert" | "clientKey">;

/** How requests reach the agent: over a connection pool to its URL, or over the connection it opened to this dashboard. */
export type AgentRoute = Agent | { relayServerId: string };

/** A client for one agent. Create it per request: it holds no state of its own. */
export class AgentClient {
  constructor(
    private readonly server: AgentConnection,
    private readonly via: AgentRoute,
    /** Who the agent's audit log names for what this client does: "dashboard", or "token:<name>" for an API token. */
    private readonly actor = "dashboard",
  ) {}

  /** Sends a request and returns the raw response; non-2xx answers become AgentError. */
  async raw(path: string, opts: RequestOptions = {}): Promise<Response> {
    const method = opts.method ?? "GET";
    const headers: Record<string, string> = {};
    if (opts.signed) {
      if (!this.server.deploySecret) throw new AgentError(0, "this server has no deploy secret");
      const ts = Math.floor(Date.now() / 1000);
      headers["X-Keelson-Timestamp"] = String(ts);
      headers["X-Keelson-Signature"] = sign(this.server.deploySecret, ts, method, path, opts.body ?? "");
      headers["X-Keelson-Actor"] = this.actor;
    } else {
      headers.Authorization = `Bearer ${this.server.token}`;
    }
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.stream) headers["Content-Type"] = "application/x-tar";

    let res: Response;
    try {
      res = await this.send(path, method, headers, opts);
    } catch (err) {
      if (err instanceof AgentError) throw err;
      if (err instanceof RelayError) throw new AgentError(err.status, err.status === 0 ? `cannot reach the agent: ${err.message}` : err.message);
      throw new AgentError(0, `cannot reach the agent: ${describeNetworkError(err)}`);
    }
    if (!res.ok) {
      let message = `the agent answered ${res.status}`;
      let body: unknown;
      try {
        body = await res.json();
        if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") {
          message = body.error;
        }
      } catch {
        /* keep the generic message */
      }
      throw new AgentError(res.status, message, body);
    }
    return res;
  }

  /** One request over this client's route; a failure is thrown as it came (RelayError or a network error). */
  private async send(path: string, method: string, headers: Record<string, string>, opts: RequestOptions): Promise<Response> {
    if ("relayServerId" in this.via) {
      // An image goes down the relay as a stream the machine fetches itself (a machine that cannot is told to update).
      return relayFetch(this.via.relayServerId, { method, path, headers, body: opts.body, stream: opts.stream, signal: opts.signal });
    }
    // undici and the DOM declare the same Response with different types.
    // An agent never redirects: following one would let a compromised or misconfigured agent bounce signed requests to
    // other hosts (SSRF), so a redirect is an error, as it already is for the relay and the enrolment.
    return (await undiciFetch(this.server.url + path, {
      method,
      headers,
      body: opts.stream ?? opts.body,
      // A streamed request body must say so.
      ...(opts.stream ? { duplex: "half" } : {}),
      dispatcher: this.via,
      redirect: "error",
      signal: opts.signal,
    } as Parameters<typeof undiciFetch>[1])) as unknown as Response;
  }

  private async json<T>(path: string, opts: RequestOptions = {}, check?: ContractCheck): Promise<T> {
    const signal = opts.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    // The agent is this project's own, versioned API: its answers are trusted to match lib/agent-types.ts. In
    // development `check` (lib/contract-shapes.ts) says on the console what an answer lacks, instead of an empty page.
    const body: unknown = await (await this.raw(path, { ...opts, signal })).json();
    if (check && process.env.NODE_ENV === "development") reportDrift(path, check(body));
    return body as T;
  }

  /** Public endpoint: true when the agent and its Docker engine answer. */
  async healthy(): Promise<boolean> {
    try {
      const signal = AbortSignal.timeout(4000);
      if ("relayServerId" in this.via) {
        const res = await relayFetch(this.via.relayServerId, { method: "GET", path: "/v1/health", headers: {}, signal });
        await res.body?.cancel();
        return res.ok;
      }
      const res = await undiciFetch(`${this.server.url}/v1/health`, { dispatcher: this.via, redirect: "error", signal });
      return res.ok;
    } catch {
      return false;
    }
  }

  info = () => this.json<AgentInfo>("/v1/info", {}, checkInfo);

  /** The machine and engine overview; null for an agent older than this endpoint. */
  async system(): Promise<SystemInfo | null> {
    try {
      return await this.json<SystemInfo>("/v1/system", {}, checkSystem);
    } catch (err) {
      if (err instanceof AgentError && err.status === 404) return null;
      throw err;
    }
  }

  /** The engine's disk accounting; null for an agent older than this endpoint. */
  async diskUsage(): Promise<DiskUsage | null> {
    try {
      return await this.json<DiskUsage>("/v1/system/disk", { signal: AbortSignal.timeout(DISK_USAGE_TIMEOUT_MS) });
    } catch (err) {
      if (err instanceof AgentError && err.status === 404) return null;
      throw err;
    }
  }
  containers = (all = true) => this.json<Container[]>(`/v1/containers?all=${all}`, {}, checkContainers);
  container = (name: string) => this.json<ContainerDetail>(`/v1/containers/${encodeURIComponent(name)}`);

  /**
   * Starts or restarts a container the agent manages (one with the keelson.app label). An agent older than these routes
   * answers with its router's plain-text 404, not the JSON error of a known route: that is told apart from "no such
   * container" so that the operator learns to update the agent.
   */
  async containerAction(name: string, action: "start" | "restart"): Promise<void> {
    try {
      await this.raw(`/v1/containers/${encodeURIComponent(name)}/${action}`, {
        method: "POST",
        body: "",
        signed: true,
        signal: AbortSignal.timeout(CONTAINER_ACTION_TIMEOUT_MS),
      });
    } catch (err) {
      const answered = err instanceof AgentError && typeof err.body === "object" && err.body !== null && "error" in err.body;
      if (err instanceof AgentError && err.status === 404 && !answered) throw new AgentError(404, AGENT_TOO_OLD_FOR_CONTAINER_ACTIONS);
      throw err;
    }
  }

  /** Apps exist only when the agent has deployments enabled; null otherwise. */
  async apps(): Promise<AppStatus[] | null> {
    try {
      return await this.json<AppStatus[]>("/v1/apps", {}, checkApps);
    } catch (err) {
      if (err instanceof AgentError && err.status === 404) return null;
      throw err;
    }
  }

  /** Recorded CPU and memory over `range` (such as "6h", at most 24h); null when the agent records none (no deployments, or older). */
  async statsHistory(container: string, range: string): Promise<StatsHistory | null> {
    try {
      return await this.json<StatsHistory>(`/v1/stats/history?container=${encodeURIComponent(container)}&range=${encodeURIComponent(range)}`);
    } catch (err) {
      if (err instanceof AgentError && err.status === 404) return null;
      throw err;
    }
  }

  /** The machine's load, memory and disk over `range` (such as "6h", at most 24h); null for an agent without deployments or older than the route. */
  async hostHistory(range: string): Promise<HostHistory | null> {
    try {
      return await this.json<HostHistory>(`/v1/stats/host?range=${encodeURIComponent(range)}`);
    } catch (err) {
      if (err instanceof AgentError && err.status === 404) return null;
      throw err;
    }
  }

  /** How much of `range` ("24h", "7d" or "30d") an app was up, with its incidents; null for an agent without deployments or older than the route. */
  async availability(app: string, range: string): Promise<AppAvailability | null> {
    try {
      return await this.json<AppAvailability>(`/v1/apps/${encodeURIComponent(app)}/availability?range=${encodeURIComponent(range)}`);
    } catch (err) {
      if (err instanceof AgentError && err.status === 404) return null;
      throw err;
    }
  }

  /** The notifications the agent raised, newest first; null for an agent older than the route or with deployments off. */
  async notificationHistory(limit = 200): Promise<AlertRecord[] | null> {
    try {
      return await this.json<AlertRecord[]>(`/v1/notifications/history?limit=${limit}`);
    } catch (err) {
      if (err instanceof AgentError && err.status === 404) return null;
      throw err;
    }
  }

  /** The reverse proxy; null when the agent has deployments off or no proxy configured. */
  async proxy(): Promise<ProxyView | null> {
    try {
      return await this.json<ProxyView>("/v1/proxy", {}, checkProxy);
    } catch (err) {
      if (err instanceof AgentError && err.status === 404) return null;
      throw err;
    }
  }

  deployments = (app?: string, limit = 20) =>
    this.json<Deployment[]>(`/v1/deployments?limit=${limit}${app ? `&app=${encodeURIComponent(app)}` : ""}`, {}, checkDeployments);
  deployment = (id: string) => this.json<Deployment>(`/v1/deployments/${encodeURIComponent(id)}`);

  async deploy(app: string, target: DeployTarget, trigger: "api" | "promotion" | "transfer" = "api"): Promise<string> {
    const body = JSON.stringify(trigger === "api" ? target : { ...target, trigger });
    const out = await this.json<{ deployment_id: string }>(`/v1/apps/${encodeURIComponent(app)}/deploy`, {
      method: "POST",
      body,
      signed: true,
    });
    return out.deployment_id;
  }

  async rollback(app: string): Promise<string> {
    const out = await this.json<{ deployment_id: string }>(`/v1/apps/${encodeURIComponent(app)}/rollback`, {
      method: "POST",
      body: "",
      signed: true,
    });
    return out.deployment_id;
  }

  /** The live preview environments; null for an agent without the previews API (older, or deployments off). */
  async previews(): Promise<Preview[] | null> {
    try {
      return (await this.json<{ previews: Preview[] }>("/v1/previews")).previews;
    } catch (err) {
      if (err instanceof AgentError && err.status === 404) return null;
      throw err;
    }
  }

  /** Creates the preview of pull request `pr` from the image tagged `sha`, or deploys it again; the deployment runs on after the answer. */
  deployPreview = (app: string, pr: number, sha: string) =>
    this.json<PreviewDeployment>(`/v1/previews/${encodeURIComponent(app)}/${pr}`, { method: "PUT", body: JSON.stringify({ tag: sha }), signed: true });

  /**
   * Builds the commit `sha` from the source the agent downloads, tags it `<image>:<sha>` and deploys it; the build and
   * deployment run on after the answer. Throws AgentError (400 when the app has no `build:`, 409 when busy). The token
   * is only sent to the agent; it is removed from any error message.
   */
  async build(app: string, sha: string, source: BuildSource): Promise<string> {
    const body = JSON.stringify({ sha, source: { url: source.url, token: source.token }, deploy: true });
    const out = await this.withoutToken(source.token, () =>
      this.json<{ deployment_id: string }>(`/v1/apps/${encodeURIComponent(app)}/build`, { method: "POST", body, signed: true }),
    );
    return out.deployment_id;
  }

  /** Creates the preview of pull request `pr` from a build of `sha`, or deploys it again; the build and deployment run on after the answer. */
  buildPreview = (app: string, pr: number, sha: string, source: BuildSource) =>
    this.withoutToken(source.token, () =>
      this.json<PreviewDeployment>(`/v1/previews/${encodeURIComponent(app)}/${pr}`, {
        method: "PUT",
        body: JSON.stringify({ sha, source: { url: source.url, token: source.token } }),
        signed: true,
      }),
    );

  /**
   * Builds `<request.image>:<request.sha>` from the source the agent downloads and keeps it on this server (nothing is
   * deployed here, no app is needed in its apps file); the build runs on after the answer. The request's own build
   * arguments win over this server's stored build variables for the app. Throws AgentError (400 for a request above the
   * server's build limits or a bad one, 409 when busy or when the name belongs to another app here). The token is only
   * sent to the agent; it is removed from any error message.
   */
  async startBuild(request: BuildRequestBody): Promise<string> {
    const out = await this.withoutToken(request.source.token, () =>
      this.json<{ deployment_id: string }>("/v1/builds", { method: "POST", body: JSON.stringify(request), signed: true }),
    );
    return out.deployment_id;
  }

  /**
   * The image `<image>:<tag>` as a tar archive, from this server (which must have built or received it, as any app).
   * The caller reads the body to its end; a short body is a failed transfer.
   */
  exportImageByRef = (ref: { image: string; tag: string }, signal?: AbortSignal) =>
    this.raw("/v1/images/export", { method: "POST", body: JSON.stringify(ref), signed: true, signal });

  /**
   * Gives this server the archive as the image of `app` at `tag`. `sha256` is the archive's hash, in the signed address:
   * the agent checks what it received against it before it loads anything. Throws AgentError (400 when the archive is not
   * exactly that one image, 409 while the app is deploying).
   */
  async importImage(app: string, tag: string, archive: { stream: Readable; sha256: string }, signal?: AbortSignal): Promise<void> {
    await this.raw(`/v1/apps/${encodeURIComponent(app)}/image/${encodeURIComponent(tag)}?sha256=${archive.sha256}`, { method: "PUT", stream: archive.stream, signed: true, signal });
  }

  private withoutToken<T>(token: string, run: () => Promise<T>): Promise<T> {
    return this.redacting([token], run);
  }

  /** Runs `run`; a failure whose message holds one of `secrets` comes out with it replaced (and without the answer's body). */
  private async redacting<T>(secrets: string[], run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (!(err instanceof AgentError)) throw err;
      const message = scrub(err.message, secrets);
      if (message !== err.message) throw new AgentError(err.status, message);
      throw err;
    }
  }

  /**
   * The managed environment variables of one scope of an app: names, times and flags, never values. Null for an agent
   * older than this API.
   */
  async envVars(app: string, scope: EnvScope): Promise<EnvVars | null> {
    try {
      return await this.json<EnvVars>(`/v1/apps/${encodeURIComponent(app)}/env?scope=${scope}`);
    } catch (err) {
      if (err instanceof AgentError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * Whether the agent has the managed-variables API. An agent that has it answers a request for an app it does not know
   * with a JSON error; an older one answers its router's plain 404. Throws what a request to the agent throws.
   */
  async supportsEnv(): Promise<boolean> {
    try {
      await this.raw("/v1/apps/keelson-probe/env?scope=app", { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      return true;
    } catch (err) {
      if (err instanceof AgentError && err.status === 404) return answeredWithError(err);
      throw err;
    }
  }

  /**
   * Sets and removes variables in one atomic change. The agent refuses what it cannot take (a bad key, a value too large,
   * too many variables) with the list of problems: that comes back as a result. The values are only in this request:
   * a failure message is cleaned of any of them, and nothing here logs them.
   */
  async setEnv(app: string, change: EnvChange): Promise<EnvSaveResult> {
    return this.putVariables(
      `/v1/apps/${encodeURIComponent(app)}/env`,
      change,
      AGENT_TOO_OLD_FOR_ENV,
    );
  }

  /** PUT of a change of stored variables: what `setEnv` and `setBuildVars` share. */
  private async putVariables(
    path: string,
    change: { set?: Record<string, string> },
    tooOld: string,
  ): Promise<EnvSaveResult> {
    const secrets = Object.values(change.set ?? {}).filter(
      (v) => v.length >= 4,
    );
    try {
      const out = await this.json<{ changed?: string[]; removed?: string[] }>(
        path,
        { method: "PUT", body: JSON.stringify(change), signed: true },
      );
      return {
        ok: true,
        changed: out.changed ?? [],
        removed: out.removed ?? [],
      };
    } catch (err) {
      if (!(err instanceof AgentError)) throw err;
      if (err.status === 400 && typeof err.body === "object" && err.body !== null) {
        const b = err.body as { message?: unknown; error?: unknown; issues?: unknown };
        const issues: EnvIssue[] = Array.isArray(b.issues)
          ? b.issues.flatMap((i: unknown) => {
              if (typeof i !== "object" || i === null) return [];
              const { key, message } = i as { key?: unknown; message?: unknown };
              return typeof message === "string" ? [{ key: typeof key === "string" ? key : "", message: scrub(message, secrets) }] : [];
            })
          : [];
        return { ok: false, message: scrub(typeof b.message === "string" ? b.message : err.message, secrets), issues };
      }
      if (err.status === 404 && !answeredWithError(err))
        throw new AgentError(404, tooOld);
      // Whatever else the agent said leaves without the body, and without any value it might have echoed.
      throw new AgentError(err.status, scrub(err.message, secrets));
    }
  }

  /** Removes every managed variable of one scope. */
  async deleteEnv(app: string, scope: EnvScope): Promise<void> {
    try {
      await this.raw(`/v1/apps/${encodeURIComponent(app)}/env?scope=${scope}`, { method: "DELETE", signed: true, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      if (err instanceof AgentError && err.status === 404 && !answeredWithError(err)) throw new AgentError(404, AGENT_TOO_OLD_FOR_ENV);
      throw err;
    }
  }

  /**
   * The build variables this server keeps for builds it runs for other servers, under the app's name: names and times,
   * never values. They are used by `POST /v1/builds` for an app of that name, whether or not it is in this server's apps
   * file. Null for an agent older than this API.
   */
  async buildVars(app: string): Promise<BuildVars | null> {
    try {
      return await this.json<BuildVars>(
        `/v1/build-vars/${encodeURIComponent(app)}`,
      );
    } catch (err) {
      if (
        err instanceof AgentError &&
        err.status === 404 &&
        !answeredWithError(err)
      )
        return null;
      throw err;
    }
  }

  /** Sets and removes build variables in one atomic change. Values are only in this request; a failure message is cleaned of them. */
  async setBuildVars(
    app: string,
    change: BuildVarsChange,
  ): Promise<EnvSaveResult> {
    return this.putVariables(
      `/v1/build-vars/${encodeURIComponent(app)}`,
      change,
      AGENT_TOO_OLD_FOR_BUILD_VARS,
    );
  }

  /** Removes every build variable kept for an app name; returns their names. */
  async deleteBuildVars(app: string): Promise<string[]> {
    try {
      const out = await this.json<{ removed?: string[] }>(
        `/v1/build-vars/${encodeURIComponent(app)}`,
        { method: "DELETE", signed: true },
      );
      return out.removed ?? [];
    } catch (err) {
      if (
        err instanceof AgentError &&
        err.status === 404 &&
        !answeredWithError(err)
      )
        throw new AgentError(404, AGENT_TOO_OLD_FOR_BUILD_VARS);
      throw err;
    }
  }

  /** The managed PostgreSQL of the server. Null for an agent older than this API. */
  async postgres(): Promise<ManagedPostgres | null> {
    try {
      return await this.json<ManagedPostgres>("/v1/postgres");
    } catch (err) {
      if (err instanceof AgentError && err.status === 404 && !answeredWithError(err)) return null;
      throw err;
    }
  }

  /**
   * Creates a database (and, the first time, the instance) for an app: idempotent. The answer holds `backup_key`, the
   * private key of the backups, once: the caller shows it and keeps it nowhere. The agent's refusals come back as an
   * AgentError with its message, which names no secret.
   */
  async createDatabase(req: ManagedDatabaseRequest): Promise<ManagedDatabaseResult> {
    return this.managedWrite("/v1/postgres/databases", { method: "POST", body: JSON.stringify(req), signed: true });
  }

  /** Drops a managed database and its role; `confirm` must be its name. The backups stay. */
  async dropDatabase(name: string, confirm: string): Promise<void> {
    await this.managedWrite(`/v1/postgres/databases/${encodeURIComponent(name)}`, { method: "DELETE", body: JSON.stringify({ confirm }), signed: true });
  }

  /** Gives the database's role a new password and stores the new URL; the app needs a deploy. */
  async rotateDatabasePassword(name: string): Promise<ManagedDatabaseResult> {
    return this.managedWrite(`/v1/postgres/databases/${encodeURIComponent(name)}/password`, { method: "POST", signed: true });
  }

  private async managedWrite<T = ManagedDatabaseResult>(path: string, init: { method: "POST" | "DELETE"; body?: string; signed: true }): Promise<T> {
    try {
      return await this.json<T>(path, init);
    } catch (err) {
      if (err instanceof AgentError && err.status === 404 && !answeredWithError(err)) throw new AgentError(404, AGENT_TOO_OLD_FOR_POSTGRES);
      throw err;
    }
  }

  /** Removes the preview of pull request `pr`; succeeds when it does not exist. */
  async deletePreview(app: string, pr: number): Promise<void> {
    await this.raw(`/v1/previews/${encodeURIComponent(app)}/${pr}`, { method: "DELETE", signed: true, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  }

  /** Scheduled jobs exist only when the agent has some configured; null otherwise. */
  async jobs(): Promise<JobStatus[] | null> {
    try {
      return await this.json<JobStatus[]>("/v1/jobs", {}, checkJobs);
    } catch (err) {
      if (err instanceof AgentError && err.status === 404) return null;
      throw err;
    }
  }

  jobRuns = (name: string, limit = 30) =>
    this.json<JobRun[]>(`/v1/jobs/${encodeURIComponent(name)}/runs?limit=${limit}`);

  async runJob(name: string): Promise<string> {
    const out = await this.json<{ run_id: string }>(`/v1/jobs/${encodeURIComponent(name)}/run`, {
      method: "POST",
      body: "",
      signed: true,
    });
    return out.run_id;
  }

  /** Databases exist only when the agent has an apps file; null otherwise. */
  async databases(): Promise<DatabaseStatus[] | null> {
    try {
      return await this.json<DatabaseStatus[]>("/v1/databases", {}, checkDatabases);
    } catch (err) {
      if (err instanceof AgentError && err.status === 404) return null;
      throw err;
    }
  }

  /** The server's version and the database's size, measured by the agent now (it caches the answer for a minute). */
  databaseLive = (name: string) =>
    this.json<DatabaseLive>(`/v1/databases/${encodeURIComponent(name)}/live`, { signal: AbortSignal.timeout(DATABASE_PROBE_TIMEOUT_MS) });

  /** The backups found at the destination, newest first. */
  databaseBackups = (name: string) => this.json<DatabaseBackup[]>(`/v1/databases/${encodeURIComponent(name)}/backups`);

  /** Recent restore runs, newest first, in the shape of job runs. */
  databaseRestores = (name: string) => this.json<JobRun[]>(`/v1/databases/${encodeURIComponent(name)}/restores`);

  async restoreDatabase(name: string, request: RestoreRequest): Promise<string> {
    const out = await this.json<{ run_id: string }>(`/v1/databases/${encodeURIComponent(name)}/restore`, {
      method: "POST",
      body: JSON.stringify(request),
      signed: true,
    });
    return out.run_id;
  }

  /** The latest successful proof per kind and subject (key, restore, alert); null for an agent older than the routes. */
  async proofs(): Promise<Proof[] | null> {
    try {
      return await this.json<Proof[]>("/v1/proofs", {}, checkProofs);
    } catch (err) {
      if (err instanceof AgentError && err.status === 404) return null;
      throw err;
    }
  }

  /** The restore tests of a database, newest first; null for an agent older than the route. */
  async restoreTests(name: string, limit = 5): Promise<RestoreTest[] | null> {
    try {
      return await this.json<RestoreTest[]>(`/v1/databases/${encodeURIComponent(name)}/restore-tests?limit=${limit}`);
    } catch (err) {
      if (err instanceof AgentError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * Whether the age secret key opens a backup (the agent decrypts only enough of it to authenticate it). The key travels
   * in the body and is scrubbed from any error that comes back.
   */
  async verifyKey(name: string, request: { identity: string; backup?: string }): Promise<KeyProof> {
    return this.redacting([request.identity], () =>
      this.readiness(() => this.json<KeyProof>(`/v1/databases/${encodeURIComponent(name)}/verify-key`, { method: "POST", body: JSON.stringify(request), signed: true, signal: AbortSignal.timeout(READINESS_TIMEOUT_MS) })),
    );
  }

  /** Starts a restore into a scratch database on the agent's server; the answer is the test's id, followed through `restoreTests`. */
  async startRestoreTest(name: string, request: { identity: string; backup?: string }): Promise<string> {
    const out = await this.redacting([request.identity], () =>
      this.readiness(() => this.json<{ test_id: string }>(`/v1/databases/${encodeURIComponent(name)}/restore-test`, { method: "POST", body: JSON.stringify(request), signed: true })),
    );
    return out.test_id;
  }

  /** Sends a test message through every configured channel and says how each one went. */
  testNotifications = () =>
    this.readiness(() => this.json<AlertTest>("/v1/notifications/test", { method: "POST", signed: true, signal: AbortSignal.timeout(READINESS_TIMEOUT_MS) }));

  /** An answer that is not JSON (the agent has no such route) says the agent is too old; the agent's own refusals keep their message. */
  private async readiness<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof AgentError && err.status === 404 && err.body === undefined) throw new AgentError(404, AGENT_TOO_OLD_FOR_READINESS);
      throw err;
    }
  }

  /** Configuration is editable only when the agent has an apps file; null otherwise. */
  async config(): Promise<ConfigDocument | null> {
    try {
      return await this.json<ConfigDocument>("/v1/config", {}, checkConfigDocument);
    } catch (err) {
      if (err instanceof AgentError && err.status === 404) return null;
      throw err;
    }
  }

  validateConfig = (content: string) =>
    this.json<ConfigValidation>("/v1/config/validate", { method: "POST", body: JSON.stringify({ content }), signed: true });

  saveConfig = (content: string, opts: SaveOptions) => this.save("/v1/config", "PUT", { content, ...opts });
  saveApp = (name: string, app: AppConfig, opts: SaveOptions) =>
    this.save(`/v1/config/apps/${encodeURIComponent(name)}`, "PUT", { app, ...opts });
  deleteApp = (name: string, opts: SaveOptions) => this.save(`/v1/config/apps/${encodeURIComponent(name)}`, "DELETE", opts);
  saveJob = (name: string, job: JobConfig, opts: SaveOptions) =>
    this.save(`/v1/config/jobs/${encodeURIComponent(name)}`, "PUT", { job, ...opts });
  deleteJob = (name: string, opts: SaveOptions) => this.save(`/v1/config/jobs/${encodeURIComponent(name)}`, "DELETE", opts);
  saveDatabase = (name: string, database: DatabaseConfig, opts: SaveOptions) =>
    this.save(`/v1/config/databases/${encodeURIComponent(name)}`, "PUT", { database, ...opts });
  deleteDatabase = (name: string, opts: SaveOptions) =>
    this.save(`/v1/config/databases/${encodeURIComponent(name)}`, "DELETE", opts);
  saveNotifications = (notifications: NotificationsConfig | null, opts: SaveOptions) =>
    this.save("/v1/config/notifications", "PUT", { notifications, ...opts });

  configVersions = (limit = 30) => this.json<ConfigVersion[]>(`/v1/config/versions?limit=${limit}`);
  configVersion = (id: number) => this.json<ConfigVersionContent>(`/v1/config/versions/${id}`);
  restoreConfigVersion = (id: number, opts: SaveOptions) => this.save(`/v1/config/versions/${id}/restore`, "POST", opts);

  /**
   * The projects that have their own file on this agent. null: the agent does not have per-project files (it answers 404 to
   * this route; one that has them answers an empty list when there are none).
   */
  async projectFiles(): Promise<ProjectFileSummary[] | null> {
    try {
      return await this.json<ProjectFileSummary[]>("/v1/projects");
    } catch (err) {
      if (err instanceof AgentError && err.status === 404) return null;
      throw err;
    }
  }

  /** One project's own file; null when there is none. */
  async projectConfig(name: string): Promise<ProjectConfigDocument | null> {
    try {
      return await this.json<ProjectConfigDocument>(`/v1/projects/${encodeURIComponent(name)}/config`, {}, checkProjectConfigDocument);
    } catch (err) {
      if (err instanceof AgentError && err.status === 404) return null;
      throw err;
    }
  }

  validateProjectConfig = (name: string, content: string) =>
    this.projectCall(() =>
      this.json<ConfigValidation>(`/v1/projects/${encodeURIComponent(name)}/config/validate`, {
        method: "POST",
        body: JSON.stringify({ content }),
        signed: true,
      }),
    );

  /** `base_hash` is the file's own hash; absent, the file is created. */
  saveProjectConfig = (name: string, content: string, opts: ProjectSaveOptions) =>
    this.projectCall(() => this.save(`/v1/projects/${encodeURIComponent(name)}/config`, "PUT", { content, ...opts }));

  /** Removes the project's file: its apps leave the configuration, which the agent asks to be acknowledged (`force`). */
  deleteProjectConfig = (name: string, opts: ProjectSaveOptions) =>
    this.projectCall(() => this.save(`/v1/projects/${encodeURIComponent(name)}/config`, "DELETE", opts));

  /** Moves a project's entities out of the apps file into its own. `dry_run` answers the plan and writes nothing. */
  async splitProject(name: string, opts: ProjectSaveOptions & { dry_run?: boolean }): Promise<SplitResult> {
    const answer = await this.projectCall(() =>
      this.attempt<{
        dry_run?: boolean;
        hash: string;
        file_hash?: string;
        version?: number;
        issues?: ConfigIssue[];
        plan: SplitPlan;
      }>(`/v1/projects/${encodeURIComponent(name)}/split`, "POST", opts),
    );
    if (!answer.ok) return answer;
    const b = answer.body;
    return { ok: true, dryRun: b.dry_run === true, hash: b.hash, fileHash: b.file_hash, version: b.version, issues: b.issues ?? [], plan: b.plan };
  }

  /** An agent without per-project files answers its router's plain 404 to the project routes; one that has them answers errors as JSON. */
  private async projectCall<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      if (err instanceof AgentError && err.status === 404 && !answeredWithError(err)) throw new AgentError(404, AGENT_TOO_OLD_FOR_PROJECT_FILES);
      throw err;
    }
  }

  audit = (limit = 50, before?: number) =>
    this.json<AuditEntry[]>(`/v1/audit?limit=${limit}${before === undefined ? "" : `&before=${before}`}`);

  /**
   * A configuration change. The agent refuses some of them for reasons the user can act on (invalid,
   * edited elsewhere, needs confirmation, busy): those come back as a result, not as an exception.
   */
  private async save(path: string, method: "PUT" | "POST" | "DELETE", body: object): Promise<SaveResult> {
    const answer = await this.attempt<{ hash: string; config_hash?: string; version?: number; issues?: ConfigIssue[] }>(path, method, body);
    if (!answer.ok) return answer;
    const b = answer.body;
    return { ok: true, hash: b.hash, ...(b.config_hash === undefined ? {} : { config_hash: b.config_hash }), version: b.version, issues: b.issues ?? [] };
  }

  /** The request of a configuration change: what the agent answered, or the refusal it gave for a reason the user can act on. */
  private async attempt<T>(path: string, method: "PUT" | "POST" | "DELETE", body: object): Promise<{ ok: true; body: T } | Extract<SaveResult, { ok: false }>> {
    try {
      const ok = await this.json<T>(path, { method, body: JSON.stringify(body), signed: true });
      return { ok: true, body: ok };
    } catch (err) {
      if (err instanceof AgentError && (err.status === 400 || err.status === 409) && typeof err.body === "object" && err.body !== null) {
        const b = err.body;
        const kind = "error" in b && typeof b.error === "string" ? b.error : "";
        if (kind === "invalid" || kind === "changed" || kind === "needs_acknowledgement" || kind === "busy") {
          return {
            ok: false,
            kind,
            message: "message" in b && typeof b.message === "string" ? b.message : undefined,
            issues: "issues" in b && Array.isArray(b.issues) ? (b.issues as ConfigIssue[]) : [],
            hash: "hash" in b && typeof b.hash === "string" ? b.hash : undefined,
          };
        }
      }
      throw err;
    }
  }

  /** Opens a Server-Sent Events stream, for relaying to the browser. */
  stream = (path: string, signal: AbortSignal) => this.raw(path, { signal });
}
