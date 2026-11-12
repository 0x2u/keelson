import { entityMetadata, routeName } from "@/lib/metadata";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { UnansweredNotice } from "@/components/fleet/Unreachable";
import type { EnvironmentSource } from "@/components/projects/AddEnvironmentButton";
import { ProjectApps, type AppDatabase } from "@/components/projects/ProjectApps";
import { agentFor } from "@/lib/agent";
import type { Deployment } from "@/lib/agent-types";
import { load, loadServer } from "@/lib/data";
import { actionIntent } from "@/lib/action-intent-core";
import { hubPlacements, loadProjectHub } from "@/lib/project-hub";
import { newAppOnServerHref } from "@/lib/project-actions-core";
import { serverChoices, soleServer } from "@/lib/project-lifecycle-core";
import { listServers } from "@/lib/servers";
import { managedDatabases, placementKey, previewParent } from "@/lib/project-apps-core";

export async function generateMetadata({ params }: { params: Promise<{ project: string }> }): Promise<Metadata> {
  return entityMetadata(routeName((await params).project), "Apps");
}
export const dynamic = "force-dynamic";

export default async function ProjectAppsPage({ params, searchParams }: { params: Promise<{ project: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ project: raw }, query] = await Promise.all([params, searchParams]);
  const name = decodeURIComponent(raw);
  const hub = await loadProjectHub(name);
  if (!hub) notFound();
  const { project } = hub;
  const placements = project.environments.flatMap((e) => e.placements);
  const loaded = await Promise.all(
    placements.map(async (p): Promise<[string, Deployment[] | null]> => {
      const history = await load(agentFor(loadServer(p.server.id)).deployments(p.app.name, 30));
      return [placementKey(p), history.error === undefined ? history.data : null];
    }),
  );
  const databases: AppDatabase[] = managedDatabases(hub.members.databases).map((d) => ({
    server: { id: d.server.id, name: d.server.name },
    name: d.db.name,
    engine: d.db.engine,
    container: d.db.host,
    app: d.apps[0],
  }));

  const servers = serverChoices(listServers(), [...new Set(placements.map((p) => p.server.id))]);
  const intent = actionIntent(query).add ?? null;
  // "?add=app" with one server that can take the app has nothing to ask: it goes to the form.
  const sole = soleServer(servers);
  if (intent === "app" && sole !== null) redirect(newAppOnServerHref(sole.id, name));

  const everyApp = (await hubPlacements()).placements;
  const appNames: Record<string, string[]> = {};
  for (const p of everyApp) (appNames[p.server.id] ??= []).push(p.app.name);
  const sources: EnvironmentSource[] = project.environments.flatMap((e, i) =>
    e.placements
      .filter((p) => previewParent(p.app.name) === null)
      .map((p) => {
        const config = hub.facts.find((f) => f.server.id === p.server.id)?.config?.apps?.find((a) => a.name === p.app.name) ?? null;
        return {
          key: placementKey(p),
          environment: e.name,
          primary: i === 0,
          server: p.server,
          app: { name: p.app.name, image: p.app.image },
          // The variables are not needed to plan a copy and are not sent to the browser.
          config: config === null ? null : { ...config, env: undefined },
        };
      }),
  );
  return (
    <div className="space-y-6">
      <UnansweredNotice servers={hub.unreachable} what="Apps" />
      <ProjectApps
        project={project}
        histories={Object.fromEntries(loaded)}
        databases={databases}
        add={{ servers, environments: project.environments.map((e) => e.name), sources, appNames }}
        intent={intent}
      />
    </div>
  );
}
