import "server-only";
import { AgentError, type AgentClient } from "@/lib/agent";
import type { DeploymentEvent, LogLine } from "@/lib/agent-types";
import { collectSse } from "@/lib/sse-collect";

/** The most the API ever hands out of a container's log. */
export const LOG_TAIL_MAX = 1000;
export const LOG_BYTES_MAX = 256 * 1024;
export const LOG_TAIL_DEFAULT = 200;
/** A single log line is cut here, so one huge line cannot be the whole answer. */
const LOG_LINE_MAX = 8 * 1024;
const EVENTS_MAX = 500;
const EVENT_BYTES_MAX = 64 * 1024;
const LOG_DEADLINE_MS = 15_000;
const EVENTS_DEADLINE_MS = 10_000;
/** A deployment still running has nothing more to replay once its stream goes quiet this long. */
const EVENTS_IDLE_MS = 1_000;

function failed(data: string): AgentError {
  let message = "stream interrupted";
  try {
    const parsed = JSON.parse(data) as { error?: unknown };
    if (typeof parsed.error === "string") message = parsed.error;
  } catch {
    /* keep the generic message */
  }
  return new AgentError(502, message);
}

/**
 * The last `tail` lines of a container's log as plain text lines, newest last: at most LOG_BYTES_MAX bytes, the oldest
 * lines dropped first. `truncated` says that a cap, not the log, ended it.
 */
export async function readLogs(agent: AgentClient, container: string, tail: number): Promise<{ lines: string[]; truncated: boolean }> {
  const controller = new AbortController();
  const lines: string[] = [];
  let bytes = 0;
  let truncated = false;
  const res = await agent.stream(`/v1/containers/${encodeURIComponent(container)}/logs?tail=${tail}`, controller.signal);
  const read = await collectSse(res.body as unknown as ReadableStream<Uint8Array> | null, controller, {
    maxEventBytes: LOG_LINE_MAX * 4,
    deadlineMs: LOG_DEADLINE_MS,
    onEvent(e) {
      if (e.event === "error") throw failed(e.data);
      if (e.event === "end") return false;
      if (e.event !== "log") return;
      const log = JSON.parse(e.data) as LogLine;
      let line = `${log.time} ${log.line.replace(/\r?\n$/, "")}`;
      if (line.length > LOG_LINE_MAX) {
        line = `${line.slice(0, LOG_LINE_MAX)}…`;
        truncated = true;
      }
      lines.push(line);
      bytes += Buffer.byteLength(line) + 1;
      if (lines.length > tail) bytes -= Buffer.byteLength(lines.shift()!) + 1;
      while (bytes > LOG_BYTES_MAX && lines.length > 1) {
        bytes -= Buffer.byteLength(lines.shift()!) + 1;
        truncated = true;
      }
    },
  });
  return { lines, truncated: truncated || read.skipped || read.cut };
}

/** The last 500 events of a deployment. A deployment that is still running is read up to now. */
export async function readDeploymentEvents(agent: AgentClient, id: string, running: boolean): Promise<DeploymentEvent[]> {
  const controller = new AbortController();
  const events: DeploymentEvent[] = [];
  const res = await agent.stream(`/v1/deployments/${encodeURIComponent(id)}/events`, controller.signal);
  await collectSse(res.body as unknown as ReadableStream<Uint8Array> | null, controller, {
    maxEventBytes: EVENT_BYTES_MAX,
    deadlineMs: EVENTS_DEADLINE_MS,
    idleMs: running ? EVENTS_IDLE_MS : undefined,
    onEvent(e) {
      if (e.event === "error") throw failed(e.data);
      if (e.event === "end") return false;
      if (e.event !== "event") return;
      events.push(JSON.parse(e.data) as DeploymentEvent);
      if (events.length > EVENTS_MAX) events.shift();
    },
  });
  return events;
}
