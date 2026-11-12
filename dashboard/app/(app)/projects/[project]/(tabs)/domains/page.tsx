import { entityMetadata, routeName } from "@/lib/metadata";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { UnansweredNotice } from "@/components/fleet/Unreachable";
import { ProjectDomains } from "@/components/projects/ProjectDomains";
import { cloudflareSummary } from "@/lib/integrations";
import { loadProjectHub } from "@/lib/project-hub";
import { serverProxy } from "@/lib/server-data";

export async function generateMetadata({ params }: { params: Promise<{ project: string }> }): Promise<Metadata> {
  return entityMetadata(routeName((await params).project), "Domains");
}
export const dynamic = "force-dynamic";

export default async function ProjectDomainsPage({ params }: { params: Promise<{ project: string }> }) {
  const name = decodeURIComponent((await params).project);
  const hub = await loadProjectHub(name);
  if (!hub) notFound();
  const ids = [...new Set(hub.project.environments.flatMap((e) => e.placements.map((p) => p.server.id)))];
  const answers = await Promise.all(ids.map(async (id) => [id, await serverProxy(id)] as const));
  const proxies = Object.fromEntries(answers.map(([id, r]) => [id, r.error !== undefined ? { view: null, error: r.error } : { view: r.data }]));
  return (
    <div className="space-y-6">
      <UnansweredNotice servers={hub.unreachable} what="Domains" />
      <ProjectDomains project={hub.project} proxies={proxies} cloudflare={cloudflareSummary() !== null} />
    </div>
  );
}
