import Link from "next/link";
import type { Metadata } from "next";
import { ICONS } from "@/lib/icons";
import { loadPlacements } from "@/lib/projects";
import { groupProjects } from "@/lib/projects-core";
import { loadCardContext } from "@/lib/project-page";
import { projectView } from "@/lib/project-view-core";
import { ProjectGrid } from "@/components/projects/ProjectCard";
import { PageHeader } from "@/components/page-header";
import { CantTell, UnansweredNotice } from "@/components/fleet/Unreachable";
import { LiveRefresh } from "@/components/LiveRefresh";
import { EmptyState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export const metadata: Metadata = { title: "Projects" };
export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const generatedAt = Date.now(); // eslint-disable-line react-hooks/purity -- a server component renders once per request
  const { placements, unreachable, readOnly } = await loadPlacements();
  const projects = groupProjects(placements);
  const context = await loadCardContext(projects);
  const unanswered = unreachable.map((s) => ({ id: s.id, name: s.name, reason: s.reason }));

  return (
    <>
      <PageHeader
        title="Projects"
        description="What you ship: where it is live, what version runs and whether the last deployment worked. A project groups its apps, jobs and databases across servers."
        actions={
          <>
            <LiveRefresh generatedAt={generatedAt} />
            <Button asChild>
              <Link href="/projects/new">
                <ICONS.add /> New project
              </Link>
            </Button>
          </>
        }
      />
      <div className="space-y-6">
        {projects.length > 0 && <UnansweredNotice servers={unanswered} what="Apps" />}
        {projects.length === 0 ? (
          unreachable.length > 0 ? (
            <Card>
              <CantTell servers={unanswered} what="Apps" />
            </Card>
          ) : (
            <EmptyState
              bordered
              icon={ICONS.project}
              title="No projects yet"
              action={
                <Button asChild>
                  <Link href="/projects/new">
                    <ICONS.add /> New project
                  </Link>
                </Button>
              }
            >
              {readOnly.length > 0
                ? "The servers here are read-only: they have no deployments, so no apps."
                : "Start from a repository, or from an image: no GitHub needed. Keelson builds or pulls it and deploys it."}
            </EmptyState>
          )
        ) : (
          <ProjectGrid projects={projects.map((p) => projectView(p, context))} />
        )}
      </div>
    </>
  );
}
