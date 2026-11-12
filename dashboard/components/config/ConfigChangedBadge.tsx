import { FileDiffIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { agentFor } from "@/lib/agent";
import type { ConfigChangedSince } from "@/lib/app-config-core";
import { findConfigChange } from "@/lib/config-changed";
import { loadServer } from "@/lib/data";

/**
 * "Config changed since the running version": shown from the moment a change that needs a deploy is saved until the
 * next successful deployment of the app. Plain props so it can be rendered without an agent.
 */
export function ConfigChangedNotice({ serverId, since }: { serverId: string; since: ConfigChangedSince }) {
  return (
    <Badge variant="warning" asChild className="h-auto max-w-full whitespace-normal">
      <Link href={`/servers/${serverId}/config/versions`} title="The configuration of this app was saved after the running version was deployed. Deploy to apply it.">
        <FileDiffIcon />
        Config changed since the running version
        <span className="font-normal opacity-80">
          · saved <RelativeTime at={since.now.at} />
        </span>
      </Link>
    </Badge>
  );
}

async function ConfigChangedLoader({ serverId, app }: { serverId: string; app: string }) {
  const since = await findConfigChange(agentFor(loadServer(serverId)), app);
  return since === null ? null : <ConfigChangedNotice serverId={serverId} since={since} />;
}

/**
 * Drop it in the header of an app's page: `<ConfigChangedBadge serverId={id} app={name} />`. It loads the configuration
 * history on its own, behind a Suspense boundary, and renders nothing when there is no change or the agent could not be asked.
 */
export function ConfigChangedBadge({ serverId, app }: { serverId: string; app: string }) {
  return (
    <Suspense fallback={null}>
      <ConfigChangedLoader serverId={serverId} app={app} />
    </Suspense>
  );
}
