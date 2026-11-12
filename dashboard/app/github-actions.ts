"use server";

import { revalidatePath } from "next/cache";
import { AgentError, agentFor } from "@/lib/agent";
import type { DeployState } from "@/app/actions";
import { audit } from "@/lib/auth/store";
import { GithubError, githubAccount, githubBranches, githubCommits } from "@/lib/github";
import { GithubAppError, githubAppSlug, installationToken, installationTokens, invalidateInstalledRepos } from "@/lib/github-app";
import { isAppId, isAppSlug, parsePrivateKey } from "@/lib/github-app-core";
import { isBranchName, parseRepo } from "@/lib/github-core";
import { previewName, validPullRequest } from "@/lib/github-webhook-core";
import { requestBuild } from "@/lib/build-request";
import {
  getAppRepo,
  githubAppSummary,
  githubConnection,
  regenerateWebhookSecret,
  removeAppRepo,
  removeGithubApp,
  removeGithubConnection,
  removeWebhookSecret,
  saveGithubApp,
  saveGithubConnection,
  setAppRepo,
  setAutoDeployWorkflow,
  setBuildModes,
  setBuildOn,
  setPreviewsWorkflow,
  webhookSecretSince,
} from "@/lib/integrations";
import { buildChoices } from "@/lib/build-elsewhere-core";
import { statsFromSystem } from "@/lib/server-stats-core";
import { getCredentials, getServer } from "@/lib/servers";
import { clientInfo, requireSession } from "@/lib/session";
import { stepUpError } from "@/lib/step-up";
import * as stepUp from "@/lib/step-up-core";

