import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { ReleaseStatus } from "@/components/settings/ReleaseSummary";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingsIndex } from "@/components/settings/SettingsIndex";
import { agentFor } from "@/lib/agent";
import { bundledAgentVersion, dashboardVersion } from "@/lib/agent-binaries";
import { releaseNotesUrl } from "@/lib/agent-binaries-core";
import { listApiTokensWithStatus } from "@/lib/api-tokens";
import { listPasskeys, totpEnabled } from "@/lib/auth/store";
import { load } from "@/lib/data";
import { lastBackupAt } from "@/lib/dashboard-backup";
import { dashboardBackupItem } from "@/lib/readiness-core";
import { cloudflareSummary, githubAppSummary, githubConnection } from "@/lib/integrations";
import { getCredentials, listServers } from "@/lib/servers";
import { notificationState, settingsCards, type NotificationState } from "@/lib/settings-core";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

async function notificationsOf(id: string): Promise<NotificationState> {
  const creds = getCredentials(id);
  if (!creds) return { kind: "unknown", reason: "this server is no longer registered" };
  return notificationState(await load(agentFor(creds).config()));
}

export default async function SettingsPage() {
  const now = Date.now(); // eslint-disable-line react-hooks/purity -- a server component renders once per request
  const app = githubAppSummary();
  const cloudflare = cloudflareSummary();
  const cards = settingsCards({
    totp: totpEnabled(),
    passkeys: listPasskeys().length,
    tokens: listApiTokensWithStatus().map((t) => t.status),
    githubApp: app ? { label: app.name ?? app.slug ?? app.appId } : null,
    githubAccount: githubConnection()?.account ?? null,
    cloudflare: cloudflare ? { expiresOn: cloudflare.expiresOn } : null,
    backup: dashboardBackupItem(lastBackupAt(), now),
    now,
  });
  const version = dashboardVersion();
  const notifications = await Promise.all(listServers().map(async (s) => ({ id: s.id, name: s.name, state: await notificationsOf(s.id) })));

  return (
    <>
      <PageHeader title="Settings" description="This dashboard's own settings: who can sign in, what can call its API, and the outside services it talks to." />
      <SettingsIndex
        cards={cards}
        notifications={notifications}
        about={{ version, agent: bundledAgentVersion(), releaseNotes: releaseNotesUrl(version) }}
        release={
          <Suspense fallback={<Skeleton className="h-20 w-full max-w-3xl rounded-xl" />}>
            <ReleaseStatus />
          </Suspense>
        }
      />
    </>
  );
}
