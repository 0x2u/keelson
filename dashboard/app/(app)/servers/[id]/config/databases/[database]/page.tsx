import { entityMetadata, routeName } from "@/lib/metadata";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DatabaseForm } from "@/components/config/DatabaseForm";
import { DeleteEntityDialog } from "@/components/config/DeleteEntityDialog";
import { loadEntityConfig } from "@/components/config/EntityPageGate";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { loadServer } from "@/lib/data";
import { projectNames } from "@/lib/projects";
import { hubCrumbs, returnTo, serverCrumbs, serverListHref } from "@/lib/nav-core";
import { loadOwnerFacts } from "@/lib/owner";
import { ownerOfDatabase } from "@/lib/owner-core";

export async function generateMetadata({ params }: { params: Promise<{ id: string; database: string }> }): Promise<Metadata> {
  const { id, database } = await params;
  const server = loadServer(id);
  return entityMetadata(routeName(database), "Edit database", server.name);
}

export default async function EditDatabasePage({ params, searchParams }: { params: Promise<{ id: string; database: string }>; searchParams: Promise<{ from?: string | string[] }> }) {
  const { id, database: name } = await params;
  const query = await searchParams;
  const server = loadServer(id);
  const config = await loadEntityConfig(id, server);
  // Back to the project's Databases tab: from the link that opened the form, else from the project that owns the database.
  const { from, project } = returnTo(query.from, ownerOfDatabase(await loadOwnerFacts(server, { config: config.doc?.model ?? null }), name), "databases");
  const database = config.doc?.model.databases?.find((d) => d.name === name);
  if (config.doc && !database) notFound();

  return (
    <>
      <PageHeader
        breadcrumbs={
          project && from
            ? hubCrumbs(project, { label: "Databases", href: from }, { label: name })
            : serverCrumbs(server, { label: "Databases", href: `/databases?server=${encodeURIComponent(id)}` }, { label: name })
        }
        title={`Edit ${name}`}
        description="Changes are applied by the agent as soon as they are saved."
      />
      {config.doc ? (
        <div className="space-y-10">
          <DatabaseForm
            projects={await projectNames()}
            serverId={id}
            baseHash={config.doc.hash}
            database={database}
            existingNames={(config.doc.model.databases ?? []).map((d) => d.name)}
            redirectTo={from}
            cancelHref={from}
          />
          <Card className="max-w-3xl border-destructive/40">
            <CardHeader>
              <CardTitle className="text-destructive">Danger zone</CardTitle>
              <CardDescription>
                Deleting removes the database from the configuration, so its backups stop. The database itself and the backups already stored are not touched.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center justify-between gap-4">
              <p className="text-sm">Delete {name} from the configuration.</p>
              <DeleteEntityDialog
                serverId={id}
                baseHash={config.doc.hash}
                entity={{ kind: "database", name }}
                redirectTo={from ?? serverListHref("databases", id)}
              />
            </CardContent>
          </Card>
        </div>
      ) : (
        config.notice
      )}
    </>
  );
}
