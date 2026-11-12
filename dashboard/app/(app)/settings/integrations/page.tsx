import Link from "next/link";
import type { Metadata } from "next";
import { ICONS } from "@/lib/icons";
import { headers } from "next/headers";
import { PageHeader } from "@/components/page-header";
import { AdvancedSetup } from "@/components/repository/AdvancedSetup";
import { Button } from "@/components/ui/button";
import { CloudflareCard, type CloudflareZones } from "@/components/domains/CloudflareCard";
import { GithubAppCard } from "@/components/repository/GithubAppCard";
import { GithubConnectionCard } from "@/components/repository/GithubConnectionCard";
import { GithubIntegrationCard, type InstallationsView } from "@/components/repository/GithubIntegrationCard";
import { GithubWebhookCard } from "@/components/repository/GithubWebhookCard";
import { Notice } from "@/components/states";
import { publicUrl, secureCookies, trustProxy } from "@/lib/env";
import { GithubAppError, installationOverview, invalidateInstalledRepos } from "@/lib/github-app";
import { listZones } from "@/lib/cloudflare";
import { CloudflareError } from "@/lib/cloudflare-core";
import { connectBase } from "@/lib/github-connect";
import { FAILURES, defaultAppName, isFailureCode } from "@/lib/github-connect-core";
import { webhookUrl } from "@/lib/github-webhook-core";
import { cloudflareSummary, cloudflareToken, githubAppSummary, githubConnection, webhookSecretSince } from "@/lib/integrations";

export const metadata: Metadata = { title: "Integrations" };

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const one = (name: string) => (typeof query[name] === "string" ? query[name] : undefined);
  const returned = one("github") === "installed";
  const failure = one("github_error");
  // Coming back from the installation: GitHub knows something the listing kept for a minute does not.
  if (returned) invalidateInstalledRepos();

  const h = await headers();
  const url = webhookUrl({
    publicUrl: publicUrl(),
    host: h.get("host"),
    forwardedHost: h.get("x-forwarded-host"),
    forwardedProto: h.get("x-forwarded-proto"),
    trustProxy: trustProxy(),
    secure: secureCookies(),
  });

  const app = githubAppSummary();
  let installations: InstallationsView | null = null;
  let error: string | null = null;
  if (app) {
    try {
      const overview = await installationOverview();
      installations = { installations: overview.installations, repos: overview.repos.map((r) => ({ fullName: r.fullName, private: r.private })), truncated: overview.truncated, warnings: overview.warnings };
    } catch (err) {
      error = err instanceof GithubAppError ? err.message : "Could not ask GitHub about the installations.";
    }
  }
  const cloudflare = cloudflareSummary();
  let zones: CloudflareZones | null = null;
  let zonesError: string | null = null;
  const cloudflareSecret = cloudflare ? cloudflareToken() : null;
  if (cloudflareSecret !== null) {
    try {
      const listed = await listZones(cloudflareSecret);
      zones = { names: listed.zones.map((z) => z.name), truncated: listed.truncated };
    } catch (err) {
      zonesError = err instanceof CloudflareError ? err.message : "Could not ask Cloudflare for the zones.";
    }
  }
  const base = connectBase();
  const secretSince = webhookSecretSince();

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Integrations" }]}
        title="Integrations"
        description="Outside services this dashboard reads from or hears from. Their credentials are stored encrypted and only used from the server."
        actions={
          githubAppSummary() !== null && (
            <Button asChild size="sm">
              <Link href="/projects/new">
                <ICONS.add />
                New project
              </Link>
            </Button>
          )
        }
      />
      <div className="grid max-w-5xl grid-cols-[minmax(0,1fr)] gap-6">
        {failure !== undefined && (
          <Notice title="GitHub was not connected">{isFailureCode(failure) ? FAILURES[failure] : "The connection did not finish. Start again with Connect GitHub."}</Notice>
        )}
        {returned && app && installations !== null && installations.installations > 0 && (
          <Notice tone="info" title="The App is installed">
            The repositories it can reach are listed below.
          </Notice>
        )}
        <GithubIntegrationCard
          app={app ? { appId: app.appId, slug: app.slug, name: app.name, owner: app.owner } : null}
          installations={installations}
          error={error}
          defaultName={defaultAppName()}
          publicUrlProblem={base.ok ? null : base.error}
          replacing={app !== null || secretSince !== null}
        />
        <CloudflareCard connection={cloudflare} zones={zones} error={zonesError} />
        <AdvancedSetup>
          <GithubAppCard app={app} webhookSecretSet={secretSince !== null} />
          <GithubConnectionCard account={githubConnection()?.account ?? null} />
          <GithubWebhookCard url={url} since={secretSince} />
        </AdvancedSetup>
      </div>
    </>
  );
}
