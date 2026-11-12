"use server";

import { revalidatePath } from "next/cache";
import { audit } from "@/lib/auth/store";
import { normalizePublicIp } from "@/lib/address-core";
import { getServer, setPublicIp } from "@/lib/servers";
import { clientInfo, requireSession } from "@/lib/session";
import { stepUpError } from "@/lib/step-up";
import { publicAddress } from "@/lib/step-up-core";

export interface PublicIpState {
  error?: string;
  /** The address that was saved ("" = cleared); absent until a save succeeded. */
  saved?: string;
}

/**
 * Sets the address a server's domains must point at, or clears it with an empty text. A server that connects out has no URL
 * to read it from, so this is the only place it comes from.
 */
export async function savePublicIpAction(serverId: string, _prev: PublicIpState, form: FormData): Promise<PublicIpState> {
  await requireSession();
  const server = getServer(serverId);
  if (!server) return { error: "Unknown server." };
  const typed = form.get("publicIp");
  const ip = normalizePublicIp(typeof typed === "string" ? typed : "");
  if (ip === null) return { error: "An IPv4 or IPv6 address, such as 203.0.113.7, or leave it empty." };
  // A new address is where the DNS records of this server's domains will point; clearing it only falls back to the agent's URL.
  if (ip !== "" && ip !== (server.publicIp ?? "")) {
    const locked = await stepUpError(publicAddress(), `public address of ${server.name}`);
    if (locked) return { error: locked };
  }
  setPublicIp(serverId, ip === "" ? null : ip);
  await audit("server_public_ip_set", `${server.name}: ${ip === "" ? "none" : ip}`, (await clientInfo()).ip);
  revalidatePath(`/servers/${serverId}`, "layout");
  return { saved: ip };
}
