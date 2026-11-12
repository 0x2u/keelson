import "server-only";
import { AgentError, agentFor } from "@/lib/agent";
import { refreshConfigPages } from "@/lib/config-change";
import { load } from "@/lib/data";
import { READ_ONLY_REASONS } from "@/lib/notifications-fleet-core";
import type { ApplyDeps } from "@/lib/notifications-apply-core";
import { getCredentials } from "@/lib/servers";
import { stepUpError } from "@/lib/step-up";

/** What each version of a server's file says made the change, in its history. */
const COMMENT = "Applied the default notification settings";

/**
 * The executor's hands: each server is read and written through its own agent's signed API, exactly as the single-server form
 * does (`saveNotificationsAction`), and the unlock is the session's step-up check, asked once for the whole batch.
 */
export function liveApplyDeps(): ApplyDeps {
  return {
    async load(id) {
      const server = getCredentials(id);
      if (!server) return { kind: "unreachable", reason: "This server is no longer registered." };
      if (server.unreadable) return { kind: "unreachable", reason: "Its stored credentials cannot be read: the master key does not match." };
      if (!server.canDeploy) return { kind: "read-only", reason: READ_ONLY_REASONS.noSecret };
      const config = await load(agentFor(server).config());
      if (config.error !== undefined) return { kind: "unreachable", reason: config.error };
      if (config.data === null) return { kind: "read-only", reason: READ_ONLY_REASONS.noFile };
      if (config.data.error) return { kind: "read-only", reason: READ_ONLY_REASONS.invalid };
      return { kind: "ok", notifications: config.data.model.notifications };
    },

    async save(id, config, baseHash) {
      const server = getCredentials(id);
      if (!server) return { ok: false, kind: "unreachable", message: "This server is no longer registered." };
      try {
        const result = await agentFor(server).saveNotifications(config, { base_hash: baseHash, comment: COMMENT });
        if (result.ok) refreshConfigPages(id);
        return result;
      } catch (err) {
        const message = err instanceof AgentError ? err.message : "unexpected error talking to the agent";
        return err instanceof AgentError && err.status === 0 ? { ok: false, kind: "unreachable", message } : { ok: false, kind: "error", message };
      }
    },

    unlock: (reason) => stepUpError({ required: true, reason }, "the default notification settings"),
  };
}
