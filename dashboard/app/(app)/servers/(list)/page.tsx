import type { Metadata } from "next";
import Link from "next/link";
import { ICONS } from "@/lib/icons";
import { LiveRefresh } from "@/components/LiveRefresh";
import { PageHeader } from "@/components/page-header";
import { ServersList } from "@/components/servers/ServersList";
import { Button } from "@/components/ui/button";
import { bundledAgentVersion } from "@/lib/agent-binaries";
import { attentionItems } from "@/lib/attention-core";
import { loadFleet } from "@/lib/fleet";
import { serverRows } from "@/lib/servers-view-core";

export const metadata: Metadata = { title: "Servers" };
export const dynamic = "force-dynamic";

export default async function ServersPage() {
  const fleet = await loadFleet();
  const now = Date.now(); // eslint-disable-line react-hooks/purity -- a server component renders once per request
  const rows = serverRows(fleet, attentionItems(fleet, now), bundledAgentVersion());

  return (
    <>
      <PageHeader
        title="Servers"
        description="Every machine running a Keelson agent, the ones that need a look first."
        actions={
          <>
            <LiveRefresh generatedAt={now} />
            <Button asChild>
              <Link href="/servers/new">
                <ICONS.add /> Add server
              </Link>
            </Button>
          </>
        }
      />
      <ServersList rows={rows} />
    </>
  );
}
