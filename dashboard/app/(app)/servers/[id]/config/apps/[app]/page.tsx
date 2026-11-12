import { entityMetadata, routeName } from "@/lib/metadata";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppForm } from "@/components/config/AppForm";
import { DeleteEntityDialog } from "@/components/config/DeleteEntityDialog";
import { loadEntityConfig } from "@/components/config/EntityPageGate";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { agentFor } from "@/lib/agent";
import { load, loadServer } from "@/lib/data";
import { returnCrumbs, returnTo, serverCrumbs } from "@/lib/nav-core";
import { ownerOfApp } from "@/lib/owner-core";

export async function generateMetadata({ params }: { params: Promise<{ id: string; app: string }> }): Promise<Metadata> {
  const { id, app } = await params;
  const server = loadServer(id);
  return entityMetadata(routeName(app), "Edit app", server.name);
}

export default async function EditAppPage({ params, searchParams }: { params: Promise<{ id: string; app: string }>; searchParams: Promise<{ from?: string | string[] }> }) {
  const [{ id, app: name }, query] = await Promise.all([params, searchParams]);
  const server = loadServer(id);
  const config = await loadEntityConfig(id, server);
  // The version that serves now, so that "Deploy" after a saved change opens prefilled. Not knowing it only loses the prefill.
  const status = await load(agentFor(server).apps());
  const servingImage = status.data?.find((a) => a.name === name)?.container?.image ?? "";
  // Back to the project's Apps tab: from the link that opened the form, else from the project that owns the app.
  const { from } = returnTo(query.from, status.data ? ownerOfApp(status.data, name) : null, "apps");
  const app = config.doc?.model.apps?.find((a) => a.name === name);
  if (config.doc && !app) notFound();

  return (
    <>
      <PageHeader
        breadcrumbs={returnCrumbs(from, { label: name, href: `/servers/${id}/apps/${encodeURIComponent(name)}` }, { label: "Edit" }) ?? serverCrumbs(server, { label: "Configuration", href: `/servers/${id}/config` }, { label: name })}
        title={`Edit ${name}`}
        description="Saving writes the configuration. Domains apply at once; settings of the container (variables, command, volumes, ports) apply when you deploy. A new image tag is chosen when you deploy."
      />
      {config.doc ? (
        <div className="space-y-10">
          <AppForm
            serverId={id}
            baseHash={config.doc.hash}
            app={app}
            existingNames={(config.doc.model.apps ?? []).map((a) => a.name)}
            hasProxy={config.doc.model.proxy !== undefined}
            servingImage={servingImage}
            redirectTo={from}
            cancelHref={from}
          />
          <Card className="max-w-3xl border-destructive/40">
            <CardHeader>
              <CardTitle className="text-destructive">Danger zone</CardTitle>
              <CardDescription>
                Deleting removes the app from the configuration. Its running container keeps running but is no longer managed by Keelson.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center justify-between gap-4">
              <p className="text-sm">Delete {name} from the configuration.</p>
              <DeleteEntityDialog
                serverId={id}
                baseHash={config.doc.hash}
                entity={{ kind: "app", name }}
                redirectTo={`/servers/${id}`}
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
