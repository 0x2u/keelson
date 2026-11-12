import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import type { Metadata } from "next";
import { DeleteEntityDialog } from "@/components/config/DeleteEntityDialog";
import { loadEntityConfig } from "@/components/config/EntityPageGate";
import { NotificationsForm } from "@/components/config/NotificationsForm";
import { PageHeader } from "@/components/page-header";
import { TestAlertDialog } from "@/components/readiness/TestAlertDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { loadServer } from "@/lib/data";
import { entityMetadata } from "@/lib/metadata";
import { notificationsHref } from "@/lib/redirects-core";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return entityMetadata("Notifications", loadServer(id).name);
}

/** The notifications of one server: the whole section as a form. The fleet table at Settings > Notifications links here. */
export default async function ServerNotificationsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const server = loadServer(id);
  const config = await loadEntityConfig(id, server);
  const notifications = config.doc?.model.notifications;
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Notifications", href: notificationsHref() }, { label: server.name }]}
        title={`Notifications of ${server.name}`}
        description="Where this server reports deployments, apps going down and failing jobs."
        actions={
          <>
            <Button asChild variant="outline">
              <Link href={notificationsHref()}>
                <ArrowLeftIcon />
                All servers
              </Link>
            </Button>
            {notifications && <TestAlertDialog serverId={id} serverName={server.name} canDeploy={server.canDeploy} />}
          </>
        }
      />
      {config.doc ? (
        <div className="space-y-8">
          <NotificationsForm serverId={id} baseHash={config.doc.hash} notifications={notifications} />
          {notifications && (
            <Card className="max-w-3xl border-destructive/40">
              <CardHeader>
                <CardTitle className="text-destructive">Danger zone</CardTitle>
                <CardDescription>Removing deletes the whole notifications section, including the stored webhook and heartbeat URLs.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center justify-between gap-4">
                <p className="text-sm">Stop sending notifications from {server.name}.</p>
                <DeleteEntityDialog serverId={id} baseHash={config.doc.hash} entity={{ kind: "notifications" }} redirectTo={notificationsHref()} />
              </CardContent>
            </Card>
          )}
        </div>
      ) : (
        config.notice
      )}
    </>
  );
}
