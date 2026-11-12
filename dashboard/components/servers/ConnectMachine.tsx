"use client";

import { CircleCheckIcon, LaptopIcon, LoaderCircleIcon } from "lucide-react";
import Link from "next/link";
import { CodeBlock } from "@/components/servers/install-outcome";
import { useConnectCode } from "@/components/servers/useConnectCode";
import { Notice } from "@/components/states";
import { StepUpAction } from "@/components/unlock";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Adds a computer behind NAT (a Mac, a laptop) that connects out to this dashboard and does not serve traffic: one line to run there,
 * a code that expires and works once, and the page notices by itself when the machine has connected.
 */
export function ConnectMachine() {
  const { code, error, pending, create, progress, expired } = useConnectCode("machine");

  if (progress?.connected) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <CircleCheckIcon aria-hidden className="size-6 text-success" />
            <CardTitle role="status">{progress.name} connected</CardTitle>
          </div>
          <CardDescription>
            The machine is online. Choose it under <em>Build on</em> in an app&apos;s Source page; it builds images and the dashboard sends them to the server that runs the app.
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <Button asChild>
            <Link href={`/servers/${progress.serverId}`}>Open {progress.name}</Link>
          </Button>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>A computer that connects to Keelson</CardTitle>
        <CardDescription>
          A Mac, a laptop or any PC with Docker, even behind a home router: the agent there opens one connection <em>out</em> to this dashboard, nothing
          is opened on the machine&apos;s side. It is a server that does not serve traffic: it can build images, which the dashboard then sends to your servers.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground marker:text-muted-foreground/60">
          <li>Docker must be running on that computer (on a Mac, Docker Desktop open).</li>
        </ul>
        {error && (
          <Notice title="Could not make a code" action={<StepUpAction error={error} />}>
            {error}
          </Notice>
        )}
        {code && !expired && (
          <div className="space-y-3">
            <p className="text-sm">Run this in a terminal on the computer:</p>
            <CodeBlock value={code.line} label="Copy the command" />
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <LoaderCircleIcon aria-hidden className="size-4 animate-spin" />
              Waiting for the machine to connect…
            </p>
            <p className="text-xs text-muted-foreground">
              The code in this line works once and expires in 30 minutes. The machine then keeps its own credential; remove the machine here to revoke it. The agent runs in
              the foreground (stop it with Ctrl-C), and keeps its files in <span className="font-mono">~/.keelson</span>.
            </p>
          </div>
        )}
        {code && expired && <Notice tone="warning" title="The code expired">Make a new one: a code works for 30 minutes and once.</Notice>}
      </CardContent>
      <CardFooter className="justify-end">
        <Button type="button" onClick={create} loading={pending} variant={code && !expired ? "outline" : "default"}>
          <LaptopIcon />
          {code ? "Make another code" : "Make a code"}
        </Button>
      </CardFooter>
    </Card>
  );
}
