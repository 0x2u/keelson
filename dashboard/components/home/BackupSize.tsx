import { agentFor } from "@/lib/agent";
import { load } from "@/lib/data";
import { formatBytes } from "@/lib/format";
import { getCredentials } from "@/lib/servers";

/** The size of a database's newest backup, read from its destination. Streamed on its own: a slow destination does not hold the page. */
export async function BackupSize({ serverId, database }: { serverId: string; database: string }) {
  const creds = getCredentials(serverId);
  if (!creds) return null;
  const result = await load(agentFor(creds).databaseBackups(database));
  const newest = result.data?.[0];
  return newest ? <span className="tabular">{formatBytes(newest.size_bytes)}</span> : null;
}
