"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

export type StreamStatus = "connecting" | "live" | "ended" | "disconnected";

export interface EventStreamOptions {
  /** Close the stream while false and open it again when true. Defaults to true. */
  enabled?: boolean;
  /**
   * Reopen a dropped stream with exponential backoff. Only for streams whose
   * consumer can tolerate a replay from the start (EventSource reconnects from scratch).
   */
  autoReconnect?: boolean;
}

const MAX_RETRIES = 10;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];

function subscribeVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/** True while the browser tab is in the foreground. Streams should stop when it is not. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState === "visible",
    () => true,
  );
}

interface Tracked {
  key: string;
  status: StreamStatus;
}

/**
 * Subscribes to a Server-Sent Events endpoint of this dashboard.
 *
 * It does not auto-reconnect unless `options.autoReconnect` is set: EventSource
 * would replay the stream from its start (the log tail again), duplicating lines.
 * A dropped stream is reported as "disconnected" and the caller offers `reconnect`.
 *
 * `onEvent` receives the event name and its parsed JSON payload. Names in
 * `terminal` end the stream cleanly, as the agent's "end" event does.
 *
 * `reconnecting` is true while an automatic retry is pending or in flight, so a
 * lost stream can be told apart from a first connection.
 */
export function useEventStream(
  url: string,
  events: readonly string[],
  onEvent: (event: string, data: unknown) => void,
  terminal: readonly string[] = ["end"],
  options: EventStreamOptions = {},
) {
  const { enabled = true, autoReconnect = false } = options;
  const [tracked, setTracked] = useState<Tracked>({ key: "", status: "connecting" });
  const [attempt, setAttempt] = useState(0);
  const [failures, setFailures] = useState(0);
  const failuresRef = useRef(0);
  const latest = useRef(onEvent);
  useEffect(() => {
    latest.current = onEvent;
  });

  // The status belongs to one (url, attempt, enabled) combination: any other one starts as "connecting".
  const key = `${url}|${attempt}|${enabled}`;
  const status: StreamStatus = tracked.key === key ? tracked.status : "connecting";

  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource(url);
    let finished = false;
    let retry: number | undefined;
    const report = (next: StreamStatus) => setTracked({ key, status: next });

    source.onopen = () => {
      failuresRef.current = 0;
      setFailures(0);
      report("live");
    };

    for (const name of events) {
      source.addEventListener(name, (ev) => {
        if (!(ev instanceof MessageEvent)) return;
        let data: unknown = null;
        try {
          data = JSON.parse(ev.data);
        } catch {
          /* an unparseable payload is passed on as null */
        }
        latest.current(name, data);
        if (terminal.includes(name)) {
          finished = true;
          source.close();
          report("ended");
        }
      });
    }

    // "error" is both the browser's connection failure (a plain Event) and a
    // named event the agent may send (a MessageEvent with a payload).
    source.addEventListener("error", (ev) => {
      const fromAgent = ev instanceof MessageEvent;
      if (fromAgent) {
        try {
          latest.current("error", JSON.parse(ev.data));
        } catch {
          latest.current("error", null);
        }
      }
      if (finished) return;
      source.close();
      report("disconnected");
      // An error the agent reported is an answer, not a dropped connection: do not retry it.
      if (autoReconnect && !fromAgent) {
        const n = failuresRef.current;
        failuresRef.current = n + 1;
        setFailures(n + 1);
        if (n < MAX_RETRIES) retry = window.setTimeout(() => setAttempt((a) => a + 1), BACKOFF_MS[Math.min(n, BACKOFF_MS.length - 1)]);
      }
    });

    return () => {
      clearTimeout(retry);
      source.close();
    };
    // events and terminal are constant lists declared by the caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, attempt, enabled, autoReconnect, key]);

  const reconnect = useCallback(() => {
    failuresRef.current = 0;
    setFailures(0);
    setAttempt((n) => n + 1);
  }, []);

  const reconnecting = autoReconnect && enabled && failures > 0 && failures <= MAX_RETRIES && status !== "ended" && status !== "live";

  return { status, reconnect, reconnecting };
}
