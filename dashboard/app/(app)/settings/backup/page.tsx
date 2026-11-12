import type { Metadata } from "next";
import { DownloadCopyButton } from "@/components/settings/DownloadCopyButton";
import { DefinitionItem, DefinitionList } from "@/components/layout";
import { PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { Notice } from "@/components/states";
import { StatusDot } from "@/components/status";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { lastBackupAt } from "@/lib/dashboard-backup";
import { keySource, masterKeyFile } from "@/lib/env";
import { dashboardBackupItem, STALE_AFTER_DAYS } from "@/lib/readiness-core";
import { READINESS } from "@/lib/status";

export const metadata: Metadata = { title: "Backup" };
export const dynamic = "force-dynamic";

export default function BackupSettingsPage() {
  const last = lastBackupAt();
  const item = dashboardBackupItem(last, Date.now()); // eslint-disable-line react-hooks/purity -- a server component renders once per request
  const view = READINESS[item.state];
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Backup" }]}
        title="Backup"
        description="This dashboard keeps its servers, tokens and settings in one file on one machine. Download a copy now and then: without one, losing that machine means adding every server again."
      />
      <div className="grid max-w-3xl grid-cols-[minmax(0,1fr)] gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Download a copy</CardTitle>
            <CardDescription>
              A consistent copy of the dashboard&apos;s database, made while it runs. It needs your password and an authenticator code (unlock changes first), and is recorded in the audit log. A copy older than {STALE_AFTER_DAYS.dashboardBackup} days counts as out of date in the readiness checklist.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <DefinitionList className="sm:grid-cols-2 lg:grid-cols-2">
              <DefinitionItem label="Last copy">
                {last === null ? (
                  "Never downloaded"
                ) : (
                  <RelativeTime at={last} />
                )}
              </DefinitionItem>
              <DefinitionItem label="Readiness">
                <span className="flex items-center gap-2" data-testid="backup-state" data-state={item.state}>
                  <StatusDot tone={view.tone} />
                  {view.label}
                </span>
              </DefinitionItem>
            </DefinitionList>
            <DownloadCopyButton label={last === null ? "Download a copy" : "Download a new copy"} />
          </CardContent>
        </Card>

        <Notice tone="warning" title="The key is not in the copy">
          Server credentials and secrets in the copy are encrypted with the master key, which is never part of the download: a copy cannot be opened without it.{" "}
          {keySource() === "environment" ? (
            <>
              Here the key is the <span className="font-mono">KEELSON_DASHBOARD_KEY</span> environment variable of the dashboard: save its value separately (a password manager is fine).
            </>
          ) : (
            <>
              Keelson generated the key and keeps it in <span className="font-mono">{masterKeyFile()}</span>, next to the database. The recovery file offered at setup holds a copy: keep it apart from the data volume, so that losing the volume does not lose the key.
            </>
          )}{" "}
          Signed-in sessions are not in the copy either, so sign in again after a restore.
        </Notice>

        <Card>
          <CardHeader>
            <CardTitle>Restoring a copy</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              Stop the dashboard, put the copy in the data directory as <span className="font-mono text-foreground">dashboard.db</span> (the directory named by <span className="font-mono text-foreground">KEELSON_DASHBOARD_DATA_DIR</span>), and start it with the same master key: the{" "}
              <span className="font-mono text-foreground">KEELSON_DASHBOARD_KEY</span> variable, or <span className="font-mono text-foreground">master.key</span> in that directory. Every server, token and setting is back. The admin password set in the browser is not in the copy: set it again at the first visit, or start with <span className="font-mono text-foreground">KEELSON_ADMIN_PASSWORD_HASH</span>.
            </p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
