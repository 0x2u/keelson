/**
 * "New project > From an image": a project that runs a ready-made image (a public one from Docker Hub, one from a
 * registry the agent has the credentials of) instead of one built from a repository. The steps are the repository
 * door's without the repository: write the app into the agent's apps file, set its variables, point its domain, start
 * the first deployment of the tag or digest that was typed (the same agent call as the Deploy button). Nothing is rolled
 * back when a step fails; the outcome says exactly what is done. No network here: the agent and the DNS are injected.
 */

import type { AppConfig, ConfigDocument, DeployTarget, SaveResult } from "@/lib/agent-types";
import { deployTargetOf } from "@/lib/deploy-target";
import {
  describeRefusal,
  dnsBefore,
  outcome,
  recordFailure,
  runDns,
  runEnv,
  varProblems,
  type DnsChoice,
  type ProjectDeps,
  type ProjectOutcome,
  type ProjectVar,
  type RetryStep,
  type StepName,
  type StepStatus,
} from "@/lib/new-project-core";
import { AGENT_TOO_OLD_FOR_ENV } from "@/lib/env-core";
import { localAddress, type LocalAddress } from "@/lib/published-address-core";
import { APP_NAME, reviewContext, type ReviewContext } from "@/lib/repo-detect-core";

/** The form as the browser sends it: every value is text. */
export interface ImageProjectInput {
  name: string;
  /** The image with what picks its version, as typed: `traefik/whoami:v1.10.3` or `ghcr.io/acme/web@sha256:...`. */
  image: string;
  /** The port the container listens on; blank when it publishes nothing. */
  port: string;
  /** A host name served by the server's proxy; blank for none (the app is then on a local port, or on none). */
  domain: string;
  /** The port on the server a container port is published on, when there is no domain. */
  hostPort: string;
  /** A local port on every interface of the server instead of on 127.0.0.1 only. */
  open: boolean;
  healthPath: string;
}

export type ImageProjectField = keyof ImageProjectInput;
export type ImageProjectErrors = Partial<Record<ImageProjectField, string>>;

/** The server's own page of the configuration says what the form depends on: names, domains, ports, proxy. */
export type ImageContext = ReviewContext;

export type ImageExposure = { kind: "domain"; domain: string } | { kind: "local"; hostPort: number; open: boolean } | { kind: "none" };

/** What was decided, validated: the app that is written and the version that is deployed. */
export interface ImageReview {
  name: string;
  /** The repository the app is stored with: no tag, no digest (each deployment chooses the version). */
  repository: string;
  /** What the first deployment is asked for. */
  target: DeployTarget;
  /** The tag or the digest as typed, for the sentences. */
  version: string;
  port: number | null;
  exposure: ImageExposure;
  healthPath: string;
}

export type ImageResult = { ok: true; review: ImageReview } | { ok: false; errors: ImageProjectErrors };

const IMAGE_EXAMPLE = "traefik/whoami:v1.10.3";
// A registry host (with an optional port), then lower-case path components, as Docker reads a name.
const REPOSITORY = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const HOST_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/**
 * Reads what was typed in the image field: the repository the app keeps, and the tag or digest the first deployment
 * asks for. The version is required: the Deploy button of the app asks for an exact version too, and `latest` moves.
 */
export function parseImage(text: string): { ok: true; repository: string; target: DeployTarget; version: string } | { ok: false; error: string } {
  const typed = text.trim();
  if (typed === "") return { ok: false, error: `Enter the image with its tag, for example ${IMAGE_EXAMPLE}.` };
  if (/\s/.test(typed)) return { ok: false, error: "An image name has no spaces." };
  let rest = typed;
  let digest: string | undefined;
  const at = rest.indexOf("@");
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!DIGEST.test(digest)) return { ok: false, error: "A digest is sha256: followed by 64 hexadecimal characters." };
  }
  let tag: string | undefined;
  const colon = rest.lastIndexOf(":");
  if (colon > rest.lastIndexOf("/")) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    if (tag === "") return { ok: false, error: `The tag after the colon is empty. Write it like ${IMAGE_EXAMPLE}.` };
  }
  if (!REPOSITORY.test(rest)) return { ok: false, error: `"${rest}" is not an image name Docker accepts: lower-case letters, digits, . _ - and / (a registry host may come first, such as ghcr.io/acme/web).` };
  if (digest === undefined && tag === undefined) {
    return { ok: false, error: `Add the version to deploy: a tag (${rest}:1.2.3) or a digest (${rest}@sha256:...). The app is then deployed exactly that, and the Deploy button asks for another one later.` };
  }
  // A digest is exact: it wins over a tag written beside it.
  const target = digest !== undefined ? deployTargetOf(digest) : deployTargetOf(tag!);
  if (target === null) return { ok: false, error: "A tag has letters, digits, . _ and -, up to 128 characters, and does not start with . or -." };
  return { ok: true, repository: rest, target, version: digest ?? tag! };
}

