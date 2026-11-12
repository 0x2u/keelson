import type { Deployment, DeploymentPhase } from "@/lib/agent-types";
import { envPending } from "@/lib/env-core";
import { commitKey, commitOfRef, fullCommitOfRef, type CommitInfo, type CommitRef } from "@/lib/github-core";
import { splitRef } from "@/lib/image-ref-core";
import { triggerLabel } from "@/lib/labels-core";
import { projectHref } from "@/lib/nav-core";
import { environmentState, type Environment, type EnvironmentState, type Placement, type Project, type ServerRef } from "@/lib/projects-core";
import { publishedAddresses, type LocalAddress } from "@/lib/published-address-core";

// What a project, and each of its environments, look like to the person reading the dashboard: the address, what serves
// and from which commit, how it got there. Pure: the pages only fetch (links, deployments, commit messages) and render.

export const appKey = (serverId: string, app: string): string => `${serverId}/${app}`;

/** What started a build of a commit: a push to the linked branch, or Deploy in the dashboard. */
export type BuildStart = "push" | "dashboard";

/** What the dashboard knows about where an app's code comes from: only apps linked to a repository have one. */
export interface AppSource {
  repo: string;
  branch: string;
  /** The name of the machine that builds the app when that is not where it runs. */
  builtOn: string | null;
  /** How the builds of each commit (full hash) the agent accepted were started. */
  started: Record<string, BuildStart>;
}

export interface ProjectContext {
  /** By `appKey`. */
  sources: Record<string, AppSource>;
  /** By `commitKey`: only the commits that could be read. */
  commits: Record<string, CommitInfo>;
  /** The deployments of an app (by `appKey`), newest first, when the page loaded them: they tell which one shipped what serves. */
  deployments: Record<string, Deployment[]>;
}

/** The first domain that is an address one can open: the operator lists the main one first, and a wildcard is not a site. */
export function primaryDomain(domains: string[] | undefined): string | null {
  return domains?.find((d) => !d.startsWith("*.")) ?? null;
}

export const siteUrl = (domain: string): string => `https://${domain}`;

export const appHref = (serverId: string, app: string): string => `/servers/${serverId}/apps/${encodeURIComponent(app)}`;

export interface RefView {
  /** The commit message (first line) when it is known. */
  message: string | null;
  /** What names the version: the short hash, the tag, or the short digest. */
  version: string;
  /** The short hash when the reference is a commit. */
  sha: string | null;
  /** The linked branch, said only for a commit of an app that builds from one. */
  branch: string | null;
}

/** A deployment reference as a person names it. */
export function describeRef(ref: string, source: AppSource | undefined, commits: Record<string, CommitInfo>): RefView {
  const commit = commitOfRef(ref);
  const full = fullCommitOfRef(ref);
  const sha = commit?.slice(0, 7) ?? null;
  const { tag, digest } = splitRef(ref);
  return {
    message: source && full ? (commits[commitKey(source.repo, full)]?.message ?? null) : null,
    version: sha ?? tag ?? (digest ? `@${digest}` : "latest"),
    sha,
    branch: sha !== null && source ? source.branch : null,
  };
}

/**
 * What started a deployment, in words: the table of lib/labels-core, except that a build a push started says "Push"
 * (with the machine that built it when that is another one).
 */
export function triggerWords(trigger: string, started: BuildStart | undefined, builtOn: string | null = null): string {
  if (started === "push" && (trigger === "build" || trigger === "transfer")) return trigger === "transfer" && builtOn ? `Push (built on ${builtOn})` : "Push";
  return triggerLabel(trigger, builtOn);
}

export interface DeploymentView {
  id: string;
  status: Deployment["status"];
  ref: RefView;
  /** The image the deployment put in service, as the agent records it. */
  image: string;
  /** What started it, in words (it names the machine that built the image when that was another one). */
  trigger: string;
  /** What started it, as the agent says: `triggerCode` and `status` tell a roll back from a deploy. */
  triggerCode: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  phases?: DeploymentPhase[];
  servingRef?: string;
}

export function describeDeployment(d: Deployment, source: AppSource | undefined, commits: Record<string, CommitInfo>): DeploymentView {
  const full = fullCommitOfRef(d.ref);
  return {
    id: d.id,
    status: d.status,
    ref: describeRef(d.ref, source, commits),
    image: d.ref,
    trigger: triggerWords(d.trigger, full === null ? undefined : source?.started[full], d.trigger === "transfer" ? (source?.builtOn ?? null) : null),
    triggerCode: d.trigger,
    startedAt: d.started_at,
    finishedAt: d.finished_at,
    error: d.error,
    ...(d.phases ? { phases: d.phases } : {}),
    ...(d.serving_ref ? { servingRef: d.serving_ref } : {}),
  };
}

/**
 * The deployment whose version serves now: the newest successful one, preferring one that shipped the running image.
 * Null when nothing runs, or none of the known deployments succeeded.
 */
export function servingDeployment(placement: Placement, deployments: Deployment[] | undefined): Deployment | null {
  const { app } = placement;
  if (!app.container) return null;
  const known = [...(deployments ?? []), ...(app.last_deployment ? [app.last_deployment] : [])].filter((d) => d.status === "succeeded");
  known.sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  return known.find((d) => d.ref === app.container?.image) ?? known[0] ?? null;
}

