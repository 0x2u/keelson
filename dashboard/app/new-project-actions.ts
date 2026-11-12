"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { AgentError, agentFor, type AgentClient } from "@/lib/agent";
import { toChange } from "@/lib/env-core";
import { cleanDnsChoice, cleanVars, createProject, retryCreateProject, type DnsChoice, type ProjectDeps, type ProjectOutcome, type ProjectVar, type RetryStep } from "@/lib/new-project-core";
import { createImageProject, imageStepOf, retryImageProject, type ImageDeps, type ImageOutcome, type ImageProjectInput, type ImageStep } from "@/lib/new-project-image-core";
import { serverHostOf } from "@/lib/published-address-core";
import { audit } from "@/lib/auth/store";
import { manualMessage } from "@/lib/dns-record-core";
import { ensureDns, serverAddress } from "@/lib/domains";
import { githubBranches } from "@/lib/github";
import { canRunApps } from "@/lib/machine-core";
import { installationToken } from "@/lib/github-app";
import { RepoReadError, branchHead, detectRepo, type DockerfileCandidate } from "@/lib/github-detect";
import { parseRepo } from "@/lib/github-core";
import { startBuild } from "@/lib/github-webhook";
import { githubAppSummary, setAppRepo, setBuildModes } from "@/lib/integrations";
import type { ProjectSuggestion } from "@/lib/project-suggest-core";
import type { ReviewInput } from "@/lib/repo-detect-core";
import { getCredentials, type ServerCredentials } from "@/lib/servers";
import { clientInfo, requireSession } from "@/lib/session";
import { stepUpError } from "@/lib/step-up";
import * as stepUp from "@/lib/step-up-core";

const REFUSED = (detail: string): ProjectOutcome => ({
  steps: {
    config: { state: "failed", detail },
    database: { state: "todo", detail: "Not done." },
    env: { state: "todo", detail: "Not done." },
    link: { state: "todo", detail: "Not done." },
    dns: { state: "todo", detail: "Not done." },
    build: { state: "todo", detail: "Not started." },
  },
  issues: [],
});

function describe(err: unknown): string {
  return err instanceof AgentError ? err.message : "unexpected error talking to the agent";
}

/** What the steps do for real. The first build's token and the agent request go through the webhook's own code. */
function depsFor(serverId: string, repo: string, agent: AgentClient, ip: string, server: ServerCredentials): ProjectDeps {
  return {
    config: () => agent.config(),
    envSupported: () => agent.supportsEnv(),
    setEnv: async (app, vars) => {
      try {
        const edits = vars.map((v) => ({ key: v.key, value: v.value, build: v.build }));
        const result = await agent.setEnv(app, toChange("app", edits, [], []));
        return result.ok ? { ok: true } : { ok: false, error: result.message, issues: result.issues };
      } catch (err) {
        return { ok: false, error: describe(err), issues: [] };
      }
    },
    createDatabase: async (app) => {
      try {
        const r = await agent.createDatabase({ app });
        return {
          ok: true,
          database: {
            name: r.database.name,
            envKey: r.env_key,
            created: r.created,
            ...(r.backup_key ? { backupKey: r.backup_key, ...(r.backup_recipient ? { backupRecipient: r.backup_recipient } : {}) } : {}),
          },
        };
      } catch (err) {
        return { ok: false, error: describe(err) };
      }
    },
    saveApp: (name, app, opts) => agent.saveApp(name, app, opts),
    dns: async (hostname, choice) => {
      const address = await serverAddress(server);
      if (!choice.create) return { kind: "skipped", message: manualMessage(hostname, address.ok ? address.address : null) };
      return ensureDns(
        { hostname, address, proxied: choice.proxied, confirmReplace: choice.confirmReplace, allowPrivate: choice.allowPrivate },
        (event, detail) => audit(event, `${server.name}: ${detail}`, ip),
      );
    },
    check: async (review) => {
      try {
        await branchHead(repo, review.branch);
        return null;
      } catch (err) {
        return err instanceof RepoReadError ? err.message : "The repository could not be read.";
      }
    },
    link: (review) => {
      setAppRepo(serverId, review.name, { repo, branch: review.branch });
      setBuildModes(serverId, review.name, { onPush: review.buildOnPush, previews: review.previews });
    },
    firstBuild: async (review) => {
      let sha: string;
      try {
        sha = await branchHead(repo, review.branch);
      } catch (err) {
        return { ok: false, error: err instanceof RepoReadError ? err.message : "The repository could not be read." };
      }
      return startBuild({ serverId, app: review.name }, { repo, branch: review.branch, sha });
    },
    audit: (event, detail) => audit(event, detail, ip),
    describe,
  };
}

