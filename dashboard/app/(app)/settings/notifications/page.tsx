import type { Metadata } from "next";
import { NotificationsFleet } from "@/components/notifications/NotificationsFleet";
import { PageHeader } from "@/components/page-header";
import { loadNotificationsFleet } from "@/lib/notifications-fleet";

export const metadata: Metadata = { title: "Notifications" };
export const dynamic = "force-dynamic";

export default async function NotificationsSettingsPage() {
  const { rows, template, templateUpdatedAt } = await loadNotificationsFleet();
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Notifications" }]}
        title="Notifications"
        description="Where each server reports deployments, apps going down and failing jobs. Servers that need a look come first; a row opens that server's own settings."
      />
      <NotificationsFleet rows={rows} template={template} templateUpdatedAt={templateUpdatedAt} />
    </>
  );
}
