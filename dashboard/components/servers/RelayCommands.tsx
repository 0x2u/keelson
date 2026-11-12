"use client";

import { CircleCheckIcon, LoaderCircleIcon, RefreshCwIcon } from "lucide-react";
import { CodeBlock } from "@/components/servers/install-outcome";
import { useConnectCode } from "@/components/servers/useConnectCode";
import { Notice } from "@/components/states";
import { StepUpAction } from "@/components/unlock";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { updateMessage, type UpdateProgress } from "@/lib/relay-update-core";

/**
 * Updating the agent of a server that connects out: the server cannot be reached over SSH from here, so the dashboard makes
 * a one-time code on demand and shows the command that downloads this dashboard's agent with it. The code is shown once.
 */
export function RelayUpdate({ serverId, serverName }: { serverId: string; serverName: string }) {
  const { code, error, pending, create, expired, update, recheck } = useConnectCode("upgrade", serverId);
  const updated = update?.state === "updated";
  return (
    <Card>
      <CardHeader>
        <CardTitle>Update {serverName} from the server</CardTitle>
        <CardDescription>
          Run one command on the server. It downloads the agent this dashboard carries, replaces the one that runs, restarts it and keeps its settings, apps and secrets. Running containers are not touched, and the server connects again by itself.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <Notice title="Could not make a code" action={<StepUpAction error={error} />}>
            {error}
          </Notice>
        )}
        {code && !updated && !expired && (
          <>
            <p className="text-sm">Run this on the server, as a user that can use sudo:</p>
            <CodeBlock value={code.line} label="Copy the command" />
            <p className="text-xs text-muted-foreground">
              The command carries a one-time code: it expires in 30 minutes and is not shown again, and it can only download the agent for this server. Nothing secret is printed on the server.
            </p>
          </>
        )}
        {code && !updated && expired && <Notice tone="warning" title="The code expired">A code works for 30 minutes. Make a new one.</Notice>}
        {code && <UpdateStatus update={update} onRecheck={recheck} />}
      </CardContent>
      <CardFooter>
        <Button type="button" onClick={create} loading={pending} variant={code && !expired && !updated ? "outline" : "default"}>
          <RefreshCwIcon />
          {code ? "Make another command" : "Make the update command"}
        </Button>
      </CardFooter>
    </Card>
  );
}

/** What the dashboard saw of the update since the command was made: the version the server reports, waiting, or nothing yet. */
function UpdateStatus({ update, onRecheck }: { update: UpdateProgress | null; onRecheck: () => void }) {
  if (update?.state === "updated") {
    return (
      <p className="flex items-center gap-2 text-sm font-medium" role="status">
        <CircleCheckIcon className="size-4 text-success" aria-hidden />
        {updateMessage(update)}
      </p>
    );
  }
  if (update?.state === "timeout") {
    return (
      <Notice
        tone="warning"
        title={updateMessage(update)}
        action={
          <Button type="button" size="sm" variant="outline" onClick={onRecheck}>
            Check again
          </Button>
        }
      >
        {update.running === null ? "The server does not answer." : `It still runs ${update.running}.`}
      </Notice>
    );
  }
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
      <LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
      {update ? updateMessage(update) : "Waiting for the update"}
    </p>
  );
}

/**
 * Removing the agent of a server that connects out: the command to run there. The dashboard has no way into the server, and
 * the agent's own uninstall refuses to remove anything it cannot stop. Forgetting the server here is a separate step.
 */
export function RelayUninstall({ serverName }: { serverName: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Uninstall the agent of {serverName}</CardTitle>
        <CardDescription>
          Run this on the server. The apps it started keep running; nothing deploys or restarts them any more. Add <span className="font-mono">--dry-run</span> to see what it would do.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <p className="text-sm font-medium">Remove the agent, keep its settings and data</p>
          <CodeBlock value="sudo keelson-agent uninstall" label="Copy the command" />
          <p className="text-xs text-muted-foreground">The apps file, secrets and history stay on the server.</p>
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">Remove the agent and everything it keeps</p>
          <CodeBlock value="sudo keelson-agent uninstall --purge" label="Copy the command" />
          <p className="text-xs text-muted-foreground">Also deletes the apps file, secrets, data and the service account. This cannot be undone.</p>
        </div>
        <p className="text-sm text-muted-foreground">The command does not tell this dashboard: afterwards, remove the server from its Settings page.</p>
      </CardContent>
    </Card>
  );
}
