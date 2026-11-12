import "server-only";
import { cache } from "react";
import { agentFor } from "@/lib/agent";
import { snapshotFrom, type ServerAnswers, type ServerSnapshot } from "@/lib/attention-core";
import { recentAlerts } from "@/lib/alert-history";
import { load, loadServer } from "@/lib/data";
import { AGENT_ROLLBACK_WINDOW } from "@/lib/rollback-core";
import { lastSeen, markSeen } from "@/lib/servers";

// What the pages of one server read from its agent. Each call is started once per request however many components ask
// for it (the layout's tab bar and the page share them), and each page asks only for what it shows: a tab never loads
// another tab's data. The result is a promise, so a page can start several and let the parts stream.

const agentOf = (id: string) => agentFor(loadServer(id));

export const serverInfo = cache((id: string) => load(agentOf(id).info()));
export const serverSystem = cache((id: string) => load(agentOf(id).system()));
export const serverContainers = cache((id: string) => load(agentOf(id).containers(true)));
export const serverApps = cache((id: string) => load(agentOf(id).apps()));
export const serverJobs = cache((id: string) => load(agentOf(id).jobs()));
export const serverDatabases = cache((id: string) => load(agentOf(id).databases()));
export const serverProxy = cache((id: string) => load(agentOf(id).proxy()));
export const serverDeployments = cache((id: string) => load(agentOf(id).deployments(undefined, 10)));
/** The machine's load, memory and disk over a range; null data for a server that records none. */
export const serverHostHistory = cache((id: string, range: string) => load(agentOf(id).hostHistory(range)));
export const serverDisk = cache((id: string) => load(agentOf(id).diskUsage()));
/** The backups at a database's destination, newest first: read from the destination, so it can be slow. */
export const databaseBackups = cache((id: string, database: string) => load(agentOf(id).databaseBackups(database)));

export const serverConfig = cache((id: string) => load(agentOf(id).config()));
/** The latest successful proofs of the agent (key, restore, alert); null data for an agent older than the route. */
export const serverProofs = cache((id: string) => load(agentOf(id).proofs()));
/** The restore tests of one database, newest first; null data for an agent older than the route. */
export const databaseRestoreTests = cache((id: string, database: string) => load(agentOf(id).restoreTests(database)));
/** The deployments of one app, newest first, as far back as the agent looks for a rollback target. */
export const appHistory = cache((id: string, app: string) => load(agentOf(id).deployments(app, AGENT_ROLLBACK_WINDOW)));

/** Everything the attention model reads about one server: the tab bar's counts and dots, and the overview's verdict. */
export const serverAnswers = cache(
  async (id: string): Promise<ServerAnswers> => {
    const [info, system, containers, apps, jobs, databases, proxy] = await Promise.all([
      serverInfo(id),
      serverSystem(id),
      serverContainers(id),
      serverApps(id),
      serverJobs(id),
      serverDatabases(id),
      serverProxy(id),
    ]);
    return { info, system, containers, apps, jobs, databases, proxy };
  },
);

/** The server as the attention model sees it (unreachable when the agent did not answer, with why). */
export const serverSnapshot = cache(async (id: string): Promise<ServerSnapshot> => {
  const server = loadServer(id);
  const answers = await serverAnswers(id);
  const reachable = answers.info.error === undefined;
  if (reachable) markSeen(id);
  const snapshot = snapshotFrom({ id, name: server.name }, answers, reachable ? Date.now() : lastSeen(id));
  const alerts = reachable ? await recentAlerts(id, agentOf(id)) : undefined;
  return alerts === undefined ? snapshot : { ...snapshot, alerts };
});
