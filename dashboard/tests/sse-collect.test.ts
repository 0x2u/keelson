import { describe, expect, it } from "vitest";
import { collectSse, type SseEvent } from "@/lib/sse-collect";

function stream(chunks: (string | Promise<string>)[], then?: () => void): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      if (i >= chunks.length) {
        then?.();
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(await chunks[i++]));
    },
  });
}

async function run(body: ReadableStream<Uint8Array>, opts: { idleMs?: number; deadlineMs?: number; maxEventBytes?: number; stopAt?: string } = {}) {
  const events: SseEvent[] = [];
  const controller = new AbortController();
  const result = await collectSse(body, controller, {
    maxEventBytes: opts.maxEventBytes ?? 1000,
    deadlineMs: opts.deadlineMs ?? 2000,
    idleMs: opts.idleMs,
    onEvent: (e) => {
      events.push(e);
      return e.event !== opts.stopAt;
    },
  });
  return { events, result, controller };
}

describe("collectSse", () => {
  it("reads events split across chunks, with comments and CRLF", async () => {
    const { events, result } = await run(stream([": ping\n\nevent: log\nda", "ta: {\"a\":1}\r\n\r\nevent: end\ndata: {}\n", "\n"]));
    expect(events).toEqual([
      { event: "log", data: '{"a":1}' },
      { event: "end", data: "{}" },
    ]);
    expect(result).toEqual({ skipped: false, cut: false });
  });

  it("stops when the handler says so", async () => {
    const { events } = await run(stream(["event: a\ndata: 1\n\nevent: end\ndata: 2\n\nevent: b\ndata: 3\n\n"]), { stopAt: "end" });
    expect(events.map((e) => e.event)).toEqual(["a", "end"]);
  });

  it("skips an event longer than the limit, and goes on with the next", async () => {
    const { events, result } = await run(stream([`event: big\ndata: ${"x".repeat(1500)}`, "\n\nevent: ok\ndata: 1\n\n"]), { maxEventBytes: 500 });
    expect(events).toEqual([{ event: "ok", data: "1" }]);
    expect(result.skipped).toBe(true);
  });

  it("gives up at the deadline and aborts the request", async () => {
    const never = new Promise<string>(() => {});
    const body = stream(["event: a\ndata: 1\n\n", never]);
    const { events, result, controller } = await run(body, { deadlineMs: 50 });
    expect(events).toHaveLength(1);
    expect(result.cut).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it("returns once a live stream goes quiet, when asked to", async () => {
    const never = new Promise<string>(() => {});
    const started = Date.now();
    const { events, result } = await run(stream(["event: a\ndata: 1\n\n", never]), { idleMs: 40 });
    expect(events).toHaveLength(1);
    expect(result.cut).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
