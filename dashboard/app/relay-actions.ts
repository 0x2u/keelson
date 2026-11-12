"use server";

import { headers } from "next/headers";
import { audit } from "@/lib/auth/store";
import { publicUrl, secureCookies, trustProxy } from "@/lib/env";
import { dashboardOrigin } from "@/lib/github-webhook-core";
import { installLine, isLocalOrigin, originProblem, upgradeLine } from "@/lib/install-core";
import { PUBLIC_URL_HOW } from "@/lib/public-url-help-core";
import { connectLine } from "@/lib/relay-core";
import { updateProgress, type UpdateProgress } from "@/lib/relay-update-core";
import { createRelayCode, relayConnectedAt } from "@/lib/relay";
import { agentFor } from "@/lib/agent";
import { bundledAgentVersion } from "@/lib/agent-binaries";
import { getCredentials, getServer, listServers } from "@/lib/servers";
import { clientInfo, requireSession } from "@/lib/session";
import { stepUpError } from "@/lib/step-up";
import { servers } from "@/lib/step-up-core";

export interface ConnectCode {
  /** The shell line to run on the machine; it holds the code, so it is shown once and not stored here. */
  line: string;
  /** When the code stops working (ms since the epoch). */
  expiresAt: number;
  /** When it was made (ms): the machine that connects with it is a server created after this. */
  since: number;
}

export type ConnectCodeResult = { ok: true; code: ConnectCode } | { ok: false; error: string };

async function currentOrigin(): Promise<string | null> {
  const h = await headers();
  return dashboardOrigin({
    publicUrl: publicUrl(),
    host: h.get("host"),
    forwardedHost: h.get("x-forwarded-host"),
    forwardedProto: h.get("x-forwarded-proto"),
    trustProxy: trustProxy(),
    secure: secureCookies(),
  });
}

/** Whether a command made now would only work on the machine that runs this dashboard (its address is loopback): the page says so before a code is made. */
export async function connectAddressAction(): Promise<{ local: boolean }> {
  await requireSession();
  const origin = await currentOrigin();
  return { local: origin !== null && isLocalOrigin(origin) };
}

/** What the line is for: a server that connects out (the default), a computer that connects as a build machine, or replacing the agent of a server that already did. */
export type ConnectKind = "server" | "machine" | "upgrade";

/** A new single-use code for a machine that connects out, with the line that uses it. */
export async function createConnectCodeAction(kind: ConnectKind = "server", serverId?: string): Promise<ConnectCodeResult> {
  await requireSession();
  // The machine that uses the code becomes a server of this dashboard (or has its agent replaced) and then receives its
  // deployments and secrets, so the code is as sensitive as adding the server by hand.
  const locked = await stepUpError(kind === "upgrade" ? servers("update") : servers("add"), "creating a connect code");
  if (locked) return { ok: false, error: locked };
  // An upgrade code is for one server that connects out; it can fetch the agent and enrol nothing.
  if (kind === "upgrade") {
    const server = serverId ? getServer(serverId) : null;
    if (!server || server.transport !== "relay") return { ok: false, error: "This server does not connect to the dashboard itself: there is no command to make for it." };
  }
  const origin = await currentOrigin();
  if (origin === null) return { ok: false, error: `This dashboard cannot tell which address the machine should connect to. ${PUBLIC_URL_HOW}` };
  // The machine sends this address its code, token and deploy secret, and downloads the agent from it: in the clear, anyone on
  // the way could read them or swap the binary. Plain http is for a dashboard on this very machine.
  const problem = originProblem(origin);
  if (problem !== null) return { ok: false, error: problem };
  const since = Date.now();
  const made = kind === "upgrade" ? createRelayCode(origin, "upgrade", serverId ?? null) : createRelayCode(origin);
  await audit("relay_code_created", kind === "upgrade" ? `update of ${serverId}` : "", (await clientInfo()).ip);
  const line = kind === "machine" ? connectLine(made.code, origin) : kind === "upgrade" ? upgradeLine(origin, made.code) : installLine(origin, made.code);
  return { ok: true, code: { line, expiresAt: made.expiresAt, since } };
}

export type ConnectProgress = { connected: false } | { connected: true; serverId: string; name: string; serves: boolean };

/**
 * Whether the machine that was given a code has connected: a relay server was added since the code was made (the code is
 * used up by the connection that creates it). Only the time travels here, never the code.
 */
export async function connectProgressAction(since: number): Promise<ConnectProgress> {
  await requireSession();
  const arrived = listServers()
    .filter((s) => s.transport === "relay" && s.createdAt >= since)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  return arrived ? { connected: true, serverId: arrived.id, name: arrived.name, serves: arrived.serves } : { connected: false };
}

/**
 * Whether the update the operator runs on a server that connects out has happened: asks the server's agent which version it
 * runs and compares with the one this dashboard carries (see `updateProgress`). `since` is when the command was made and
 * `watchFrom` when the page began waiting. Reads only: it makes no code and starts nothing.
 */
export async function relayUpdateProgressAction(serverId: string, since: number, watchFrom: number): Promise<UpdateProgress> {
  await requireSession();
  const server = getCredentials(serverId);
  let running: string | null = null;
  if (server && server.transport === "relay") {
    try {
      running = (await agentFor(server).info()).version.trim() || null;
    } catch {
      // it restarts during the update: no answer is a state, not a failure
    }
  }
  return updateProgress({ bundled: bundledAgentVersion(), running, connectedAt: relayConnectedAt(serverId), since, watchFrom, now: Date.now() });
}
