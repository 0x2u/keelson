import "server-only";
import { agentFor } from "@/lib/agent";
import { getCredentials } from "@/lib/servers";
import { OFFLINE, statsFromSystem, type ServerStats } from "@/lib/server-stats-core";

const LOOKUP_MS = 3000;

/**
 * The stats of these servers, asked of their agents at the same time. A server that does not answer in time, has no
 * credentials, or runs an agent too old for /v1/system is reported offline: choosing a server must not wait on it.
 */
export async function statsOf(ids: string[]): Promise<Record<string, ServerStats>> {
  const unique = [...new Set(ids)];
  const found = await Promise.all(
    unique.map(async (id): Promise<[string, ServerStats]> => {
      const creds = getCredentials(id);
      if (!creds) return [id, OFFLINE];
      try {
        const sys = await Promise.race([agentFor(creds).system(), new Promise<null>((resolve) => setTimeout(() => resolve(null), LOOKUP_MS))]);
        return [id, statsFromSystem(sys)];
      } catch {
        return [id, OFFLINE];
      }
    }),
  );
  return Object.fromEntries(found);
}
