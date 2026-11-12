"use client";

import { useActionState, useId, useState } from "react";
import { toast } from "sonner";
import { setBuildServerAction, type GithubState } from "@/app/github-actions";
import { ServerStatsLine } from "@/components/ServerStatsLine";
import { Notice } from "@/components/states";
import { StepUpAction } from "@/components/unlock";
import { Button } from "@/components/ui/button";
import { BuildVariables } from "@/components/repository/BuildVariables";
import { buildVarsView, describeLimits, notSentWarning, type BuildServerChoice, type BuildVarsRead, type NotSent } from "@/lib/build-elsewhere-core";
import { ICONS } from "@/lib/icons";
import { formatBytes, parseBuildMemory, ramFit, type Fit, type ServerStats } from "@/lib/server-stats-core";
import { toastCopy } from "@/lib/toast-core";
import { cn } from "@/lib/utils";

const FIT_TEXT: Record<Fit, (need: string) => string | null> = {
  ok: () => null,
  tight: (need) => `A ${need} build fits, with little left for the rest.`,
  short: (need) => `Not enough free memory for a ${need} build right now.`,
  unknown: () => null,
};

interface Card {
  /** The server's id; empty for the app's own. */
  value: string;
  title: string;
  detail: string;
  stats: ServerStats;
  /** What a build takes here, in bytes; undefined when the app has no build block of its own to size. */
  need?: number;
  /** Why it cannot be chosen. */
  disabled?: string | null;
  note?: string | null;
}

/**
 * Where the app is built: its own server, or any other server (which builds it as a request, then the image is sent to this
 * one and deployed here). Each server is shown with its numbers and what it accepts to build, and with whether a build of
 * the app's size fits in its free memory now. A server that cannot take the build says why. When another server is chosen, the
 * build variables it keeps for the app are shown and set below: a build there uses them, not the app's own stored ones, and
 * what the app has stored for build time on its own server and the builder lacks is named before building.
 */
