import Link from "next/link";
import type { ReactNode } from "react";
import { Notice } from "@/components/states";
import { Button } from "@/components/ui/button";
import { agentFor } from "@/lib/agent";
import type { ConfigDocument } from "@/lib/agent-types";
import { load } from "@/lib/data";
import type { ServerCredentials } from "@/lib/servers";

/** The configuration to edit, or the notice that explains why the forms cannot be shown. */
export type EntityConfig = { doc: ConfigDocument; notice?: undefined } | { doc?: undefined; notice: ReactNode };

/**
 * Loads the agent's configuration for a form page. Forms need the deploy secret (changes are signed), an agent that
 * has an apps file, and a file that currently parses: each missing piece gets its own explanation.
 */
export async function loadEntityConfig(serverId: string, server: ServerCredentials): Promise<EntityConfig> {
  if (!server.canDeploy) {
    return {
      notice: (
        <Notice
          tone="warning"
          title="This server cannot be changed from here"
          action={
            <Button asChild variant="outline" size="sm" className="w-fit">
              <Link href={`/servers/${serverId}/settings`}>Open server settings</Link>
            </Button>
          }
        >
          This server is read-only here: its configuration changes are signed with its deploy access, which the dashboard does not have. Add it in the server settings.
        </Notice>
      ),
    };
  }

  const loaded = await load(agentFor(server).config());
  if (loaded.error !== undefined) {
    return {
      notice: (
        <Notice title="Could not load the configuration">
          {loaded.error}. Nothing was changed; reload the page to try again.
        </Notice>
      ),
    };
  }
  if (loaded.data === null) {
    return {
      notice: (
        <Notice tone="info" title="This server has no configuration to edit">
          It is read-only: it runs without a configuration file. Start its agent with one to manage apps, jobs and notifications from the dashboard.
        </Notice>
      ),
    };
  }
  if (loaded.data.error) {
    return {
      notice: (
        <Notice
          tone="warning"
          title="The configuration file is currently invalid"
          action={
            <Button asChild variant="outline" size="sm" className="w-fit">
              <Link href={`/servers/${serverId}/config`}>Open the YAML editor</Link>
            </Button>
          }
        >
          {loaded.data.error} The agent keeps running the last good configuration. Fix the file in the editor before using these forms.
        </Notice>
      ),
    };
  }
  return { doc: loaded.data };
}
