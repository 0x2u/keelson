import Link from "next/link";
import { RefreshCwIcon } from "lucide-react";
import { ICONS } from "@/lib/icons";
import { offersUpdate, type AgentUpdate } from "@/lib/agent-binaries-core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const BADGE: Record<AgentUpdate, { variant: "success" | "info" | "warning" | "muted"; label: string }> = {
  current: { variant: "success", label: "Up to date" },
  older: { variant: "info", label: "Update available" },
  newer: { variant: "warning", label: "Newer than this dashboard" },
  different: { variant: "info", label: "Another version available" },
  unknown: { variant: "muted", label: "Version unknown" },
};

/**
 * The agent running on a server, against the one this dashboard carries, with the way to replace it. `relay`: the server
 * connects out, so it is updated and removed by a command run on it, not over SSH.
 */
export function AgentCard({ serverId, running, carried, state, relay = false }: { serverId: string; running: string | null; carried: string | null; state: AgentUpdate; relay?: boolean }) {
  const badge = BADGE[state];
  return (
    <Card className="max-w-2xl" id="agent">
      <CardHeader>
        <CardTitle>Agent</CardTitle>
        <CardDescription>
          The program on the server that runs deployments and jobs.{" "}
          {relay
            ? "Updating runs one command on the server, which keeps its settings, apps and secrets and does not touch running containers. Uninstalling is a command there too and leaves the containers running."
            : "Updating replaces it over SSH, keeps its settings, apps and secrets, and does not touch running containers. Uninstalling removes it the same way and leaves the containers running."}
        </CardDescription>
        <CardAction>
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-4">
        <dl className="grid gap-1 text-sm">
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Running</dt>
            <dd className="font-mono">{running ?? "not reachable"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted-foreground">This dashboard carries</dt>
            <dd className="font-mono">{carried ?? "unknown"}</dd>
          </div>
        </dl>
        {state === "newer" && <p className="basis-full text-sm text-muted-foreground">This agent is newer than this dashboard. Update the dashboard first; the agent is never replaced by an older one.</p>}
        <div className="flex flex-wrap gap-2">
          {/* An agent ahead of the dashboard is never replaced by the older one this dashboard carries. */}
          {state !== "newer" && (
            <Button asChild variant={offersUpdate(state) ? "default" : "outline"}>
              <Link href={`/servers/${serverId}/update`}>
                <RefreshCwIcon />
                Update the agent
              </Link>
            </Button>
          )}
          <Button asChild variant="outline">
            <Link href={`/servers/${serverId}/uninstall`}>
              <ICONS.remove />
              Uninstall the agent
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
