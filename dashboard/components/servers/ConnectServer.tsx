"use client";

import { CircleCheckIcon, LoaderCircleIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { connectAddressAction } from "@/app/relay-actions";
import { CodeBlock } from "@/components/servers/install-outcome";
import { useConnectCode } from "@/components/servers/useConnectCode";
import { Notice } from "@/components/states";
import { StepUpAction } from "@/components/unlock";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ICONS } from "@/lib/icons";
import { newProjectHref } from "@/lib/nav-core";
import { PUBLIC_URL_HOW } from "@/lib/public-url-help-core";

const STEPS = [
  <>
    Downloads the Keelson agent from this dashboard and installs it as a <span className="font-mono">systemd</span> service, with its own service account.
  </>,
  <>The agent opens one outbound HTTPS connection to this dashboard and keeps it open. It makes its secrets on the server and hands them to this dashboard once.</>,
  <>Nothing is opened on the server: no port, no certificate, no firewall rule and no SSH login.</>,
];

const NEEDS = [
  "A Linux server with systemd (amd64 or arm64) and Docker installed",
  "Root: the command starts with sudo",
  "Outbound HTTPS from the server to this dashboard",
];

/**
 * The way to add a server: one command with a one-time code, run on the server. The agent installs itself and connects out,
 * so the dashboard needs no address, certificate or login for it. The page waits for the connection and says when it came.
 */
export function ConnectServer() {
  const { code, error, pending, create, progress, expired } = useConnectCode("server");
  const [local, setLocal] = useState(false);
  useEffect(() => {
    let live = true;
    connectAddressAction().then(
      (a) => {
        if (live) setLocal(a.local);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);

  if (progress?.connected) {
    return (
      <Card data-testid="connect-server">
        <CardHeader>
          <div className="flex items-center gap-3">
            <CircleCheckIcon aria-hidden className="size-6 text-success" />
            <CardTitle role="status">{progress.name} connected</CardTitle>
          </div>
          <CardDescription>
            {progress.serves
              ? "The server is online. Create a project on it, or add apps to an existing one."
              : "The machine is online and does not serve traffic: choose it under Build on in an app's Source page to build on it."}
          </CardDescription>
        </CardHeader>
        <CardFooter className="flex-wrap gap-2">
          {progress.serves ? (
            <>
              <Button asChild>
                <Link href={newProjectHref({ server: progress.serverId })}>New project on {progress.name}</Link>
              </Button>
              <Button asChild variant="outline">
                <Link href={`/servers/${progress.serverId}`}>Open {progress.name}</Link>
              </Button>
            </>
          ) : (
            <Button asChild>
              <Link href={`/servers/${progress.serverId}`}>Open {progress.name}</Link>
            </Button>
          )}
          <Button asChild variant="ghost">
            <Link href="/servers">All servers</Link>
          </Button>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card data-testid="connect-server">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Connect with one command <Badge variant="info">Recommended</Badge>
        </CardTitle>
        <CardDescription>Run one command on the server. The agent installs itself and connects out to this dashboard.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-3">
          {local && (
            <Notice tone="warning" title="This command only works on the machine that runs this dashboard">
              To connect another server, give the dashboard a public https address first. {PUBLIC_URL_HOW}
            </Notice>
          )}
          {error && (
            <Notice title="Could not make a code" action={<StepUpAction error={error} />}>
              {error}
            </Notice>
          )}
          {code && !expired ? (
            <>
              <p className="text-sm">Run this on the server, as a user that can use sudo:</p>
              <CodeBlock value={code.line} label="Copy the command" />
              <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                <LoaderCircleIcon aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
                Waiting for the server to connect…
              </p>
              <p className="text-xs text-muted-foreground">The code in this command works once and expires in 30 minutes. It is not shown again: make another one if you lose it.</p>
            </>
          ) : (
            code && expired && <Notice tone="warning" title="The code expired">A code works for 30 minutes and once. Make a new one.</Notice>
          )}
          <div>
            <Button type="button" onClick={create} loading={pending} variant={code && !expired ? "outline" : "default"}>
              <ICONS.server />
              {code ? "Make another command" : "Make the command"}
            </Button>
          </div>
        </div>

        <div className="grid gap-6 sm:grid-cols-2">
          <section className="space-y-2" aria-labelledby="connect-does">
            <h3 id="connect-does" className="text-sm font-medium">
              What the command does
            </h3>
            <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground marker:text-muted-foreground/60">
              {STEPS.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          </section>
          <section className="space-y-2" aria-labelledby="connect-needs">
            <h3 id="connect-needs" className="text-sm font-medium">
              What the server needs
            </h3>
            <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground marker:text-muted-foreground/60">
              {NEEDS.map((need) => (
                <li key={need}>{need}</li>
              ))}
              <li>No inbound port opened</li>
            </ul>
          </section>
        </div>

        <p className="text-xs text-muted-foreground">
          A server connected this way builds on itself, pulls from registries, deploys, runs jobs and databases, and receives images built on other servers.
        </p>
      </CardContent>
    </Card>
  );
}
