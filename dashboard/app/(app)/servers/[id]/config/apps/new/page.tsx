import { entityMetadata } from "@/lib/metadata";
import type { Metadata } from "next";
import { AppForm } from "@/components/config/AppForm";
import { loadEntityConfig } from "@/components/config/EntityPageGate";
import { PageHeader } from "@/components/page-header";
import { loadServer } from "@/lib/data";
import { projectOfReturnPath, returnCrumbs, safeReturnPath, serverCrumbs } from "@/lib/nav-core";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const server = loadServer(id);
  return entityMetadata("New app", server.name);
}

export default async function NewAppPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string | string[] }> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const from = safeReturnPath(query.from) ?? undefined;
  const project = projectOfReturnPath(query.from) ?? undefined;
  const server = loadServer(id);
  const config = await loadEntityConfig(id, server);

  return (
    <>
      <PageHeader
        breadcrumbs={returnCrumbs(query.from, { label: server.name, href: `/servers/${id}` }, { label: "New app" }) ?? serverCrumbs(server, { label: "Configuration", href: `/servers/${id}/config` }, { label: "New app" })}
        title="New app"
        description="Describe the app here; deploy it afterwards from its page. The agent applies the configuration as soon as it is saved."
      />
      {config.doc ? (
        <AppForm
          serverId={id}
          baseHash={config.doc.hash}
          existingNames={(config.doc.model.apps ?? []).map((a) => a.name)}
          hasProxy={config.doc.model.proxy !== undefined}
          redirectTo={from}
          fixedProject={project}
          cancelHref={from}
        />
      ) : (
        config.notice
      )}
    </>
  );
}
