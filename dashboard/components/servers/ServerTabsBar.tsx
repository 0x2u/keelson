import { ServerTabs } from "@/components/servers/ServerTabs";
import { attentionItems } from "@/lib/attention-core";
import { serverTabs } from "@/lib/nav-core";
import { serverSnapshot } from "@/lib/server-data";

/** The tab bar with what the agent said: counts, and a dot on each tab the attention model has something for. */
export async function ServerTabsBar({ serverId, machine }: { serverId: string; machine: boolean }) {
  const snapshot = await serverSnapshot(serverId);
  return <ServerTabs serverId={serverId} tabs={serverTabs(serverId, snapshot, attentionItems([snapshot]), machine)} />;
}