/** A name for the project from its image: the last part of the repository, as an app name. */
export function suggestImageName(image: string, existing: readonly string[]): string {
  const parsed = parseImage(image);
  const repository = parsed.ok ? parsed.repository : image.trim().replace(/[:@].*$/, "");
  const last = repository.slice(repository.lastIndexOf("/") + 1).toLowerCase();
  const base =
    last
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 53)
      .replace(/-+$/, "") || "app";
  const used = new Set(existing);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base.slice(0, 51)}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

function portNumber(text: string): number | null {
  if (!/^[0-9]{1,5}$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= 1 && n <= 65535 ? n : null;
}

/** The domain only counts where the proxy can serve it; the health path only with a domain (the agent ignores it otherwise). */
export function imageEffective(input: ImageProjectInput): ImageProjectInput {
  const domain = input.domain.trim().toLowerCase();
  return { ...input, domain, healthPath: domain === "" ? "" : input.healthPath };
}

/** Checks the form against the agent's rules and what its configuration holds. Every problem is reported, by field. */
export function validateImageProject(raw: ImageProjectInput, context: ImageContext): ImageResult {
  const input = imageEffective(raw);
  const errors: ImageProjectErrors = {};
  const name = input.name.trim();
  if (!APP_NAME.test(name) || name.length > 63) errors.name = "Use lowercase letters and digits, with single dashes or underscores between them (up to 63 characters).";
  else if (context.existingNames.includes(name)) errors.name = `This server already has an app named ${name}. Choose another name.`;

  const image = parseImage(input.image);
  if (!image.ok) errors.image = image.error;

  const portText = input.port.trim();
  const port = portText === "" ? null : portNumber(portText);
  if (portText !== "" && port === null) errors.port = "The port is a number from 1 to 65535.";

  let exposure: ImageExposure | null = null;
  if (input.domain !== "") {
    if (context.proxy !== "caddy") errors.domain = context.proxy === "none" ? "This server's agent has no proxy section, so it cannot serve a domain: leave it empty to use a local port." : "A domain is only offered with the Caddy proxy; this server uses another one.";
    else if (!HOST_NAME.test(input.domain)) errors.domain = "That is not a valid host name, such as app.example.com.";
    else if (context.usedDomains.includes(input.domain)) errors.domain = `Another app of this server already serves ${input.domain}.`;
    else if (port === null && errors.port === undefined) errors.port = "A domain needs the port the container listens on.";
    else exposure = { kind: "domain", domain: input.domain };
  } else if (port === null) {
    if (errors.port === undefined) exposure = { kind: "none" };
  } else {
    const hostPort = portNumber(input.hostPort);
    if (hostPort === null) errors.hostPort = "The local port is a number from 1 to 65535.";
    else if (context.usedHostPorts.includes(hostPort)) errors.hostPort = `Port ${hostPort} is already used by another app of this server.`;
    else exposure = { kind: "local", hostPort, open: input.open };
  }

  const healthPath = input.healthPath.trim();
  if (healthPath !== "" && (!healthPath.startsWith("/") || /\s/.test(healthPath) || healthPath.length > 200)) errors.healthPath = "The health path starts with / and has no spaces, such as /healthz.";

  if (Object.keys(errors).length > 0 || !image.ok || exposure === null) return { ok: false, errors };
  return { ok: true, review: { name, repository: image.repository, target: image.target, version: image.version, port, exposure, healthPath } };
}

/**
 * The app the agent is asked to store: the image repository, how it is reached, and that it comes back after a reboot.
 * A published port belongs to an in-place app (no `port`, no domain: the agent chooses that strategy itself).
 */
export function buildImageApp(review: ImageReview): AppConfig {
  const app: AppConfig = { name: review.name, image: review.repository, restart: "unless-stopped" };
  if (review.exposure.kind === "domain") {
    app.port = review.port!;
    app.domains = [review.exposure.domain];
    if (review.healthPath !== "") app.health_path = review.healthPath;
  } else if (review.exposure.kind === "local") {
    app.publish = [`${review.exposure.open ? "0.0.0.0" : "127.0.0.1"}:${review.exposure.hostPort}:${review.port}`];
  }
  return app;
}

// ---- reaching the app ----

/** How to open the app once it runs, for the screen that follows the creation. */
export type Reach = { kind: "domain"; url: string } | ({ kind: "local" } & LocalAddress) | { kind: "none" };

/** What to tell about reaching the app: its domain, or the local address the agent publishes (the port on 127.0.0.1 or on every interface). */
export function reachOf(review: ImageReview, host: string | null): Reach {
  if (review.exposure.kind === "domain") return { kind: "domain", url: `https://${review.exposure.domain}` };
  if (review.exposure.kind === "none") return { kind: "none" };
  return { kind: "local", ...localAddress(review.exposure.hostPort, !review.exposure.open, host) };
}

// ---- creating ----

/** What creating an image project needs from outside: the agent, the DNS, the audit log. */
export type ImageDeps = Pick<ProjectDeps, "config" | "saveApp" | "envSupported" | "setEnv" | "dns" | "audit" | "describe"> & {
  /** Starts the first deployment of the tag or digest, like the Deploy button; says which deployment to watch. Never throws. */
  deploy(app: string, target: DeployTarget): Promise<{ ok: true; deploymentId: string } | { ok: false; error: string }>;
};

/** The steps of this door that can be retried: the ones after the app is written (the repository's database and link do not exist here). */
export type ImageStep = Extract<RetryStep, "env" | "dns" | "build">;

/** The step to retry as a client sent it: anything but dns and build is the variables, the first step after the write. */
export function imageStepOf(raw: unknown): ImageStep {
  return raw === "dns" || raw === "build" ? raw : "env";
}

/** An outcome of this door: the steps are the repository door's, with the repository's own (database, link) never run. */
export interface ImageOutcome extends ProjectOutcome {
  /** The form was refused before anything was written: the problems by field. */
  imageErrors?: ImageProjectErrors;
  retry?: ImageStep;
  /** How to open the app, once the deployment started. */
  reach?: Reach;
}

const NOT_USED: StepStatus = { state: "skipped", detail: "Not used for an image." };

/** The outcome as this door shows it; `extra` only ever carries an ImageStep as its retry, so the narrower type holds. */
const imageOutcome = (steps: Partial<Record<StepName, StepStatus>>, extra: Partial<ImageOutcome> = {}): ImageOutcome => outcome({ database: NOT_USED, link: NOT_USED, ...steps }, extra) as ImageOutcome;

/** The steps after the app is written, from `from` on; an earlier one is reported as it stands. Stops at the first that fails. */
async function afterWrite(review: ImageReview, from: ImageStep, deps: ImageDeps, issues: ImageOutcome["issues"], where: string, choice: DnsChoice, vars: ProjectVar[], host: string | null): Promise<ImageOutcome> {
  const steps: Partial<Record<StepName, StepStatus>> = { config: { state: "done", detail: `${review.name} is in the server's configuration.` } };
  const order: readonly ImageStep[] = ["env", "dns", "build"];
  const reached = (name: ImageStep) => order.indexOf(name) >= order.indexOf(from);
  const finish = (extra: Partial<ImageOutcome> = {}) => imageOutcome(steps, { issues, ...extra });

  if (reached("env")) {
    const ran = await runEnv(review, vars, deps, where);
    steps.env = ran.step;
    if (ran.step.state === "failed") return finish({ retry: "env", ...(ran.issues && ran.issues.length > 0 ? { varIssues: ran.issues } : {}) });
  } else {
    steps.env = vars.length === 0 ? { state: "skipped", detail: "No variables." } : { state: "done", detail: "The variables were set earlier." };
  }

  if (reached("dns")) {
    const ran = await runDns(review, choice, deps, where);
    steps.dns = ran.step;
    if (ran.step.state === "failed") return finish({ retry: "dns", ...(ran.problem ? { dnsProblem: ran.problem } : {}) });
  } else {
    steps.dns = dnsBefore(review, choice);
  }

  const started = await deps.deploy(review.name, review.target);
  if (!started.ok) {
    await recordFailure(deps, "first_deploy_failed", `${where}: ${review.name}: ${started.error}`);
    steps.build = { state: "failed", detail: started.error };
    return finish({ retry: "build" });
  }
  await deps.audit("first_deploy_started", `${where}: ${review.name} -> ${review.repository}:${review.version}, deployment ${started.deploymentId}`);
  steps.build = { state: "done", detail: `The first deployment of ${review.version} started.` };
  return finish({ deploymentId: started.deploymentId, reach: reachOf(review, host) });
}

/**
 * Creates the project: checks the form against the agent's configuration, writes the app (never over an existing one: the
 * name is refused; the write carries the hash that was read, so a change made meanwhile is refused), sets its variables,
 * points its domain, and starts the first deployment.
 */
export async function createImageProject(input: ImageProjectInput, where: string, deps: ImageDeps, dns: DnsChoice, vars: ProjectVar[], host: string | null): Promise<ImageOutcome> {
  let doc: ConfigDocument | null;
  try {
    doc = await deps.config();
  } catch (err) {
    return imageOutcome({ config: { state: "failed", detail: `The agent's configuration could not be read: ${deps.describe(err)}` } });
  }
  if (doc === null) return imageOutcome({ config: { state: "failed", detail: "This server has no configuration to write to: it is read-only." } });
  if (doc.error) return imageOutcome({ config: { state: "failed", detail: `The agent's configuration file is currently invalid: ${doc.error}` } });

  const checked = validateImageProject(input, reviewContext(doc.model));
  const problems = varProblems({ preset: "", exposure: imageEffective(input).domain === "" ? "local" : "domain" }, vars);
  if (!checked.ok || problems.length > 0) return imageOutcome({}, { ...(checked.ok ? {} : { imageErrors: checked.errors }), ...(problems.length > 0 ? { varIssues: problems } : {}) });
  const review = checked.review;

  if (vars.length > 0) {
    let supported: boolean;
    try {
      supported = await deps.envSupported();
    } catch (err) {
      return imageOutcome({ config: { state: "failed", detail: `Nothing was written. The agent could not be asked about variables: ${deps.describe(err)}` } });
    }
    if (!supported) return imageOutcome({ config: { state: "failed", detail: `Nothing was written. ${AGENT_TOO_OLD_FOR_ENV}` } });
  }

  let saved: SaveResult;
  try {
    saved = await deps.saveApp(review.name, buildImageApp(review), { base_hash: doc.hash, comment: `Created from the image ${review.repository} by the dashboard` });
  } catch (err) {
    return imageOutcome({ config: { state: "failed", detail: `The agent could not be asked to write the app: ${deps.describe(err)}` } });
  }
  if (!saved.ok) return imageOutcome({ config: { state: "failed", detail: describeRefusal(saved) } }, { issues: saved.issues });

  await deps.audit("app_created_from_image", `${where}: ${review.name} <- ${review.repository}:${review.version}`);
  return afterWrite(review, "env", deps, saved.issues, where, dns, vars, host);
}

/**
 * Retries the step that failed after the app was written; it goes on to the steps after it. The app must still be in the
 * agent's configuration: nothing is written here. The variables come again from the browser: nothing kept them.
 */
export async function retryImageProject(input: ImageProjectInput, from: ImageStep, where: string, deps: ImageDeps, dns: DnsChoice, vars: ProjectVar[], host: string | null): Promise<ImageOutcome> {
  const name = input.name.trim();
  let doc: ConfigDocument | null;
  try {
    doc = await deps.config();
  } catch (err) {
    return imageOutcome({ config: { state: "done", detail: "The app was written earlier." }, [from]: { state: "failed", detail: `The agent could not be read to retry: ${deps.describe(err)}` } }, { retry: from });
  }
  if (doc === null || !(doc.model.apps ?? []).some((a) => a.name === name)) {
    return imageOutcome({ config: { state: "failed", detail: `${name} is not in the agent's configuration any more: create it again.` } });
  }
  // The app is written: it must not clash with itself.
  const others = reviewContext({ ...doc.model, apps: (doc.model.apps ?? []).filter((a) => a.name !== name) });
  const checked = validateImageProject(input, others);
  const problems = varProblems({ preset: "", exposure: imageEffective(input).domain === "" ? "local" : "domain" }, vars);
  if (!checked.ok || problems.length > 0) {
    return imageOutcome({ config: { state: "done", detail: "The app was written earlier." } }, { ...(checked.ok ? {} : { imageErrors: checked.errors }), ...(problems.length > 0 ? { varIssues: problems } : {}), retry: from });
  }
  return afterWrite(checked.review, from, deps, [], where, dns, vars, host);
}
