import { entityMetadata, routeName } from "@/lib/metadata";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DeleteEntityDialog } from "@/components/config/DeleteEntityDialog";
import { loadEntityConfig } from "@/components/config/EntityPageGate";
import { JobForm } from "@/components/config/JobForm";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { loadServer } from "@/lib/data";
import { hubCrumbs, returnTo, serverCrumbs, serverListHref } from "@/lib/nav-core";
import { loadOwnerFacts } from "@/lib/owner";
import { ownerOfJob } from "@/lib/owner-core";

export async function generateMetadata({ params }: { params: Promise<{ id: string; job: string }> }): Promise<Metadata> {
  const { id, job } = await params;
  const server = loadServer(id);
  return entityMetadata(routeName(job), "Edit job", server.name);
}

export default async function EditJobPage({ params, searchParams }: { params: Promise<{ id: string; job: string }>; searchParams: Promise<{ from?: string | string[] }> }) {
  const { id, job: name } = await params;
  const query = await searchParams;
  const server = loadServer(id);
  const config = await loadEntityConfig(id, server);
  // Back to the project's Jobs tab: from the link that opened the form, else from the project that owns the job.
  const { from, project } = returnTo(query.from, ownerOfJob(await loadOwnerFacts(server, { config: config.doc?.model ?? null }), name), "jobs");
  const job = config.doc?.model.jobs?.find((j) => j.name === name);
  if (config.doc && !job) notFound();

  return (
    <>
      <PageHeader
        breadcrumbs={
          project && from
            ? hubCrumbs(project, { label: "Jobs", href: from }, { label: name })
            : serverCrumbs(server, { label: "Configuration", href: `/servers/${id}/config` }, { label: name })
        }
        title={`Edit ${name}`}
        description="Changes are applied by the agent as soon as they are saved."
      />
      {config.doc ? (
        <div className="space-y-10">
          <JobForm
            serverId={id}
            baseHash={config.doc.hash}
            job={job}
            apps={(config.doc.model.apps ?? []).map((a) => ({ name: a.name, envKeys: Object.keys(a.env ?? {}) }))}
            existingNames={(config.doc.model.jobs ?? []).map((j) => j.name)}
            redirectTo={from}
            cancelHref={from}
          />
          <Card className="max-w-3xl border-destructive/40">
            <CardHeader>
              <CardTitle className="text-destructive">Danger zone</CardTitle>
              <CardDescription>Deleting removes the job from the configuration, so it no longer runs on its schedule.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center justify-between gap-4">
              <p className="text-sm">Delete {name} from the configuration.</p>
              <DeleteEntityDialog
                serverId={id}
                baseHash={config.doc.hash}
                entity={{ kind: "job", name }}
                redirectTo={from ?? serverListHref("jobs", id)}
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