/** What a creation needs about its server and repository; the caller has checked the session and the unlock. */
async function prepare(serverId: string, repoText: string): Promise<{ repo: string; agent: AgentClient; where: string; ip: string; server: ServerCredentials } | ProjectOutcome> {
  const server = getCredentials(serverId);
  if (!server) return REFUSED("Unknown server.");
  if (!canRunApps(server)) return REFUSED("This server does not serve traffic, so a project cannot run on it.");
  if (!server.canDeploy) return REFUSED("This server is read-only here: add its deploy access in the server settings.");
  if (githubAppSummary() === null) return REFUSED("The GitHub App is not set up: connect GitHub in Integrations first.");
  const repo = parseRepo(repoText);
  if (!repo) return REFUSED("That is not a GitHub repository name.");
  return { repo, agent: agentFor(server), where: server.name, ip: (await clientInfo()).ip, server };
}

/**
 * Creates a project: writes the app into the agent's apps file, creates its database when asked, sets its variables,
 * links it, points its domain, starts its first build, then goes to the deployment. A step that fails leaves the ones
 * before it and says so; the outcome is returned for the page. The variables' values come in with the call and go to
 * the agent: the outcome, the audit log and every message name them, never show them.
 *
 * The page is not redirected while the operator still has to save the database's backup key, which exists only in
 * this answer: it shows the key, and the link to the deployment, itself.
 */
export async function createProjectAction(serverId: string, repoText: string, input: ReviewInput, dns: DnsChoice, vars: ProjectVar[] = [], database = false): Promise<ProjectOutcome> {
  // Creating a project writes an app (what runs, with which release steps and environment file) and sets its variables, and a
  // retry re-runs the steps after that write with the host name the browser sends: both need the unlock, like the same changes
  // made one by one in the app form and the variables page.
  await requireSession();
  const locked = await stepUpError(stepUp.projectCreation(typeof input?.name === "string" ? input.name.trim() : "", cleanVars(vars).length > 0), "creating a project");
  if (locked) return REFUSED(locked);
  const ready = await prepare(serverId, repoText);
  if ("steps" in ready) return ready;
  const out = await createProject(ready.repo, input, ready.where, depsFor(serverId, ready.repo, ready.agent, ready.ip, ready.server), cleanDnsChoice(dns), cleanVars(vars), database === true);
  revalidatePath(`/servers/${serverId}`, "layout");
  if (out.deploymentId && !out.database?.backupKey) redirect(`/servers/${encodeURIComponent(serverId)}/deployments/${encodeURIComponent(out.deploymentId)}`);
  return out;
}

/**
 * Retries the step that failed after the app was written (and goes on); nothing is written to the agent's configuration.
 * `keyHeld`: the page holds a backup key the operator has not saved yet, so it must not be navigated away from.
 */
export async function retryCreateProjectAction(
  serverId: string,
  repoText: string,
  input: ReviewInput,
  from: RetryStep,
  dns: DnsChoice,
  vars: ProjectVar[] = [],
  database = false,
  keyHeld = false,
): Promise<ProjectOutcome> {
  await requireSession();
  const locked = await stepUpError(stepUp.projectCreation(typeof input?.name === "string" ? input.name.trim() : "", cleanVars(vars).length > 0), "retrying the creation of a project");
  if (locked) return REFUSED(locked);
  const ready = await prepare(serverId, repoText);
  if ("steps" in ready) return ready;
  const out = await retryCreateProject(input, from, ready.where, depsFor(serverId, ready.repo, ready.agent, ready.ip, ready.server), cleanDnsChoice(dns), cleanVars(vars), database === true);
  revalidatePath(`/servers/${serverId}`, "layout");
  if (out.deploymentId && !out.database?.backupKey && keyHeld !== true) redirect(`/servers/${encodeURIComponent(serverId)}/deployments/${encodeURIComponent(out.deploymentId)}`);
  return out;
}

const REFUSED_IMAGE = (detail: string): ImageOutcome => ({ steps: REFUSED(detail).steps, issues: [] });

