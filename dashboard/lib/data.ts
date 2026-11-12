import "server-only";
import { notFound } from "next/navigation";
import { AgentError } from "@/lib/agent";
import { getCredentials, type ServerCredentials } from "@/lib/servers";

/** The server for a route parameter, or a 404. Credentials stay on the server. */
export function loadServer(id: string): ServerCredentials {
  const server = getCredentials(id);
  if (!server) notFound();
  return server;
}

/** The outcome of a call that may fail: pages show the error instead of crashing. */
export type Loaded<T> = { data: T; error?: undefined } | { data?: undefined; error: string };

export async function load<T>(promise: Promise<T>): Promise<Loaded<T>> {
  try {
    return { data: await promise };
  } catch (err) {
    return { error: err instanceof AgentError ? err.message : "unexpected error talking to the agent" };
  }
}
