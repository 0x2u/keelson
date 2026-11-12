import Link from "next/link";
import { ICONS } from "@/lib/icons";
import { EnvironmentEditor } from "@/components/environment/EnvironmentEditor";
import { RelativeTime } from "@/components/relative-time";
import { Notice } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { redeployHref } from "@/lib/app-config-core";
import { fileEnvironment, fileEnvironmentNote } from "@/lib/app-environment-core";
import type { AppEnvironment } from "@/lib/app-environment";
import { scopeLabel, scopeLabels } from "@/lib/env-core";
import { placementSlot, variablesHref, type VariablesTarget } from "@/lib/project-variables-core";
import { InlineLink, SegmentedNav } from "@/components/layout";

/**
 * The variables of one app of a project: pick the environment (and the app when it has several), then the real editor. The
 * values are write-only, so nothing here shows one. `machine`: the server serves no traffic and runs no apps itself, which
 * changes how an old agent is updated.
 */
export function ProjectVariables({ project, target, env, machine }: { project: string; target: VariablesTarget; env: AppEnvironment; machine: boolean }) {
  const { environments, env: current, chosen } = target;
  const { server, app } = chosen;
  const slot = placementSlot(chosen);
  const scope = env.kind === "ready" ? env.scope : "app";
  const keep = (over: { env?: string; app?: string; scope?: "preview" } = {}) => variablesHref(project, over);

  return (
    <div className="space-y-4">
      {(environments.length > 1 || current.placements.length > 1) && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          {environments.length > 1 && (
            <SegmentedNav
              label="Environment"
              items={environments.map((e) => ({ key: e.name, label: e.name, href: keep({ env: e.name }), current: e.name === current.name, className: "capitalize" }))}
            />
          )}
          {current.placements.length > 1 && (
            <SegmentedNav
              label="App"
              items={current.placements.map((p) => ({
                key: placementSlot(p),
                href: keep({ env: current.name, app: placementSlot(p) }),
                current: placementSlot(p) === slot,
                label: (
                  <>
                    {p.app.name}
                    <span className="ml-1.5 font-normal text-muted-foreground">on {p.server.name}</span>
                  </>
                ),
              }))}
            />
          )}
        </div>
      )}

      {env.kind === "apps-error" && <Notice title={`Could not load ${server.name}`}>{env.error}</Notice>}
      {env.kind === "missing" && (
        <Notice tone="warning" title={`${app.name} is no longer on ${server.name}`}>
          The server does not list this app any more. Reload the page to see what the project has now.
        </Notice>
      )}
      {env.kind === "vars-error" && <Notice title="Could not load the variables">{env.error}</Notice>}
      {env.kind === "too-old" && (
        <Notice
          tone="warning"
          title="This agent is too old to manage variables"
          action={
            machine ? undefined : (
              <InlineLink href={`/servers/${server.id}/update`} className="text-sm underline">
                Update the agent
              </InlineLink>
            )
          }
        >
          {machine
            ? `Variables set from here need a newer Keelson agent on ${server.name}: download the current one there and run keelson-agent connect again.`
            : `Variables set from here need a newer Keelson agent on ${server.name}. Update it from the server's page, then come back.`}
        </Notice>
      )}

      {env.kind === "ready" && (
        <>
          {env.hasPreviews && (
            <SegmentedNav
              label="Scope"
              items={scopeLabels(current.name).map((s) => ({
                key: s.scope,
                label: s.label,
                href: keep({ env: current.name, app: slot, scope: s.scope === "app" ? undefined : "preview" }),
                current: s.scope === scope,
                className: "capitalize",
              }))}
            />
          )}

          {!server.canDeploy && (
            <Notice tone="warning" title="This server is read-only here">
              Its deploy access is not in the dashboard, so variables can be listed but not changed. Add it in the server settings.
            </Notice>
          )}

          {env.pending && (
            <Notice
              tone="warning"
              title="Changed since the running version"
              action={
                <Button asChild size="sm" className="w-fit">
                  <Link href={redeployHref(server.id, app.name, env.servingImage)}>
                    <ICONS.deploy />
                    Deploy
                  </Link>
                </Button>
              }
            >
              The variables were changed <RelativeTime at={env.pending.changedAt} /> and {app.name} runs with the ones it was deployed with. Deploy to apply them.
            </Notice>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-baseline gap-x-2">
                <span className="capitalize">{scopeLabel(scope, current.name)}</span>
                <span className="text-sm font-normal text-muted-foreground">
                  Variables of {scope === "app" ? "" : "the previews of "}
                  {app.name} on {server.name}
                </span>
              </CardTitle>
              <CardDescription>
                {scope === "app" ? (
                  <>
                    Passed to the container of {app.name} when it is deployed. A value is write-only: once saved it is never shown again. They win over the same name in{" "}
                    <span className="font-mono">env_file</span> and <span className="font-mono">env:</span> of the server&apos;s configuration.
                  </>
                ) : (
                  <>
                    Passed to every preview of {app.name}. A preview never inherits the app&apos;s own variables, <span className="font-mono">env_file</span> or <span className="font-mono">env:</span>: put
                    here what the previews need, with values meant for them.
                  </>
                )}
                {env.changed !== null && (
                  <>
                    {" "}
                    Last change <RelativeTime at={env.changed} />.
                  </>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <FileSources env={env} scope={scope} />
              <EnvironmentEditor key={`${slot}-${scope}`} serverId={server.id} app={app.name} scope={scope} vars={env.vars.vars} canDeploy={server.canDeploy} servingImage={env.servingImage} rules={env.rules} />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

/** Which `env_file` and `env:` of the apps file also reach the app (names only): they are not managed here, and the managed values win over them. */
function FileSources({ env, scope }: { env: Extract<AppEnvironment, { kind: "ready" }>; scope: "app" | "preview" }) {
  if (scope !== "app") return null;
  const file = fileEnvironment(env.appConfig);
  const note = fileEnvironmentNote(file);
  if (note === null) {
    return <p className="text-sm text-muted-foreground">The server&apos;s configuration gives this app no env_file or env: everything it runs with is listed below.</p>;
  }
  return (
    <div className="rounded-lg border bg-muted/40 p-3 text-sm" data-testid="file-environment">
      <p>{note}</p>
      {file.envKeys.length > 0 && (
        <p className="mt-1 break-words text-xs text-muted-foreground">
          <span className="font-mono">env:</span> {file.envKeys.map((k, i) => (
            <span key={k}>
              {i > 0 && ", "}
              <span className="font-mono">{k}</span>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
