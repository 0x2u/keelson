export interface SseEvent {
  event: string;
  data: string;
}

export interface CollectOptions {
  /** An event whose data is longer than this is skipped, and the result says so. */
  maxEventBytes: number;
  /** Aborts the request and returns what was read once this long has passed. */
  deadlineMs: number;
  /** Returns once this long passes without a byte (the stream is live and has nothing more to replay). */
  idleMs?: number;
  /** Return false to stop reading. */
  onEvent: (e: SseEvent) => boolean | void;
}

export interface Collected {
  /** An event was longer than maxEventBytes and was skipped. */
  skipped: boolean;
  /** The deadline or the idle limit ended the read, not the stream. */
  cut: boolean;
}

/**
 * Reads a Server-Sent Events response to its end (or to the deadline) and hands each event over. Memory is bounded
 * by maxEventBytes, whatever the stream sends. `controller` aborts the request behind `body`.
 */
export async function collectSse(body: ReadableStream<Uint8Array> | null, controller: AbortController, opts: CollectOptions): Promise<Collected> {
  const result: Collected = { skipped: false, cut: false };
  if (body === null) return result;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let discarding = false;
  let stop = false;

  // Ending the read: abort the request, and cancel the reader so a read waiting on a silent stream returns at once.
  const cut = () => {
    result.cut = true;
    controller.abort();
    void reader.cancel().catch(() => {});
  };
  const deadline = setTimeout(cut, opts.deadlineMs);
  let idle: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    if (opts.idleMs === undefined) return;
    clearTimeout(idle);
    idle = setTimeout(cut, opts.idleMs);
  };

  const dispatch = (block: string) => {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length === 0 && event === "message") return;
    if (opts.onEvent({ event, data: data.join("\n") }) === false) stop = true;
  };

  try {
    armIdle();
    while (!stop) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle();
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      for (let at = buffer.indexOf("\n\n"); at >= 0 && !stop; at = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (discarding) discarding = false;
        else dispatch(block);
      }
      if (buffer.length > opts.maxEventBytes) {
        // An event this long never finishes within the limit: drop what is read of it and the rest up to its end.
        buffer = "";
        discarding = true;
        result.skipped = true;
      }
    }
  } catch (err) {
    // The abort of our own deadline or idle limit is the normal way a live stream ends here.
    if (!result.cut) throw err;
  } finally {
    clearTimeout(deadline);
    clearTimeout(idle);
    void reader.cancel().catch(() => {});
  }
  return result;
}
