"use server";

import { revalidatePath } from "next/cache";
import { AgentError, probeAgent } from "@/lib/agent";
import { parseImport, type ImportEntry } from "@/lib/server-import-core";
import { normalizeUrl } from "@/lib/server-input";
import { DuplicateServerError, createServer, listServers } from "@/lib/servers";
import { requireSession } from "@/lib/session";
import { stepUpError } from "@/lib/step-up";
import { servers } from "@/lib/step-up-core";

/** What became of one entry of the file. */
export type ImportStatus = "added" | "added_unreachable" | "exists" | "invalid" | "unreachable" | "install";

export interface ImportResultRow {
  name: string;
  status: ImportStatus;
  message?: string;
  /** For "install": the installer, with the address of the server filled in. */
  installHref?: string;
}

export type ImportOutcome = { ok: true; rows: ImportResultRow[] } | { ok: false; error: string };

const MAX_FILE_BYTES = 256 * 1024;

function describe(err: unknown): string {
  return err instanceof AgentError || err instanceof Error ? err.message : "unexpected error";
}

function installHref(e: Extract<ImportEntry, { kind: "ssh" }>): string {
  return `/servers/new?${new URLSearchParams({ name: e.name, host: e.host, port: e.port, user: e.user })}`;
}

/**
 * Registers the servers of an import file. An agent is checked before it is saved, as in the add form; one that does not answer
 * is left out unless the operator asked to keep it (an agent that is not started yet). A name already registered is never
 * overwritten. An address without an agent goes to the installer.
 */
export async function importServersAction(text: string, keepUnreachable: boolean): Promise<ImportOutcome> {
  await requireSession();
  const locked = await stepUpError(servers("add"), "importing servers");
  if (locked) return { ok: false, error: locked };
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) return { ok: false, error: "That file is too large for a server list." };
  const parsed = parseImport(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const taken = new Set(listServers().map((s) => s.name));
  const rows = await Promise.all(
    parsed.rows.map(async (row): Promise<ImportResultRow> => {
      if (row.entry === undefined) return { name: row.name, status: "invalid", message: row.error };
      const { entry } = row;
      if (taken.has(entry.name)) return { name: entry.name, status: "exists", message: "A server with this name is already registered; it was left as it is." };
      if (entry.kind === "ssh") return { name: entry.name, status: "install", message: "No agent yet: install it over SSH.", installHref: installHref(entry) };

      const v = entry.values;
      let reachable = true;
      let why = "";
      try {
        await probeAgent({
          url: normalizeUrl(v.url)!,
          token: v.token,
          deploySecret: v.deploySecret || null,
          caCert: v.caCert || null,
          clientCert: v.clientCert || null,
          clientKey: v.clientKey || null,
        });
      } catch (err) {
        reachable = false;
        why = describe(err);
      }
      if (!reachable && !keepUnreachable) return { name: entry.name, status: "unreachable", message: `Could not connect: ${why}` };
      try {
        createServer(v);
      } catch (err) {
        if (err instanceof DuplicateServerError) return { name: entry.name, status: "exists", message: "A server with this name is already registered; it was left as it is." };
        throw err;
      }
      return reachable ? { name: entry.name, status: "added" } : { name: entry.name, status: "added_unreachable", message: `Saved, but it does not answer yet: ${why}` };
    }),
  );

  if (rows.some((r) => r.status === "added" || r.status === "added_unreachable")) revalidatePath("/", "layout");
  return { ok: true, rows };
}
