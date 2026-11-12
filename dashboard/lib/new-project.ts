import "server-only";
import { agentFor } from "@/lib/agent";
import { loadDnsSetup } from "@/lib/domains";
import { serverHealth, type ServerFailure } from "@/lib/fleet";
import type { ProjectServer } from "@/lib/new-project-wizard-core";
import { reviewContext, suggestHostPort } from "@/lib/repo-detect-core";
import { statsOf } from "@/lib/server-stats";
import { runTargets } from "@/lib/machine-core";
import { getCredentials, listServers } from "@/lib/servers";

/** The servers a project can go to, with what the form needs of each, and the ones left out with why. */
export async function loadProjectServers(): Promise<{ servers: ProjectServer[]; skipped: ServerFailure[] }> {
  const online = new Map((await serverHealth()).map((s) => [s.id, s]));
  const results = await Promise.all(
    runTargets(listServers()).map(async (summary): Promise<{ ok: ProjectServer } | { skip: ServerFailure }> => {
      const skip = (reason: string) => ({ skip: { id: summary.id, name: summary.name, reason } });
      const health = online.get(summary.id);
      if (!health?.reachable) return skip(health?.reason ?? "the agent does not answer");
      if (!summary.canDeploy) return skip("it is read-only here: add its deploy access in the server's settings");
      const creds = getCredentials(summary.id);
      if (!creds) return skip("it is no longer registered");
      const agent = agentFor(creds);
      try {
        const doc = await agent.config();
        if (doc === null) return skip("its configuration is read-only");
        if (doc.error) return skip("its configuration is currently invalid");
        const context = reviewContext(doc.model);
        const [dns, envSupported, databaseSupported, stats] = await Promise.all([
          loadDnsSetup(creds, context.proxy === "caddy"),
          agent.supportsEnv().catch(() => true),
          agent.postgres().then((p) => p !== null, () => false),
          statsOf([summary.id]),
        ]);
        return { ok: { id: summary.id, name: summary.name, context, hostPort: suggestHostPort(doc.model.apps ?? []), dns, envSupported, databaseSupported, appsDomain: summary.appsDomain, stats: stats[summary.id] ?? { online: true } } };
      } catch (err) {
        return skip(err instanceof Error ? err.message : "its configuration could not be read");
      }
    }),
  );
  return {
    servers: results.flatMap((r) => ("ok" in r ? [r.ok] : [])),
    skipped: results.flatMap((r) => ("skip" in r ? [r.skip] : [])),
  };
}