/** One environment, as a card, a chip or a row shows it. */
export interface EnvironmentView {
  name: string;
  /** Where it runs: usually one server. The page of the environment is the first one's. */
  servers: ServerRef[];
  app: string;
  /** The environment's own page. */
  href: string;
  state: EnvironmentState;
  /** The address people open; null when none is known (no domain, or an older agent that does not say). */
  domain: string | null;
  /** Every address of the site, the first one first. */
  domains: string[];
  /**
   * Where it answers when it has no domain: the ports its running container publishes on the server, as addresses to open
   * (`host:port`, a link when the browser can reach the host). Empty with a domain, or when nothing runs.
   */
  localAddresses: LocalAddress[];
  /** The version of the container the environment has: what serves now, or what last ran when the container is stopped or unwell; null when there is none. */
  serving: RefView | null;
  /** The container is up: `serving` really is what people get. */
  serves: boolean;
  /** The deployment that shipped what serves; null when nothing runs or it is not known. */
  deployed: DeploymentView | null;
  /** The latest deployment, whatever its outcome; null when there never was one. */
  latest: DeploymentView | null;
  /** Variables were saved after the serving version was deployed: it does not have them yet. Known only when the deployments were loaded. */
  variablesBehind: boolean;
}

/** An environment is shown by its first app (one per server it runs on, in server name order). */
export function environmentView(env: Environment, ctx: ProjectContext): EnvironmentView {
  const first = env.placements[0];
  const { server, app } = first;
  const key = appKey(server.id, app.name);
  const source = ctx.sources[key];
  const history = ctx.deployments[key];
  const deployed = servingDeployment(first, history);
  const state = environmentState(app);
  return {
    name: env.name,
    servers: env.placements.map((p) => p.server),
    app: app.name,
    href: appHref(server.id, app.name),
    state,
    domain: primaryDomain(app.domains),
    domains: (app.domains ?? []).filter((d) => !d.startsWith("*.")),
    localAddresses: primaryDomain(app.domains) === null && app.container !== null && state.label !== "Down" ? publishedAddresses(app.container.ports, server.host ?? null) : [],
    serving: app.container ? describeRef(app.container.image, source, ctx.commits) : null,
    serves: app.container !== null && state.label !== "Down",
    deployed: deployed && describeDeployment(deployed, source, ctx.commits),
    latest: app.last_deployment ? describeDeployment(app.last_deployment, source, ctx.commits) : null,
    variablesBehind: envPending(app, history ?? null) !== null,
  };
}

export interface ProjectView {
  name: string;
  href: string;
  /** `owner/name` of the repository the project builds from; null when no app of it is linked. */
  repo: string | null;
  /** The environment the project is judged by: production, else the first (the environments come in display order). */
  primary: EnvironmentView;
  /** Every environment, primary included. */
  environments: EnvironmentView[];
}

export function projectView(project: Project, ctx: ProjectContext): ProjectView {
  const environments = project.environments.map((e) => environmentView(e, ctx));
  const sources = project.environments.flatMap((e) => e.placements).map((p) => ctx.sources[appKey(p.server.id, p.app.name)]);
  return { name: project.name, href: projectHref(project.name), repo: sources.find((s) => s !== undefined)?.repo ?? null, primary: environments[0], environments };
}

/** A deployment reference of an app: what to ask GitHub about. */
export interface AppRef {
  serverId: string;
  app: string;
  ref: string;
}

/** The commits that references of apps linked to a repository name by their full hash: what to ask GitHub for, once each. */
export function commitsToResolve(refs: AppRef[], sources: Record<string, AppSource>): CommitRef[] {
  const found = new Map<string, CommitRef>();
  for (const { serverId, app, ref } of refs) {
    const source = sources[appKey(serverId, app)];
    const sha = fullCommitOfRef(ref);
    if (source && sha) found.set(commitKey(source.repo, sha), { repo: source.repo, sha });
  }
  return [...found.values()];
}

/** The references an environment shows: what serves and its latest deployment. */
export function environmentRefs(env: Environment): AppRef[] {
  const { server, app } = env.placements[0];
  return [app.container?.image, app.last_deployment?.ref].flatMap((ref) => (ref ? [{ serverId: server.id, app: app.name, ref }] : []));
}

/** A deployment of an app, with where it ran. */
export interface DeploymentEntry {
  server: ServerRef;
  app: string;
  environment: string;
  deployment: Deployment;
}

export interface DeploymentsOf {
  server: ServerRef;
  app: string;
  environment: string;
  deployments: Deployment[];
}

/** The newest deployments across apps, newest first. */
export function newestDeployments(from: DeploymentsOf[], limit: number): DeploymentEntry[] {
  return from
    .flatMap(({ deployments, ...where }) => deployments.map((deployment): DeploymentEntry => ({ ...where, deployment })))
    .sort((a, b) => Date.parse(b.deployment.started_at) - Date.parse(a.deployment.started_at))
    .slice(0, limit);
}

/** Where a project's app is built when that is not the server that runs it, with the latest builds there (deployments of the same app name, trigger `build`). */
export interface BuildsInfo {
  server: ServerRef;
  app: string;
  /** Newest first. */
  recent: Deployment[];
}

/** The latest `limit` builds the build server ran for `app`. `history` is that server's deployments of the app, newest first (null when they could not be read). */
export function buildsOn(server: ServerRef, app: string, history: Deployment[] | null, limit: number): BuildsInfo {
  return { server, app, recent: (history ?? []).filter((d) => d.trigger === "build").slice(0, limit) };
}
