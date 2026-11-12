import { entityMetadata } from "@/lib/metadata";
import type { Metadata } from "next";
import { loadEntityConfig } from "@/components/config/EntityPageGate";
import { DatabaseForm } from "@/components/config/DatabaseForm";
import { PageHeader } from "@/components/page-header";
import { loadServer } from "@/lib/data";
import { projectNames } from "@/lib/projects";
import { hubCrumbs, projectOfReturnPath, safeReturnPath, serverCrumbs, serverListHref } from "@/lib/nav-core";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const server = loadServer(id);
  return entityMetadata("New database", server.name);
}

export default async function NewDatabasePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string | string[] }> }) {
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
            ? hubCrumbs(project, { label: "Databases", href: from }, { label: "New database" })
            : serverCrumbs(server, { label: "Databases", href: serverListHref("databases", id) }, { label: "New database" })
        }
        title="New database"
        description="Declare an existing PostgreSQL database to back it up on a schedule and restore it. Nothing is created or changed in the database."
      />
      {config.doc ? (
        <DatabaseForm
          projects={await projectNames()}
          serverId={id}
          baseHash={config.doc.hash}
          existingNames={(config.doc.model.databases ?? []).map((d) => d.name)}
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