export interface GithubState {
  error?: string;
  ok?: boolean;
  /** Something that succeeded only in part, to be shown next to the success. */
  notice?: string;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function describe(err: unknown): string {
  return err instanceof GithubError || err instanceof GithubAppError ? err.message : "Something went wrong. Try again.";
}

async function record(event: string, detail?: string): Promise<void> {
  audit(event, detail, (await clientInfo()).ip);
}

/** Connects (or replaces) the GitHub token after GitHub has accepted it. The token itself is never logged. */
export async function connectGithubAction(_prev: GithubState, form: FormData): Promise<GithubState> {
  await requireSession();
  const token = text(form, "token");
  if (token === "") return { error: "Paste a token." };
  if (token.length > 255 || /\s/.test(token)) return { error: "That does not look like a GitHub token." };
  let account: string;
  try {
    account = await githubAccount(token);
  } catch (err) {
    return { error: describe(err) };
  }
  saveGithubConnection(token, account);
  await record("github_connected", account);
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function disconnectGithubAction(): Promise<void> {
  await requireSession();
  removeGithubConnection();
  await record("github_disconnected");
  revalidatePath("/", "layout");
}

/** Links an app to the repository it is built from, once GitHub has shown that the token can read it. */
export async function linkRepoAction(serverId: string, app: string, _prev: GithubState, form: FormData): Promise<GithubState> {
  await requireSession();
  if (!getServer(serverId)) return { error: "Unknown server." };
  const connection = githubConnection();
  if (!connection && githubAppSummary() === null) return { error: "Connect GitHub in Settings first." };
  const repo = parseRepo(text(form, "repo"));
  if (!repo) return { error: "Enter the repository as owner/name, or paste its GitHub address." };
  const branch = text(form, "branch") || "main";
  if (!isBranchName(branch)) return { error: "That is not a valid branch name." };
  // Which repository and branch an app is built from decides what it runs: pointing it elsewhere needs the unlock.
  const current = getAppRepo(serverId, app);
  if (current?.repo !== repo || current.branch !== branch) {
    const locked = await stepUpError(stepUp.repoLink(app, repo, branch), `linking ${app} to ${repo}@${branch}`);
    if (locked) return { error: locked };
  }
  try {
    // Without a token, the GitHub App's installation proves that the repository is reachable.
    await githubCommits(connection?.token ?? (await installationToken(repo)), repo, branch);
  } catch (err) {
    return { error: describe(err) };
  }
  setAppRepo(serverId, app, { repo, branch });
  await record("repo_linked", `${app} -> ${repo}@${branch}`);
  revalidatePath(`/servers/${serverId}`, "layout");
  return { ok: true };
}

/**
 * The branches of a repository, for the link dialog's menu: read with the connected token, or with the GitHub App's
 * installation token when only the App is set up. An error comes back as a message, never thrown: the dialog then lets
 * the branch be typed.
 */
export async function repoBranchesAction(repo: string): Promise<{ branches: string[]; error?: string }> {
  await requireSession();
  const name = parseRepo(repo);
  if (!name) return { branches: [], error: "That is not a repository name." };
  try {
    const token = githubConnection()?.token ?? (await installationToken(name));
    return { branches: await githubBranches(token, name) };
  } catch (err) {
    return { branches: [], error: describe(err) };
  }
}

export async function unlinkRepoAction(serverId: string, app: string): Promise<void> {
  await requireSession();
  const link = getAppRepo(serverId, app);
  removeAppRepo(serverId, app);
  if (link) await record("repo_unlinked", `${app} -> ${link.repo}`);
  revalidatePath(`/servers/${serverId}`, "layout");
}

/**
 * Chooses where an app is built: on its own server (the form sends nothing), or on another server, which builds it as a
 * request (`POST /v1/builds`) and has the image sent to the app's server. The choice is a server id from the list the page
 * showed; it is checked again here against what the server says now (it answers, has builds, and accepts the app's build:
 * block within its limits).
 */
export async function setBuildServerAction(serverId: string, app: string, _prev: GithubState, form: FormData): Promise<GithubState> {
  await requireSession();
  const link = getAppRepo(serverId, app);
  if (!link) return { error: "Link this app to its repository first." };
  const choice = text(form, "builder");
  if (choice === "") {
    setBuildOn(serverId, app, null);
    if (link.buildOn) await record("build_server_set", `${app}: built on its own server`);
    revalidatePath(`/servers/${serverId}`, "layout");
    return { ok: true };
  }
  const own = getCredentials(serverId);
  const builder = choice === serverId ? null : getCredentials(choice);
  if (!own || !builder) return { error: "That server is not registered in this dashboard any more." };
  const locked = await stepUpError(stepUp.buildServer(builder.name), `building ${app} on ${builder.name}`);
  if (locked) return { error: locked };
  let found;
  try {
    found = await Promise.all([agentFor(own).config(), agentFor(own).system(), agentFor(builder).system()]);
  } catch (err) {
    return { error: `Could not ask the servers: ${err instanceof AgentError ? err.message : "unexpected error"}` };
  }
  const [doc, ownSystem, system] = found;
  const block = doc?.model.apps?.find((a) => a.name === app)?.build;
  const [verdict] = buildChoices([{ id: builder.id, name: builder.name, canDeploy: builder.canDeploy, stats: statsFromSystem(system) }], block, ownSystem?.arch);
  if (verdict.disabled !== null) return { error: verdict.disabled };
  setBuildOn(serverId, app, builder.id);
  await record("build_server_set", `${app}: built on ${builder.name}`);
  revalidatePath(`/servers/${serverId}`, "layout");
  return { ok: true };
}

/**
 * Has the app's agent build a commit of the linked repository and deploy it, with the GitHub App's installation token:
 * the commit in `sha`, or the head of the linked branch when the form has none. The agent needs a `build:` block.
 */
export async function buildAction(serverId: string, app: string, _prev: DeployState, form: FormData): Promise<DeployState> {
  await requireSession();
  const requested = text(form, "sha");
  const built = await requestBuild(serverId, app, requested === "" ? null : requested);
  // A request that never reached the agents (not linked, a bad SHA, GitHub unreachable) changed nothing: nothing to audit.
  if (!built.ok && !built.asked) return { error: built.error };
  const link = getAppRepo(serverId, app);
  await record("build_started", `${app} <- ${link?.repo ?? "?"}@${(built.ok ? built.sha : requested).slice(0, 7)}${built.ok ? "" : " (refused)"}`);
  revalidatePath(`/servers/${serverId}`, "layout");
  return built.ok ? { deploymentId: built.deploymentId, serverId: built.serverId } : { error: built.error };
}

const PRIVATE_KEY_MAX = 16 * 1024;

/**
 * Saves (or replaces) the GitHub App's credentials after GitHub has accepted them: the App ID, its private key and,
 * when the form has none, the slug GitHub reports. The key is write-only: it is never returned, shown or logged.
 */
export async function saveGithubAppAction(_prev: GithubState, form: FormData): Promise<GithubState> {
  await requireSession();
  const locked = await stepUpError(stepUp.githubApp(), "saving the GitHub App");
  if (locked) return { error: locked };
  const appId = text(form, "appId");
  const privateKey = text(form, "privateKey");
  let slug = text(form, "slug");
  if (!isAppId(appId)) return { error: "The App ID is the number at the top of the App's settings page on GitHub." };
  if (privateKey === "") return { error: "Paste the private key (the whole .pem file)." };
  if (privateKey.length > PRIVATE_KEY_MAX) return { error: "That does not look like a private key." };
  if (slug !== "" && !isAppSlug(slug)) return { error: "The App's name in its GitHub address (github.com/apps/<name>) uses letters, digits and dashes." };
  try {
    parsePrivateKey(privateKey);
    const known = await githubAppSlug(appId, privateKey);
    if (slug === "") slug = known;
  } catch (err) {
    return { error: err instanceof Error && !(err instanceof GithubAppError) ? err.message : describe(err) };
  }
  saveGithubApp({ appId, slug: slug === "" ? null : slug, privateKey });
  installationTokens.clear();
  invalidateInstalledRepos();
  await record("github_app_saved", `App ${appId}`);
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Removes the App's credentials; every app's builds are turned off with it. */
export async function removeGithubAppAction(): Promise<void> {
  await requireSession();
  const had = githubAppSummary();
  removeGithubApp();
  installationTokens.clear();
  invalidateInstalledRepos();
  if (had) await record("github_app_removed", `App ${had.appId}`);
  revalidatePath("/", "layout");
}

/**
 * Turns the GitHub App builds of a linked app on or off: `onPush` (a push to the linked branch builds and deploys)
 * and `previews` (a pull request of the same repository builds and deploys its preview). Turning one on needs the App.
 */
export async function setBuildModesAction(serverId: string, app: string, _prev: GithubState, form: FormData): Promise<GithubState> {
  await requireSession();
  const link = getAppRepo(serverId, app);
  if (!link) return { error: "Link this app to a repository first." };
  const onPush = form.get("onPush") === "on";
  const previews = form.get("previews") === "on";
  if ((onPush && !link.buildOnPush) || (previews && !link.buildPreviews)) {
    if (githubAppSummary() === null) return { error: "Set up the GitHub App in Integrations first." };
  }
  setBuildModes(serverId, app, { onPush, previews });
  const state = (on: boolean) => (on ? "on" : "off");
  if (onPush !== link.buildOnPush || previews !== link.buildPreviews) {
    await record("build_modes", `${app} <- ${link.repo}@${link.branch}: push ${state(onPush)}, previews ${state(previews)}`);
  }
  revalidatePath(`/servers/${serverId}`, "layout");
  return { ok: true };
}

export interface WebhookSecretState {
  error?: string;
  /** The new secret: returned once, to be copied into GitHub. It is not stored anywhere readable. */
  secret?: string;
}

/** Creates the webhook secret, or replaces it (the old one stops working at once). */
export async function generateWebhookSecretAction(): Promise<WebhookSecretState> {
  await requireSession();
  const locked = await stepUpError(stepUp.webhookSecret(), "generating the webhook secret");
  if (locked) return { error: locked };
  const replaced = webhookSecretSince() !== null;
  const secret = regenerateWebhookSecret();
  await record(replaced ? "webhook_secret_regenerated" : "webhook_secret_created");
  revalidatePath("/", "layout");
  return { secret };
}

export async function removeWebhookSecretAction(): Promise<void> {
  await requireSession();
  removeWebhookSecret();
  await record("webhook_secret_removed");
  revalidatePath("/", "layout");
}

/** Turns automatic deploys on (for the named workflow) or off for a linked app. */
export async function setAutoDeployAction(serverId: string, app: string, _prev: GithubState, form: FormData): Promise<GithubState> {
  await requireSession();
  const link = getAppRepo(serverId, app);
  if (!link) return { error: "Link this app to a repository first." };
  if (form.get("enabled") !== "on") {
    setAutoDeployWorkflow(serverId, app, null);
    if (link.autoDeployWorkflow !== null) await record("auto_deploy_off", `${app} <- ${link.repo}@${link.branch}`);
    revalidatePath(`/servers/${serverId}`, "layout");
    return { ok: true };
  }
  const workflow = text(form, "workflow");
  if (workflow === "") return { error: "Enter the name of the workflow that builds and pushes the image." };
  if (workflow.length > 200 || /[\u0000-\u001f\u007f]/.test(workflow)) return { error: "That does not look like a workflow name." };
  setAutoDeployWorkflow(serverId, app, workflow);
  await record("auto_deploy_on", `${app} <- ${link.repo}@${link.branch}, workflow "${workflow}"`);
  revalidatePath(`/servers/${serverId}`, "layout");
  return { ok: true };
}

/**
 * Turns previews on (for the named workflow) or off for a linked app. Switching off leaves the instances that exist
 * unless the form asks (`removePreviews`) for them to be removed too: each gets a signed DELETE. The switch goes off
 * either way; what could not be removed comes back in `notice`.
 */
export async function setPreviewsAction(serverId: string, app: string, _prev: GithubState, form: FormData): Promise<GithubState> {
  await requireSession();
  const link = getAppRepo(serverId, app);
  if (!link) return { error: "Link this app to a repository first." };
  if (form.get("enabled") !== "on") {
    setPreviewsWorkflow(serverId, app, null);
    const removal = form.get("removePreviews") === "on" ? await removePreviews(serverId, app) : null;
    if (link.previewsWorkflow !== null || removal !== null) {
      const base = `${app} <- ${link.repo}@${link.branch}`;
      await record("previews_off", removal === null ? base : `${base}, removed ${removal.removed} of ${removal.total} previews`);
    }
    revalidatePath(`/servers/${serverId}`, "layout");
    return removal?.notice ? { ok: true, notice: removal.notice } : { ok: true };
  }
  const workflow = text(form, "workflow");
  if (workflow === "") return { error: "Enter the name of the workflow that builds and pushes the image of a pull request." };
  if (workflow.length > 200 || /[\u0000-\u001f\u007f]/.test(workflow)) return { error: "That does not look like a workflow name." };
  setPreviewsWorkflow(serverId, app, workflow);
  await record("previews_on", `${app} <- ${link.repo}@${link.branch}, workflow "${workflow}"`);
  revalidatePath(`/servers/${serverId}`, "layout");
  return { ok: true };
}

/** Removes every preview of `app` the agent lists. Never throws: an agent that cannot be reached is reported in `notice`. */
async function removePreviews(serverId: string, app: string): Promise<{ removed: number; total: number; notice?: string }> {
  const server = getCredentials(serverId);
  if (!server) return { removed: 0, total: 0, notice: "Unknown server: existing previews were not removed." };
  const agent = agentFor(server);
  let names: number[];
  try {
    const listed = await agent.previews();
    if (listed === null) return { removed: 0, total: 0 };
    names = listed.filter((p) => p.app === app).map((p) => p.pr);
  } catch (err) {
    return { removed: 0, total: 0, notice: `Previews are off, but the agent could not be asked for the existing previews (${err instanceof AgentError ? err.message : "unexpected error"}): remove them by hand.` };
  }
  let removed = 0;
  const failed: string[] = [];
  for (const pr of names) {
    try {
      await agent.deletePreview(app, pr);
      removed++;
    } catch (err) {
      failed.push(`#${pr}: ${err instanceof AgentError ? err.message : "unexpected error"}`);
    }
  }
  return { removed, total: names.length, ...(failed.length > 0 ? { notice: `Previews are off, but ${failed.length} of ${names.length} could not be removed (${failed.join("; ")}).` } : {}) };
}

/** Removes the preview of a pull request now, signed like a deployment. The agent succeeds when there is none. */
export async function deletePreviewAction(serverId: string, app: string, pr: number): Promise<GithubState> {
  await requireSession();
  const server = getCredentials(serverId);
  if (!server) return { error: "Unknown server." };
  if (!validPullRequest(pr)) return { error: "That is not a pull request number." };
  try {
    await agentFor(server).deletePreview(app, pr);
  } catch (err) {
    return { error: err instanceof AgentError ? err.message : "Something went wrong. Try again." };
  }
  await record("preview_removed", `${previewName(app, pr)} on ${server.name}`);
  revalidatePath(`/servers/${serverId}`, "layout");
  return { ok: true };
}
