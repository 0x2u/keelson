import { entityMetadata, routeName } from "@/lib/metadata";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProjectConfig } from "@/components/projects/ProjectConfig";
import { loadProjectConfig } from "@/lib/project-config";
import { loadProjectHub } from "@/lib/project-hub";

export async function generateMetadata({ params }: { params: Promise<{ project: string }> }): Promise<Metadata> {
  return entityMetadata(routeName((await params).project), "Configuration");
}
export const dynamic = "force-dynamic";

export default async function ProjectConfigPage({ params }: { params: Promise<{ project: string }> }) {
  const hub = await loadProjectHub(decodeURIComponent((await params).project));
  if (!hub) notFound();
  return <ProjectConfig project={hub.name} servers={await loadProjectConfig(hub)} unreachable={hub.unreachable} />;
}
