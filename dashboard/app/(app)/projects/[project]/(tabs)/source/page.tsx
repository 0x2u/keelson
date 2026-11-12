import { entityMetadata, routeName } from "@/lib/metadata";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { UnansweredNotice } from "@/components/fleet/Unreachable";
import { ProjectSource } from "@/components/projects/ProjectSource";
import { loadAppSource } from "@/lib/app-source";
import { loadProjectHub } from "@/lib/project-hub";
import { pickSourceApp } from "@/lib/project-source-core";
import { getCredentials } from "@/lib/servers";
import { Notice } from "@/components/states";

export async function generateMetadata({ params }: { params: Promise<{ project: string }> }): Promise<Metadata> {
  return entityMetadata(routeName((await params).project), "Source");
}
export const dynamic = "force-dynamic";

export default async function ProjectSourcePage({ params, searchParams }: { params: Promise<{ project: string }>; searchParams: Promise<{ app?: string | string[] }> }) {
  const [{ project: raw }, query] = await Promise.all([params, searchParams]);
  const name = decodeURIComponent(raw);
  const hub = await loadProjectHub(name);
  if (!hub) notFound();
  const picked = pickSourceApp(hub.project, Array.isArray(query.app) ? query.app[0] : query.app);
  if (!picked) notFound();
  const { server, app } = picked.chosen.placement;
  const creds = getCredentials(server.id);
  return (
    <div className="space-y-6">
      <UnansweredNotice servers={hub.unreachable} what="Source" />
      {creds ? (
        <ProjectSource project={name} choices={picked.choices} chosen={picked.chosen} source={await loadAppSource(creds, app.name)} />
      ) : (
        <Notice title={`Could not load ${server.name}`}>This server is no longer registered.</Notice>
      )}
    </div>
  );
}
