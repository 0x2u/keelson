import { ExternalLinkIcon } from "lucide-react";
import Link from "next/link";
import { PipelineLine } from "@/components/deployments/PipelineLine";
import { EnvChangedBadge } from "@/components/environment/EnvChangedBadge";
import { LocalAddresses } from "@/components/projects/LocalAddresses";
import { VersionSentence } from "@/components/projects/VersionSentence";
import { RelativeTime } from "@/components/relative-time";
import { Notice } from "@/components/states";
import { StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { duration } from "@/lib/format";
import { DefinitionItem, DefinitionList, InlineLink } from "@/components/layout";
import { EYEBROW } from "@/components/signature";
import { failureTitle, servingSentence } from "@/lib/pipeline-core";
import { siteUrl, type DeploymentView, type EnvironmentView } from "@/lib/project-view-core";

/** A deployment as the pipeline helpers read it. */
const asPipeline = (d: DeploymentView) => ({ status: d.status, trigger: d.triggerCode, phases: d.phases, serving_ref: d.servingRef });


/**
 * The environment a project is judged by, readable at a glance: where to open it, whether it is up, which version serves
 * and how it got there, and what is wrong with it (a last deployment that failed, variables its version does not have).
 */
export function ProductionHero({ env, variablesHref }: { env: EnvironmentView; /** The project's Variables tab on this environment: where "variables changed" leads. */ variablesHref?: string }) {
  const { state, latest, serving, serves, deployed } = env;
  const failed = state.lastFailed && latest !== null ? latest : null;
  const [home, ...others] = env.domains;
  return (
    <Card data-testid="production">
      <div className="flex flex-wrap items-start justify-between gap-3 px-6">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className={`${EYEBROW} capitalize`}>{env.name}</h2>
            <StatusBadge view={state} />
            {state.detail !== undefined && <span className="text-xs text-muted-foreground">{state.detail}</span>}
          </div>
          {home !== undefined ? (
            <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <a href={siteUrl(home)} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 items-center gap-1.5 font-display text-xl font-semibold tracking-tight underline-offset-4 hover:underline">
                <span className="truncate">{home}</span>
                <ExternalLinkIcon aria-hidden className="size-4 shrink-0" />
                <span className="sr-only">(opens the site)</span>
              </a>
              {others.length > 0 && <span className="text-xs text-muted-foreground">also {others.join(", ")}</span>}
            </p>
          ) : env.localAddresses.length > 0 ? (
            <LocalAddresses addresses={env.localAddresses} serverName={env.servers[0].name} className="text-lg" />
          ) : (
            <p className="text-sm text-muted-foreground">No public address known for this environment.</p>
          )}
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href={env.href}>Open environment</Link>
        </Button>
      </div>

      {(failed !== null || env.variablesBehind) && (
        <div className="space-y-3 px-6">
          {failed !== null && (
            <Notice
              tone={serves ? "warning" : "danger"}
              title={failureTitle(asPipeline(failed)) ?? "The last deploy failed"}
              action={
                <Button asChild variant="outline" size="sm" className="w-fit">
                  <Link href={`/servers/${env.servers[0].id}/deployments/${failed.id}`}>View the log</Link>
                </Button>
              }
            >
              <p>
                <RelativeTime at={failed.startedAt} /> · {failed.ref.message ?? failed.ref.version}
              </p>
              {failed.error && <p className="font-mono text-xs break-words">{failed.error}</p>}
              <PipelineLine deployment={asPipeline(failed)} />
              <p>{servingSentence(asPipeline(failed)) ?? (serves ? "The version below is still serving." : "Nothing is serving.")}</p>
            </Notice>
          )}
          {env.variablesBehind && <EnvChangedBadge serverId={env.servers[0].id} app={env.app} href={variablesHref} />}
        </div>
      )}

      {latest !== null && latest.status === "running" && latest.phases !== undefined && (
        <div className="px-6">
          <p className="mb-1 text-xs text-muted-foreground">Deploying now</p>
          <PipelineLine deployment={asPipeline(latest)} />
        </div>
      )}

      <div className="px-6">
        <p className="mb-1 text-xs text-muted-foreground">{serves ? "Serving now" : serving ? "Last version that ran" : "Nothing is serving"}</p>
        {serving ? (
          <VersionSentence version={serving} deployment={null} large />
        ) : (
          <p className="text-sm text-muted-foreground">{latest === null ? "Deploy a version to start this environment." : "Deploy a version again to bring it back."}</p>
        )}
      </div>

      <DefinitionList className="grid-cols-2 px-6 sm:grid-cols-3 lg:grid-cols-3">
        {deployed && (
          <>
            <DefinitionItem label="Deployed">
              <RelativeTime at={deployed.startedAt} />
              {deployed.finishedAt && <span className="text-muted-foreground"> · took {duration(deployed.startedAt, deployed.finishedAt)}</span>}
            </DefinitionItem>
            <DefinitionItem label="Started by">
              {deployed.trigger}
            </DefinitionItem>
          </>
        )}
        <DefinitionItem label="Runs on">
          {env.servers.map((s, i) => (
            <span key={s.id}>
              {i > 0 && ", "}
              <InlineLink href={`/servers/${s.id}`}>{s.name}</InlineLink>
            </span>
          ))}
        </DefinitionItem>
      </DefinitionList>
    </Card>
  );
}
