import { LoadError } from "@/components/LoadError";
import { entityMetadata, routeName } from "@/lib/metadata";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { ICONS } from "@/lib/icons";
import { loadAppEnvironment } from "@/lib/app-environment";
import { agentFor } from "@/lib/agent";
import { load, loadServer } from "@/lib/data";
import { EnvironmentEditor } from "@/components/environment/EnvironmentEditor";
import { PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { Notice } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { redeployHref } from "@/lib/app-config-core";
import { scopeLabel, scopeLabels } from "@/lib/env-core";
import { canRunApps } from "@/lib/machine-core";
import { serverCrumbs } from "@/lib/nav-core";
import { hasHubPages } from "@/lib/owner-core";
import { environmentOf, projectOf } from "@/lib/projects-core";
import { appVariablesHref } from "@/lib/redirects-core";
import { cn } from "@/lib/utils";

export async function generateMetadata({ params }: { params: Promise<{ id: string; app: string }> }): Promise<Metadata> {
  const { id, app } = await params;
  const server = loadServer(id);
  return entityMetadata(routeName(app), "Variables", server.name);
}

export default async function EnvironmentPage({ params, searchParams }: { params: Promise<{ id: string; app: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id, app: name }, query] = await Promise.all([params, searchParams]);
  const server = loadServer(id);
  const machine = !canRunApps(server);
  // The variables of an app of a project are the project's Variables tab; only a preview instance keeps this page.
  const listed = (await load(agentFor(server).apps())).data?.find((a) => a.name === name);
  if (listed && hasHubPages(listed)) redirect(appVariablesHref(projectOf(listed), id, name, query));
  const environment = environmentOf(listed ?? { environment: "" });
  const base = `/servers/${id}/apps/${encodeURIComponent(name)}`;
  const breadcrumbs = serverCrumbs(server, { label: name, href: base }, { label: "Variables" });
  const title = "Variables";

  const env = await loadAppEnvironment(server, name, query.scope);
  if (env.kind === "apps-error") {
    return (
      <>
        <PageHeader title={title} breadcrumbs={breadcrumbs} />
        <LoadError title={`Could not load ${server.name}`} back={{ href: `/servers/${id}`, label: `Back to ${server.name}` }}>
          {env.error}
        </LoadError>
      </>
    );
  }
  if (env.kind === "missing") notFound();

  const header = <PageHeader title={title} breadcrumbs={breadcrumbs} description={`What ${name} runs with, kept on the server. A value is write-only: once saved it is never shown again.`} />;

  if (env.kind === "vars-error") {
    return (
      <>
        {header}
        <Notice title="Could not load the variables">{env.error}</Notice>
      </>
    );
  }
  if (env.kind === "too-old") {
    return (
      <>
        {header}
        <Notice
          tone="warning"
          title="This agent is too old to manage variables"
          action={
            machine ? undefined : (
              <Link href={`/servers/${id}/update`} className="text-sm font-medium underline underline-offset-4">
                Update the agent
              </Link>
            )
          }
        >
          {machine
            ? `Variables set from here need a newer Keelson agent on ${server.name}: download the current one there and run keelson-agent connect again.`
            : `Variables set from here need a newer Keelson agent on ${server.name}. Update it from the server's page, then come back.`}
        </Notice>
      </>
    );
  }

  const { scope, hasPreviews, vars, servingImage, rules, pending, changed } = env;
  return (
    <>
      {header}
      <div className="space-y-4">
        {hasPreviews && (
          <nav aria-label="Scope" className="flex w-fit gap-1 rounded-lg bg-muted p-[3px]">
            {scopeLabels(environment).map((s) => (
              <Link
                key={s.scope}
                href={s.scope === "app" ? `${base}/environment` : `${base}/environment?scope=preview`}
                aria-current={s.scope === scope ? "page" : undefined}
                className={cn(
                  "rounded-md px-3 py-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                  s.scope === scope && "bg-background text-foreground shadow-sm",
                )}
              >
                {s.label}
              </Link>
            ))}
          </nav>
        )}

        {!server.canDeploy && (
          <Notice tone="warning" title="This server is read-only here">
            It has no deploy secret in the dashboard, so variables can be listed but not changed.
          </Notice>
        )}

        {pending && (
          <Notice
            tone="warning"
            title="Changed since the running version"
            action={
              <Button asChild size="sm" className="w-fit">
                <Link href={redeployHref(id, name, servingImage)}>
                  <ICONS.deploy />
                  Deploy
                </Link>
              </Button>
            }
          >
            The variables were changed <RelativeTime at={pending.changedAt} /> and {name} runs with the ones it was deployed with. Deploy to apply them.
          </Notice>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="capitalize">{scopeLabel(scope, environment)}</CardTitle>
            <CardDescription>
              {scope === "app" ? (
                <>
                  Passed to the container of {name} when it is deployed. They win over the same name in <span className="font-mono">env_file</span> and <span className="font-mono">env:</span> of the apps
                  file.
                </>
              ) : (
                <>
                  Passed to every preview of {name}. A preview never inherits the app&apos;s own variables, <span className="font-mono">env_file</span> or <span className="font-mono">env:</span>: put here what
                  the previews need, with values meant for them.
                </>
              )}
              {changed !== null && (
                <>
                  {" "}
                  Last change <RelativeTime at={changed} />.
                </>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <EnvironmentEditor key={scope} serverId={id} app={name} scope={scope} vars={vars.vars} canDeploy={server.canDeploy} servingImage={servingImage} rules={rules} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
