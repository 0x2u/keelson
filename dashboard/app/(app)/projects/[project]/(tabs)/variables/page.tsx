import { entityMetadata, routeName } from "@/lib/metadata";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { UnansweredNotice } from "@/components/fleet/Unreachable";
import { ProjectVariables } from "@/components/projects/ProjectVariables";
import { VariableCompare } from "@/components/projects/VariableCompare";
import { loadAppEnvironment, type AppEnvironment } from "@/lib/app-environment";
import { canRunApps } from "@/lib/machine-core";
import { loadProjectHub } from "@/lib/project-hub";
import { compareEnvironments, pickVariablesTarget } from "@/lib/project-variables-core";
import { getCredentials } from "@/lib/servers";

export async function generateMetadata({ params }: { params: Promise<{ project: string }> }): Promise<Metadata> {
  return entityMetadata(routeName((await params).project), "Variables");
}
export const dynamic = "force-dynamic";

type Query = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export default async function ProjectVariablesPage({ params, searchParams }: { params: Promise<{ project: string }>; searchParams: Promise<Query> }) {
  const [{ project: raw }, query] = await Promise.all([params, searchParams]);
  const name = decodeURIComponent(raw);
  const hub = await loadProjectHub(name);
  if (!hub) notFound();
  const target = pickVariablesTarget(hub.project, { env: one(query.env), app: one(query.app) });
  if (!target) notFound();

  const { server, app } = target.chosen;
  const creds = getCredentials(server.id);
  const env: AppEnvironment = creds ? await loadAppEnvironment(creds, app.name, query.scope) : { kind: "apps-error", error: "this server is no longer registered" };
  const comparison = compareEnvironments(hub.project, hub.facts, { a: one(query.a), b: one(query.b) });

  return (
    <div className="space-y-6">
      <UnansweredNotice servers={hub.unreachable} what="Variables" />
      <ProjectVariables project={name} target={target} env={env} machine={creds ? !canRunApps(creds) : false} />
      {comparison && <VariableCompare project={name} comparison={comparison} open={query.a !== undefined} keep={{ env: target.env.name, app: `${server.id}/${app.name}` }} />}
    </div>
  );
}
