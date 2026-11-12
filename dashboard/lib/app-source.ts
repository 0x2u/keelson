import "server-only";
import type { PickableRepo } from "@/components/new-project/RepositoryStep";
import { agentFor, AGENT_TOO_OLD_FOR_BUILD_VARS } from "@/lib/agent";
import {
  HIDDEN,
  type AppStatus,
  type BuildConfig,
  type Deployment,
  type Preview,
} from "@/lib/agent-types";
import {
  buildChoices,
  notSentWarning,
  type BuildServerChoice,
  type BuildVarsRead,
  type BuildWarning,
  type NotSent,
} from "@/lib/build-elsewhere-core";
import { load, type Loaded } from "@/lib/data";
import { GithubError, githubCommits, githubCompare, githubRuns } from "@/lib/github";
import { GithubAppError, installationToken } from "@/lib/github-app";
import { commitOfRef, type Commit, type Comparison, type WorkflowRun } from "@/lib/github-core";
import { getAppRepo, githubAppSummary, githubConnection, webhookSecretSince, type AppRepo, type GithubAppSummary } from "@/lib/integrations";
import { linkableRepos } from "@/lib/linkable-repos";
import {
  getCredentials,
  listServers,
  type ServerCredentials,
} from "@/lib/servers";
import { statsOf } from "@/lib/server-stats";
import type { ServerStats } from "@/lib/server-stats-core";

export interface Attempt<T> {
  data?: T;
  error?: string;
}

export async function attempt<T>(promise: Promise<T>): Promise<Attempt<T>> {
  try {
    return { data: await promise };
  } catch (err) {
    return { error: err instanceof GithubError || err instanceof GithubAppError ? err.message : "Could not read from GitHub." };
  }
}

/** Reads from GitHub with the connected token, or with the GitHub App's installation token when only the App is set up. */
async function readWith<T>(connection: { token: string } | null, repo: string, run: (token: string) => Promise<T>, withActions = false): Promise<T> {
  return run(connection?.token ?? (await installationToken(repo, withActions)));
}

/** What every state of the Source page shares. */
export interface SourceContext {
  serverId: string;
  serverName: string;
  app: string;
  canDeploy: boolean;
  githubApp: GithubAppSummary | null;
  secretSet: boolean;
  build: BuildConfig | undefined;
  /** What it takes to choose where the app is built: the app's own server, the others as places to build it, and what would not travel to them. */
  where: {
    ownName: string;
    ownStats: ServerStats;
    choices: BuildServerChoice[];
    /** The build values of this app that a build on another server would not have. */
    notSent: NotSent;
    /** The build variables each server that can be chosen (and the one that builds it now) keeps for this app, by server id: names, or why they could not be read. */
    buildVars: Record<string, BuildVarsRead>;
    /** The same, worded for the server the app is built on now; null when it is built on its own or nothing is left behind. */
    buildWarning: BuildWarning | null;
  };
}

export type AppSource =
  | { kind: "missing" }
  /** Neither a token nor the GitHub App: a link made earlier keeps working through the webhook, so it stays visible. */
  | { kind: "no-github"; context: SourceContext; kept: AppRepo | null; keptPreviews: Loaded<Preview[] | null> | null }
  | { kind: "unlinked"; context: SourceContext; repos: PickableRepo[] }
  | {
      kind: "linked";
      context: SourceContext;
      link: AppRepo;
      /** The running image, null when nothing runs. */
      serving: string | null;
      servingSha: string | null;
      commits: Attempt<Commit[]>;
      runs: Attempt<WorkflowRun[]>;
      behind: Attempt<Comparison | null>;
      repos: PickableRepo[];
      previews: Loaded<Preview[] | null>;
      deployments: Deployment[];
      deploying: boolean;
    };

