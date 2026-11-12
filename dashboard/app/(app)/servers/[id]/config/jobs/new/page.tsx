import { entityMetadata } from "@/lib/metadata";
import type { Metadata } from "next";
import { loadEntityConfig } from "@/components/config/EntityPageGate";
import { JobForm } from "@/components/config/JobForm";
import { PageHeader } from "@/components/page-header";
import { loadServer } from "@/lib/data";
import { hubCrumbs, projectOfReturnPath, safeReturnPath, serverCrumbs } from "@/lib/nav-core";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const server = loadServer(id);
  return entityMetadata("New job", server.name);
}

export default async function NewJobPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string | string[] }> }) {
  const { id } = await params;
  const query = await searchParams;
  const from = safeReturnPath(query.from) ?? undefined;
  const project = projectOfReturnPath(query.from) ?? undefined;
  const server = loadServer(id);
  const config = await loadEntityConfig(id, server);

  return (
    <>
      <PageHeader
        breadcrumbs={
          project && from
            ? hubCrumbs(project, { label: "Jobs", href: from }, { label: "New job" })
            : serverCrumbs(server, { label: "Configuration", href: `/servers/${id}/config` }, { label: "New job" })
        }
        title="New job"
        description="A job runs on a schedule: an HTTP request, a program on the server, or a command in an app's container."
      />
      {config.doc ? (
        <JobForm
          serverId={id}
          baseHash={config.doc.hash}
          apps={(config.doc.model.apps ?? []).map((a) => ({ name: a.name, envKeys: Object.keys(a.env ?? {}) }))}
          existingNames={(config.doc.model.jobs ?? []).map((j) => j.name)}
          redirectTo={from}
          cancelHref={from}
          project={project}
        />
      ) : (
        config.notice
      )}
    </>
  );
}
