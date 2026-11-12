import { entityMetadata, routeName } from "@/lib/metadata";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { UnansweredNotice } from "@/components/fleet/Unreachable";
import { ReadinessGroups, ReadinessHeadline } from "@/components/readiness/ReadinessList";
import { loadDashboardReadiness, loadServerReadiness } from "@/lib/readiness";
import { forProject, projectOwnership } from "@/lib/readiness-core";
import { loadProjectHub } from "@/lib/project-hub";
import { serverInfo } from "@/lib/server-data";

export async function generateMetadata({ params }: { params: Promise<{ project: string }> }): Promise<Metadata> {
  return entityMetadata(routeName((await params).project), "Readiness");
}
export const dynamic = "force-dynamic";

/**
 * Whether the project can be trusted, not only whether it runs: its databases' backups, a restore that was tested, an
 * off-site copy and the key proven; the alert channel of each server it runs on; its apps' health check and rollback target;
 * and the dashboard's own second factor and backup. Each item says where it stands and is the way to fix it.
 */
export default async function ProjectReadinessPage({ params }: { params: Promise<{ project: string }> }) {
  const name = decodeURIComponent((await params).project);
  const hub = await loadProjectHub(name);
  if (!hub) notFound();
  const now = hub.generatedAt;
  const fromServers = await Promise.all(
    hub.facts.map(async (f) =>
      loadServerReadiness({ server: f.server, reachable: true, version: (await serverInfo(f.server.id)).data?.version, apps: f.apps, databases: f.databases }, now),
    ),
  );
  const items = forProject([...fromServers.flat(), ...loadDashboardReadiness(now)], projectOwnership(hub.project, hub.members));
  return (
    <div className="space-y-6">
      <UnansweredNotice servers={hub.unreachable} what="Readiness" />
      <ReadinessHeadline items={items} />
      <ReadinessGroups items={items} showServer={hub.facts.length > 1} />
    </div>
  );
}
