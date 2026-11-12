import { entityMetadata, routeName } from "@/lib/metadata";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { JobsTable } from "@/components/jobs/JobsTable";
import { hubTabPath } from "@/lib/project-hub-jobs-core";
import { loadProjectHub } from "@/lib/project-hub";

export async function generateMetadata({ params }: { params: Promise<{ project: string }> }): Promise<Metadata> {
  return entityMetadata(routeName((await params).project), "Jobs");
}
export const dynamic = "force-dynamic";

export default async function ProjectJobsPage({ params }: { params: Promise<{ project: string }> }) {
  const name = decodeURIComponent((await params).project);
  const hub = await loadProjectHub(name);
  if (!hub) notFound();
  return (
    <JobsTable
      scope="project"
      entries={hub.members.jobs.map((h) => ({ server: h.server, job: h.job, project: hub.name, hub: h }))}
      unanswered={hub.unreachable}
      servers={hub.facts.map((f) => f.server)}
      from={hubTabPath(hub.name, "jobs")}
      filter={{ project: hub.name }}
      unassigned={hub.members.unassignedJobs}
      now={hub.generatedAt}
    />
  );
}