/** What a project from an image needs about its server; the caller has checked the session and the unlock. No GitHub is involved. */
function prepareImage(serverId: string): { agent: AgentClient; where: string; server: ServerCredentials } | ImageOutcome {
  const server = getCredentials(serverId);
  if (!server) return REFUSED_IMAGE("Unknown server.");
  if (!canRunApps(server)) return REFUSED_IMAGE("This server does not serve traffic, so a project cannot run on it.");
  if (!server.canDeploy) return REFUSED_IMAGE("This server is read-only here: add its deploy access in the server settings.");
  return { agent: agentFor(server), where: server.name, server };
}

/** What the steps do for real: the same agent calls as the repository door's, and the first deployment is the Deploy button's. */
function imageDepsFor(agent: AgentClient, ip: string, server: ServerCredentials): ImageDeps {
  const shared = depsFor(server.id, "", agent, ip, server);
  return {
    config: shared.config,
    envSupported: shared.envSupported,
    setEnv: shared.setEnv,
    saveApp: shared.saveApp,
    dns: shared.dns,
    audit: shared.audit,
    describe,
    deploy: async (app, target) => {
      try {
        return { ok: true, deploymentId: await agent.deploy(app, target) };
      } catch (err) {
        return { ok: false, error: describe(err) };
      }
    },
  };
}

/**
 * Creates a project from an image: writes the app into the agent's apps file, sets its variables, points its domain, and
 * starts the first deployment of the tag or digest that was typed. It does not redirect: the page says how to reach the
 * app and links the deployment. Writing the app and its variables is what the unlock is for, as for a repository.
 */
export async function createImageProjectAction(serverId: string, input: ImageProjectInput, dns: DnsChoice, vars: ProjectVar[] = []): Promise<ImageOutcome> {
  await requireSession();
  const locked = await stepUpError(stepUp.projectCreation(typeof input?.name === "string" ? input.name.trim() : "", cleanVars(vars).length > 0), "creating a project");
  if (locked) return REFUSED_IMAGE(locked);
  const ready = prepareImage(serverId);
  if ("steps" in ready) return ready;
  const out = await createImageProject(input, ready.where, imageDepsFor(ready.agent, (await clientInfo()).ip, ready.server), cleanDnsChoice(dns), cleanVars(vars), serverHostOf(ready.server));
  revalidatePath(`/servers/${serverId}`, "layout");
  return out;
}

/** Retries the step that failed after the app was written (and goes on); nothing is written to the agent's configuration. */
export async function retryImageProjectAction(serverId: string, input: ImageProjectInput, from: ImageStep, dns: DnsChoice, vars: ProjectVar[] = []): Promise<ImageOutcome> {
  await requireSession();
  const locked = await stepUpError(stepUp.projectCreation(typeof input?.name === "string" ? input.name.trim() : "", cleanVars(vars).length > 0), "retrying the creation of a project");
  if (locked) return REFUSED_IMAGE(locked);
  const ready = prepareImage(serverId);
  if ("steps" in ready) return ready;
  const out = await retryImageProject(input, imageStepOf(from), ready.where, imageDepsFor(ready.agent, (await clientInfo()).ip, ready.server), cleanDnsChoice(dns), cleanVars(vars), serverHostOf(ready.server));
  revalidatePath(`/servers/${serverId}`, "layout");
  return out;
}

/**
 * What the wizard learns about a repository when it is chosen: its Dockerfiles with their port and health check, and what
 * it suggests (a framework card, a release command, a database, the variables its example file lists). Read-only, with
 * an installation token for that repository; nothing is applied from here.
 */
export type RepoInspection = { ok: true; candidates: DockerfileCandidate[]; truncated: boolean; suggestion: ProjectSuggestion; branches: string[] } | { ok: false; error: string };

/** The repository's branches for the wizard's menu; an empty list (and a typed branch) when GitHub does not give them. */
async function listBranches(repo: string): Promise<string[]> {
  try {
    return await githubBranches(await installationToken(repo), repo);
  } catch {
    return [];
  }
}

export async function inspectRepoAction(repoText: string): Promise<RepoInspection> {
  await requireSession();
  const repo = parseRepo(repoText);
  if (!repo) return { ok: false, error: "That is not a GitHub repository name." };
  if (githubAppSummary() === null) return { ok: false, error: "The GitHub App is not set up: connect GitHub in Integrations first." };
  try {
    const [found, branches] = await Promise.all([detectRepo(repo), listBranches(repo)]);
    return { ok: true, candidates: found.candidates, truncated: found.truncated, suggestion: found.suggestion, branches };
  } catch (err) {
    return { ok: false, error: err instanceof RepoReadError ? err.message : "Something went wrong reading the repository. Try again." };
  }
}