export function BuildServerForm({
  serverId,
  ownName,
  ownStats,
  ownMemory,
  app,
  current,
  choices,
  notSent,
  buildVars,
}: {
  serverId: string;
  ownName: string;
  ownStats: ServerStats;
  /** The app's own `build.memory`, when it has a build block. */
  ownMemory?: string;
  app: string;
  /** The id of the server that builds it now; null = its own. */
  current: string | null;
  choices: BuildServerChoice[];
  notSent: NotSent;
  /** What each server that can be chosen (and the one that builds it now) keeps as build variables for the app, by server id. */
  buildVars: Record<string, BuildVarsRead>;
}) {
  const [state, action, pending] = useActionState<GithubState, FormData>(async (prev, form) => {
    const next = await setBuildServerAction(serverId, app, prev, form);
    if (next.ok) toast.success(toastCopy.saved("build server"));
    return next;
  }, {});
  const id = useId();
  const selectedAtStart = current ?? "";
  const [selected, setSelected] = useState(selectedAtStart);
  const need = ownMemory === undefined ? undefined : parseBuildMemory(ownMemory);

  const cards: Card[] = [
    { value: "", title: ownName, detail: "This server builds and runs it", stats: ownStats, need },
    ...choices.map(
      (c): Card => ({
        value: c.serverId,
        title: c.name,
        detail: "Builds it there, then the image is sent here",
        stats: c.stats,
        need,
        disabled: c.disabled,
        note: c.note,
      }),
    ),
  ];
  // A server that is no longer registered stays visible while it is the saved choice, so that it can be changed away from.
  if (current !== null && !choices.some((c) => c.serverId === current)) {
    cards.push({ value: current, title: current, detail: "No longer registered in this dashboard", stats: { online: false }, disabled: "This server is not registered here any more: choose another." });
  }
  const builder = selected === "" ? null : cards.find((c) => c.value === selected);
  const read = builder ? buildVars[builder.value] : undefined;
  const onBuilder = read !== undefined && "names" in read ? read.names.map((n) => n.name) : [];
  const warning = builder ? notSentWarning(notSent, { app, ownName, buildServer: builder.title, onBuilder }) : null;

  return (
    <div className="grid gap-4">
      <form action={action} className="grid gap-3">
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">Build on</legend>
          <input type="hidden" name="builder" value={selected} />
          <div role="radiogroup" aria-label="Build on" className="grid gap-2 sm:grid-cols-2">
            {cards.map((c) => {
              const on = c.value === selected;
              const fit = c.need === undefined ? "unknown" : ramFit(c.stats, c.need);
              const fitWarning = c.need === undefined ? null : FIT_TEXT[fit](formatBytes(c.need));
              const disabled = c.disabled !== undefined && c.disabled !== null && !on;
              const key = c.value || "own";
              return (
                <label
                  key={key}
                  className={cn(
                    "flex flex-col gap-1.5 rounded-lg border bg-card p-3 text-sm transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring",
                    disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-accent",
                    on && "border-primary bg-accent",
                    !c.stats.online && !disabled && "opacity-70",
                  )}
                >
                  <input type="radio" name={`${id}-choice`} checked={on} disabled={disabled} onChange={() => setSelected(c.value)} className="sr-only" aria-describedby={`${id}-${key}-detail`} />
                  <span className="flex items-center gap-2 font-medium">
                    <ICONS.server aria-hidden className="size-4 text-muted-foreground" />
                    {c.title}
                    <span className={cn("ml-auto size-2 rounded-full", c.stats.online ? "bg-success" : "bg-muted-foreground/40")} title={c.stats.online ? "Online" : "Not answering"} />
                  </span>
                  <span id={`${id}-${key}-detail`} className="text-xs text-muted-foreground">
                    {c.detail}
                  </span>
                  {c.stats.os !== undefined && c.stats.arch !== undefined && <span className="font-mono text-xs text-muted-foreground">{`${c.stats.os}/${c.stats.arch}`}</span>}
                  <ServerStatsLine stats={c.stats} needBytes={c.need} />
                  {c.stats.build && <span className="text-xs text-muted-foreground" data-testid="build-limits">Takes builds: {describeLimits(c.stats.build)}</span>}
                  {c.disabled && <span className="text-xs text-destructive">{c.disabled}</span>}
                  {c.note && <span className="text-xs text-warning-text">{c.note}</span>}
                  {fitWarning && <span className={cn("text-xs", fit === "short" ? "text-destructive" : "text-warning-text")}>{fitWarning}</span>}
                </label>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            A build needs memory a small server may not have to spare. The server that builds keeps the image: the dashboard sends it to this one and deploys it here. Any server whose agent
            takes builds can be chosen, a laptop that connects to Keelson included; the app&apos;s <span className="font-mono">build:</span> block is sent with each build and must be within the
            limits the server states. <span className="font-mono">network: host</span> is sent only to a server that allows it (<span className="font-mono">build_limits.host_network</span>), so that a
            build can reach a database tunnelled on the builder&apos;s host; a named network is not sent, it names a Docker network of this server.
          </p>
        </fieldset>
        {warning && (
          <Notice
            tone="warning"
            title={warning.title}
            action={
              <a href={warning.href} className="text-sm underline underline-offset-4">
                Set them in the build variables of {builder?.title}
              </a>
            }
          >
            {warning.body}
          </Notice>
        )}
        {state.error && (
          <Notice title="Could not save" action={<StepUpAction error={state.error} />}>
            {state.error}
          </Notice>
        )}
        <div>
          <Button type="submit" variant="outline" loading={pending} disabled={selected === selectedAtStart}>
            Save
          </Button>
        </div>
      </form>
      {builder && read !== undefined && (
        <BuildVariables appServerId={serverId} builderId={builder.value} builderName={builder.title} app={app} canDeploy={!builder.disabled} view={buildVarsView({ app, ownName, builder: builder.title, read, notSent })} />
      )}
    </div>
  );
}