/** What each server keeps as build variables for the app (GET /v1/build-vars/{app}), by server id: its names, or why they could not be read. */
async function readBuildVars(
  app: string,
  serverIds: string[],
): Promise<Record<string, BuildVarsRead>> {
  const reads = await Promise.all(
    [...new Set(serverIds)].map(
      async (id): Promise<[string, BuildVarsRead]> => {
        const creds = getCredentials(id);
        if (!creds)
          return [
            id,
            { error: "This server is not registered here any more." },
          ];
        const read = await load(agentFor(creds).buildVars(app));
        if (read.error !== undefined) return [id, { error: read.error }];
        return [
          id,
          read.data === null
            ? { error: AGENT_TOO_OLD_FOR_BUILD_VARS }
            : { names: read.data.names },
        ];
      },
    ),
  );
  return Object.fromEntries(reads);
}

/** Reads what the source page of an app shows: the link, GitHub's view of the branch, and where the app is built. */
export async function loadAppSource(server: ServerCredentials, name: string): Promise<AppSource> {
  const id = server.id;
  const agent = agentFor(server);
  const [apps, history, config] = await Promise.all([load(agent.apps()), load(agent.deployments(name, 50)), load(agent.config())]);
  const build = config.data?.model.apps?.find((a) => a.name === name)?.build;
  if (apps.error === undefined && apps.data?.some((a: AppStatus) => a.name === name) !== true) return { kind: "missing" };

  const connection = githubConnection();
  const githubApp = githubAppSummary();
  const link = getAppRepo(id, name);
  const others = listServers().filter((s) => s.id !== id);
  const asked = others.length > 0;
  const [stats, variables] = await Promise.all([asked ? statsOf([id, ...others.map((s) => s.id)]) : Promise.resolve<Record<string, ServerStats>>({}), asked ? load(agent.envVars(name, "app")) : Promise.resolve(null)]);
  const ownStats = stats[id] ?? { online: true };
  const notSent: NotSent = {
    stored: variables?.data?.vars.filter((v) => v.build).map((v) => v.key) ?? [],
    hidden: Object.entries(build?.args ?? {})
      .filter(([, v]) => v === HIDDEN)
      .map(([k]) => k),
  };
  const buildServer = link?.buildOn
    ? listServers().find((s) => s.id === link.buildOn)
    : undefined;
  const choices = buildChoices(
    others.map((s) => ({
      id: s.id,
      name: s.name,
      canDeploy: s.canDeploy,
      stats: stats[s.id] ?? { online: false },
    })),
    build,
    ownStats.arch,
  );
  const buildVars = await readBuildVars(name, [
    ...choices.filter((c) => c.disabled === null).map((c) => c.serverId),
    ...(buildServer ? [buildServer.id] : []),
  ]);
  const read = buildServer ? buildVars[buildServer.id] : undefined;
  const builderVars = read !== undefined && "names" in read ? read.names : [];
  const context: SourceContext = {
    serverId: id,
    serverName: server.name,
    app: name,
    canDeploy: server.canDeploy,
    githubApp,
    secretSet: webhookSecretSince() !== null,
    build,
    where: {
      ownName: server.name,
      ownStats,
      choices,
      notSent,
      buildVars,
      buildWarning: buildServer
        ? notSentWarning(notSent, {
            app: name,
            ownName: server.name,
            buildServer: buildServer.name,
            onBuilder: builderVars.map((n) => n.name),
          })
        : null,
    },
  };

  if (!connection && githubApp === null) {
    const keptPreviews = link ? await load(agent.previews()) : null;
    return { kind: "no-github", context, kept: link, keptPreviews };
  }

  if (!link) return { kind: "unlinked", context, repos: await linkableRepos() };

  const serving = apps.data?.find((a) => a.name === name)?.container?.image ?? null;
  const servingSha = serving === null ? null : commitOfRef(serving);
  const [commits, runs, behind, repos, previews] = await Promise.all([
    attempt(readWith(connection, link.repo, (t) => githubCommits(t, link.repo, link.branch))),
    attempt(readWith(connection, link.repo, (t) => githubRuns(t, link.repo, link.branch), true)),
    servingSha === null ? Promise.resolve<Attempt<null>>({ data: null }) : attempt(readWith(connection, link.repo, (t) => githubCompare(t, link.repo, servingSha, link.branch))),
    linkableRepos(),
    load(agent.previews()),
  ]);
  const deployments = history.data ?? [];
  return { kind: "linked", context, link, serving, servingSha, commits, runs, behind, repos, previews, deployments, deploying: deployments.some((d) => d.status === "running") };
}
