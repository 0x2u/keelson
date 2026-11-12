"use client";

import { CheckCircle2Icon, ExternalLinkIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { CodeBlock } from "@/components/servers/install-outcome";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import type { ImageOutcome, Reach } from "@/lib/new-project-image-core";
import { projectHref } from "@/lib/nav-core";

/** How to open the app, in words that say where the address works and what to do when it does not from here. */
function ReachBlock({ reach, serverName, dnsNote }: { reach: Reach; serverName: string; dnsNote: string | null }) {
  if (reach.kind === "domain") {
    return (
      <div className="space-y-1.5 text-sm" data-testid="reach">
        <p className="font-medium">Where to open it</p>
        <p>
          <a href={reach.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-mono text-sm underline underline-offset-4">
            {reach.url}
            <ExternalLinkIcon aria-hidden className="size-3.5" />
            <span className="sr-only">(opens the site)</span>
          </a>{" "}
          answers once the deployment is live and the name leads to the server.
        </p>
        {dnsNote !== null && <p className="text-muted-foreground">{dnsNote}</p>}
      </div>
    );
  }
  if (reach.kind === "none") {
    return (
      <div className="space-y-1.5 text-sm" data-testid="reach">
        <p className="font-medium">Where to open it</p>
        <p className="text-muted-foreground">It publishes no port and has no domain, so nothing outside the server reaches it. Its logs are on the app&apos;s page.</p>
      </div>
    );
  }
  return (
    <div className="space-y-1.5 text-sm" data-testid="reach">
      <p className="font-medium">Where to open it</p>
      {reach.url !== null ? (
        <p>
          <a href={reach.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-mono text-sm underline underline-offset-4">
            {reach.address}
            <ExternalLinkIcon aria-hidden className="size-3.5" />
            <span className="sr-only">(opens the app)</span>
          </a>{" "}
          answers once the deployment is live (plain http).
        </p>
      ) : reach.loopback ? (
        <>
          <p>
            It listens on <span className="font-mono">{reach.address}</span> of {serverName}: reachable from that server itself, or from your computer through an SSH tunnel:
          </p>
          <CodeBlock value={`ssh -L ${reach.port}:127.0.0.1:${reach.port} <user>@<address of ${serverName}>`} label="Copy the command" />
          <p className="text-muted-foreground">
            Then open <span className="font-mono">http://127.0.0.1:{reach.port}</span> on your computer. To serve it to everyone with a name, edit the app and give it a domain.
          </p>
        </>
      ) : (
        <p>
          It listens on port <span className="font-mono">{reach.port}</span> of every interface of {serverName}: the dashboard does not know the address it is reached at, so open <span className="font-mono">http://&lt;address of {serverName}&gt;:{reach.port}</span>.
        </p>
      )}
    </div>
  );
}

/**
 * The screen after "Create and deploy": the project is written and its first deployment started. It says how to reach
 * the app and links the deployment to watch; nothing here claims the app already runs (the deployment decides that).
 */
export function ImageCreated({ outcome, serverId, serverName, name, version }: { outcome: ImageOutcome; serverId: string; serverName: string; name: string; version: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  if (outcome.deploymentId === undefined || outcome.reach === undefined) return null;
  const dns = outcome.steps.dns;
  return (
    <div ref={ref} tabIndex={-1} className="scroll-mt-20 outline-none" data-testid="image-created">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2Icon aria-hidden className="size-5 text-success" />
            {name} is created and deploying
          </CardTitle>
          <CardDescription>
            The app is in {serverName}&apos;s configuration and the first deployment of <span className="font-mono">{version}</span> started: the agent pulls the image, starts it and waits for it to be healthy.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ReachBlock reach={outcome.reach} serverName={serverName} dnsNote={dns.state === "skipped" && outcome.reach.kind === "domain" ? dns.detail : null} />
          {outcome.steps.env.state === "done" && <p className="text-sm text-muted-foreground">{outcome.steps.env.detail} They are applied by this first deployment.</p>}
        </CardContent>
        <CardFooter className="flex flex-wrap gap-2">
          <Button asChild>
            <Link href={`/servers/${encodeURIComponent(serverId)}/deployments/${encodeURIComponent(outcome.deploymentId)}`}>Watch the deployment</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={projectHref(name)}>Open the project</Link>
          </Button>
          <Button asChild variant="ghost">
            <Link href="/projects/new?door=image">Create another</Link>
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
