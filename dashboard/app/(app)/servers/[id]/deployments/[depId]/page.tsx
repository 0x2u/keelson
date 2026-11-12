import { LoadError } from "@/components/LoadError";
import { entityMetadata, routeName } from "@/lib/metadata";
import Link from "next/link";
import type { Metadata } from "next";
import { agentFor } from "@/lib/agent";
import { load, loadServer } from "@/lib/data";
import { duration } from "@/lib/format";
import { triggerLabel } from "@/lib/labels-core";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DeploymentBadge } from "@/components/status";
import { PageHeader } from "@/components/page-header";
import { Notice } from "@/components/states";
import { RelativeTime } from "@/components/relative-time";
import { ImageRef } from "@/components/image-ref";
import { DeploymentLog } from "@/components/DeploymentLog";
import { DeploymentPipeline } from "@/components/deployments/DeploymentPipeline";
import { failureTitle, servingSentence } from "@/lib/pipeline-core";
import { entityCrumbs, serverCrumbs } from "@/lib/nav-core";
import { projectOfApp } from "@/lib/owner";

export async function generateMetadata({ params }: { params: Promise<{ id: string; depId: string }> }): Promise<Metadata> {
  const { id, depId } = await params;
  const server = loadServer(id);
  return entityMetadata(routeName(depId), server.name, "Deployment");
}

export default async function DeploymentPage({ params }: { params: Promise<{ id: string; depId: string }> }) {
  const { id, depId } = await params;
  const server = loadServer(id);
  const dep = await load(agentFor(server).deployment(depId));

  if (dep.error !== undefined) {
    return (
      <>
        <PageHeader title="Deployment" breadcrumbs={serverCrumbs(server, { label: depId.slice(0, 8) })} />
        <LoadError title="Could not load this deployment" back={{ href: `/servers/${id}`, label: `Back to ${server.name}` }}>
          {dep.error}
        </LoadError>
      </>
    );
  }
  const d = dep.data;
  const owner = await projectOfApp(server, d.app);
  const failure = failureTitle(d);
  const serving = servingSentence(d);

  return (
    <>
      <PageHeader
        breadcrumbs={entityCrumbs(owner, "apps", server, { label: d.app, href: `/servers/${id}/apps/${encodeURIComponent(d.app)}` }, { label: d.id.slice(0, 8) })}
        title={`Deployment of ${d.app}`}
        status={<DeploymentBadge status={d.status} trigger={d.trigger} image={d.ref} />}
      />

      <div className="space-y-6">
        <DeploymentPipeline deployment={d} />

        {failure !== null && (
          <Notice title={failure} tone={d.status === "rolled_back" ? "warning" : "danger"}>
            <div className="space-y-2">
              {d.error ? <p className="whitespace-pre-wrap break-words">{d.error}</p> : <p>The agent did not record a cause. The log below shows where it stopped.</p>}
              {serving !== null && <p className="font-medium">{serving}</p>}
            </div>
          </Notice>
        )}

        <Card>
          <CardContent>
            <dl className="grid gap-x-8 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-5">
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">Image</dt>
                <dd className="mt-1">
                  <ImageRef value={d.ref} />
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">Replaced</dt>
                <dd className="mt-1">
                  {d.previous_ref ? (
                    <ImageRef value={d.previous_ref} />
                  ) : (
                    <span className="text-muted-foreground">Nothing</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Trigger</dt>
                <dd className="mt-1">{triggerLabel(d.trigger)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Started</dt>
                <dd className="mt-1">
                  <RelativeTime at={d.started_at} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Duration</dt>
                <dd className="tabular mt-1">{d.finished_at ? duration(d.started_at, d.finished_at) : "In progress"}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Log</CardTitle>
          </CardHeader>
          <CardContent>
            <DeploymentLog serverId={id} deployment={d} />
          </CardContent>
        </Card>

        <p className="text-sm text-muted-foreground">
          <Link href={`/servers/${id}/apps/${d.app}`} className="font-medium text-foreground underline-offset-4 hover:underline">
            Back to {d.app}
          </Link>
        </p>
      </div>
    </>
  );
}
