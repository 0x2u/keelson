"use server";

import { revalidatePath } from "next/cache";
import { audit } from "@/lib/auth/store";
import { normalizeAppsDomain } from "@/lib/server-input";
import { getServer, setAppsDomain } from "@/lib/servers";
import { clientInfo, requireSession } from "@/lib/session";

export interface AppsDomainState {
  error?: string;
  /** The domain that was saved (null: it was cleared); absent until a save succeeded. */
  saved?: string | null;
}

/**
 * Sets the domain a server's new projects get a host name under (`<project>.<domain>`), or clears it with an empty text.
 * It is only a default the *New project* form fills in: nothing is created at DNS or on the agent from here.
 */
export async function saveAppsDomainAction(serverId: string, _prev: AppsDomainState, form: FormData): Promise<AppsDomainState> {
  await requireSession();
  const server = getServer(serverId);
  if (!server) return { error: "Unknown server." };
  const typed = form.get("appsDomain");
  const domain = normalizeAppsDomain(typeof typed === "string" ? typed : "");
  if (domain === undefined) return { error: "A domain name such as apps.example.com, without https:// or a path, or leave it empty." };
  setAppsDomain(serverId, domain);
  await audit("apps_domain_set", `${server.name}: ${domain ?? "none"}`, (await clientInfo()).ip);
  revalidatePath(`/servers/${serverId}`, "layout");
  revalidatePath("/projects/new");
  return { saved: domain };
}
