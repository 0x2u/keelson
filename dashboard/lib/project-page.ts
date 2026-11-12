import "server-only";
import { agentFor } from "@/lib/agent";
import type { Deployment } from "@/lib/agent-types";
import { commitInfos } from "@/lib/commit-info";
import { load } from "@/lib/data";
import { getAppRepo, type AppRepo } from "@/lib/integrations";
import type { Placement, Project, ServerRef } from "@/lib/projects-core";
import {
  appKey,
  commitsToResolve,
  environmentRefs,
  buildsOn,
  newestDeployments,
  projectView,
  type AppRef,
  type AppSource,
  type BuildsInfo,
  type DeploymentEntry,
  type ProjectContext,
  type ProjectView,
} from "@/lib/project-view-core";
import { getCredentials, getServer } from "@/lib/servers";
import { buildStarts } from "@/lib/webhook-deliveries";

// What the project cards and the project page know beyond what the agents' app lists say: the repository an app is linked
// to, who started its builds, its deployments and the messages of the commits they name.

function sourceOf(serverId: string, app: string): AppSource | undefined {
  const link = getAppRepo(serverId, app);
  if (!link) return undefined;
  return { repo: link.repo, branch: link.branch, builtOn: link.buildOn ? (getServer(link.buildOn)?.name ?? null) : null, started: buildStarts(serverId, app) };
}

function sourcesOf(placements: Placement[]): Record<string, AppSource> {
  const sources: Record<string, AppSource> = {};
  for (const { server, app } of placements) {
    const source = sourceOf(server.id, app.name);
    if (source) sources[appKey(server.id, app.name)] = source;
  }
  return sources;
}

/** What the cards of these projects show: where each is linked to, and the message of the commit that serves and of the latest one. */
export async function loadCardContext(projects: Project[]): Promise<ProjectContext> {
  const sources = sourcesOf(projects.flatMap((p) => p.environments.flatMap((e) => e.placements)));
  const commits = await commitInfos(commitsToResolve(projects.flatMap((p) => environmentRefs(p.environments[0])), sources));
  return { sources, commits, deployments: {} };
}

export interface ProjectPage {
  context: ProjectContext;
  project: ProjectView;
  /** The latest deployments of the environments, newest first. */
  feed: DeploymentEntry[];
  /** Where the primary app is built when that is not its own server; null when it builds where it runs. */
  builds: BuildsInfo | null;
  /** The primary environment's app: what its action buttons need. */
  primary: { placement: Placement; link: AppRepo | null; builds: boolean; history: Deployment[] | null };
}

const FEED = 10;
const BUILDS_RECENT = 3;
/** Enough for the rollback list, which the primary environment's app offers (the app page loads as many). */
const PRIMARY_HISTORY = 30;
const HISTORY = 10;

/** A server the dashboard knows, as the pages name it; null once it is no longer registered. */
function serverRef(id: string): ServerRef | null {
  const server = getServer(id);
  return server && { id: server.id, name: server.name, canDeploy: server.canDeploy };
}

/** The deployments of an app on a server, newest first; null when they cannot be read (the page then shows what the app list says). */
async function historyOf(serverId: string, app: string, limit: number): Promise<Deployment[] | null> {
  const creds = getCredentials(serverId);
  if (!creds) return null;
  return (await load(agentFor(creds).deployments(app, limit))).data ?? null;
}

/** Whether the app's apps-file entry has a `build:` block: it then builds where it runs. */
async function declaresBuild(serverId: string, app: string): Promise<boolean> {
  const creds = getCredentials(serverId);
  if (!creds) return false;
  const doc = await load(agentFor(creds).config());
  return doc.data?.model.apps?.find((a) => a.name === app)?.build !== undefined;
}

/**
 * Everything the page of one project shows: its environments with the deployments that tell what serves, where it is
 * built, and the latest deployments with their commit messages. A deployment list that cannot be read is left out.
 */
export async function loadProjectPage(project: Project): Promise<ProjectPage> {
  const [main] = project.environments;
  const envApps = project.environments.map((env) => ({ env, ...env.placements[0] }));
  const { server, app } = main.placements[0];
  const link = getAppRepo(server.id, app.name);
  const buildServer = link?.buildOn ? serverRef(link.buildOn) : null;

  const [envHistories, buildHistory, builtHere] = await Promise.all([
    Promise.all(envApps.map(({ env, server, app }) => historyOf(server.id, app.name, env === main ? PRIMARY_HISTORY : HISTORY))),
    buildServer ? historyOf(buildServer.id, app.name, HISTORY) : null,
    declaresBuild(server.id, app.name),
  ]);
  const builds = buildServer && buildsOn(buildServer, app.name, buildHistory, BUILDS_RECENT);

  const sources = sourcesOf(project.environments.flatMap((e) => e.placements));
  // The builds on the other server name the commits of the app's repository and say how they were started.
  const primarySource = sources[appKey(server.id, app.name)];
  if (builds && primarySource) sources[appKey(builds.server.id, builds.app)] = { ...primarySource, builtOn: null };

  const deployments: Record<string, Deployment[]> = {};
  envApps.forEach(({ server, app }, i) => {
    const history = envHistories[i];
    if (history) deployments[appKey(server.id, app.name)] = history;
  });

  const feed = newestDeployments(
    envApps.map(({ env, server, app }, i) => ({ server, app: app.name, environment: env.name, deployments: envHistories[i] ?? [] })),
    FEED,
  );

  const named: AppRef[] = [
    ...project.environments.flatMap(environmentRefs),
    ...feed.map((e) => ({ serverId: e.server.id, app: e.app, ref: e.deployment.ref })),
    ...(builds ? builds.recent.map((d) => ({ serverId: builds.server.id, app: builds.app, ref: d.ref })) : []),
  ];
  const context: ProjectContext = { sources, commits: await commitInfos(commitsToResolve(named, sources)), deployments };

  return {
    context,
    project: projectView(project, context),
    feed,
    builds,
    primary: {
      placement: main.placements[0],
      link,
      builds: builtHere || link?.buildOn != null,
      history: envHistories[0],
    },
  };
}
