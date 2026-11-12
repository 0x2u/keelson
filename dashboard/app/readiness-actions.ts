"use server";

import { AgentError, agentFor } from "@/lib/agent";
import type { AlertTest, KeyProof, RestoreTest } from "@/lib/agent-types";
import { keyInput } from "@/lib/readiness-run-core";
import { requireSession } from "@/lib/session";
import { getCredentials } from "@/lib/servers";

// The three actions of the readiness checklist. Each is one signed request to the agent; none needs the session to be unlocked
// (a key proof reads, a restore test only ever makes and drops a scratch database, as a restore into a new database does).
// The age secret key travels in the request body only: it is held in memory for this request, never stored, logged, audited,
// echoed in a result, and scrubbed from any error (see `AgentClient.verifyKey`).

export type ActionResult<T> = ({ error?: undefined } & T) | { error: string };

function describe(err: unknown): string {
  return err instanceof AgentError || err instanceof Error ? err.message : "unexpected error";
}

/** Whether the age secret key opens a backup of the database (the newest scheduled one unless `backup` names one). */
export async function verifyKeyAction(serverId: string, database: string, request: { identity: string; backup?: string }): Promise<ActionResult<{ result: KeyProof }>> {
  await requireSession();
  const server = getCredentials(serverId);
  if (!server) return { error: "Unknown server." };
  const key = keyInput(request.identity);
  if (key.problem !== undefined) return { error: key.problem };
  try {
    const result = await agentFor(server).verifyKey(database, { identity: key.identity, ...(request.backup ? { backup: request.backup } : {}) });
    return { result };
  } catch (err) {
    return { error: describe(err) };
  }
}

/** Starts a restore of a backup into a scratch database: the test's id, which `restoreTestAction` follows. */
export async function startRestoreTestAction(serverId: string, database: string, request: { identity: string; backup?: string }): Promise<ActionResult<{ testId: string }>> {
  await requireSession();
  const server = getCredentials(serverId);
  if (!server) return { error: "Unknown server." };
  const key = keyInput(request.identity);
  if (key.problem !== undefined) return { error: key.problem };
  try {
    const testId = await agentFor(server).startRestoreTest(database, { identity: key.identity, ...(request.backup ? { backup: request.backup } : {}) });
    return { testId };
  } catch (err) {
    return { error: describe(err) };
  }
}

/** One restore test as the agent records it so far, for the dialog that follows it. */
export async function restoreTestAction(serverId: string, database: string, testId: string): Promise<ActionResult<{ test: RestoreTest }>> {
  await requireSession();
  const server = getCredentials(serverId);
  if (!server) return { error: "Unknown server." };
  try {
    const tests = (await agentFor(server).restoreTests(database, 10)) ?? [];
    const test = tests.find((t) => t.id === testId);
    return test ? { test } : { error: "The agent has no record of this test." };
  } catch (err) {
    return { error: describe(err) };
  }
}

/** Sends a test message through every channel of the server and says how each went (a class of failure, never an error text). */
export async function testAlertAction(serverId: string): Promise<ActionResult<{ result: AlertTest }>> {
  await requireSession();
  const server = getCredentials(serverId);
  if (!server) return { error: "Unknown server." };
  try {
    return { result: await agentFor(server).testNotifications() };
  } catch (err) {
    return { error: describe(err) };
  }
}
