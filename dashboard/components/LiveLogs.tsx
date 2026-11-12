"use client";

import { ArrowDownIcon, CopyIcon, DownloadIcon, PauseIcon, PlayIcon, RotateCwIcon, WrapTextIcon } from "lucide-react";
import { ICONS } from "@/lib/icons";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ConnectionState, connectionView } from "@/components/ConnectionState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEventStream, usePageVisible } from "@/components/useEventStream";
import type { LogLine } from "@/lib/agent-types";
import { stripAnsi } from "@/lib/ansi-core";
import { cn } from "@/lib/utils";

/** Lines kept in memory: the oldest are dropped beyond this, and the viewer says so. */
const MAX_LINES = 5000;
const FLUSH_MS = 100;
/** How far from the bottom (px) still counts as "at the bottom". */
const BOTTOM_SLACK = 24;
const EVENTS = ["log", "end", "error"] as const;

interface LogRow {
  id: number;
  time: string;
  stderr: boolean;
  text: string;
}

interface Buffer {
  rows: LogRow[];
  /** Lines discarded from the front to stay within MAX_LINES. */
  dropped: number;
}

const EMPTY: Buffer = { rows: [], dropped: 0 };

function isLogLine(data: unknown): data is LogLine {
  return typeof data === "object" && data !== null && "line" in data && "stream" in data && typeof data.line === "string";
}

function errorMessage(data: unknown): string | undefined {
  if (typeof data === "object" && data !== null && "error" in data && typeof data.error === "string") return data.error;
  return undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function plainText(row: LogRow): string {
  return `${row.time ? `${row.time} ` : ""}${row.stderr ? "[stderr] " : ""}${row.text}`;
}

const Row = memo(function Row({ row, pattern, wrap, timestamps }: { row: LogRow; pattern: RegExp | null; wrap: boolean; timestamps: boolean }) {
  const parts = pattern ? row.text.split(pattern) : [row.text];
  return (
    <div
      className={cn(
        "flex gap-3 [contain-intrinsic-size:auto_1.25rem] [content-visibility:auto]",
        wrap ? "" : "w-max min-w-full",
      )}
    >
      {timestamps && (
        <span className="shrink-0 select-none text-muted-foreground" title={row.time}>
          {row.time ? row.time.slice(11, 23) : "\u00a0".repeat(12)}
        </span>
      )}
      <span className={cn(wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre", row.stderr && "text-warning")}>
        {row.stderr && <span className="sr-only">stderr: </span>}
        {parts.map((part, i) =>
          i % 2 === 1 ? (
            <mark key={i} className="rounded-sm bg-info/30 text-foreground">
              {part}
            </mark>
          ) : (
            part
          ),
        )}
      </span>
    </div>
  );
});

export function LiveLogs({ serverId, container, tail = 300 }: { serverId: string; container: string; tail?: number }) {
  const [buffer, setBuffer] = useState<Buffer>(EMPTY);
  const [filter, setFilter] = useState("");
  const [follow, setFollow] = useState(true);
  const [wrap, setWrap] = useState(true);
  const [timestamps, setTimestamps] = useState(true);
  const [paused, setPaused] = useState(false);
  const [held, setHeld] = useState(0);
  const [streamError, setStreamError] = useState<string | undefined>(undefined);

  const pending = useRef<LogRow[]>([]);
  const pendingDropped = useRef(0);
  const nextId = useRef(0);
  const panel = useRef<HTMLDivElement>(null);
  // After a reconnect the agent replays the tail: lines up to the newest one already shown are skipped.
  const lastMs = useRef<number | null>(null);
  const lastKeys = useRef<Set<string>>(new Set());
  const replaying = useRef(false);

  const visible = usePageVisible();
  const url = `/api/servers/${serverId}/containers/${encodeURIComponent(container)}/logs?follow=true&tail=${tail}`;
  const { status, reconnect, reconnecting } = useEventStream(
    url,
    EVENTS,
    (event, data) => {
      if (event === "error") {
        setStreamError(errorMessage(data));
        return;
      }
      if (event !== "log" || !isLogLine(data)) return;
      const key = `${data.stream}|${data.line}`;
      const ms = Date.parse(data.time);
      if (!Number.isNaN(ms)) {
        if (replaying.current && lastMs.current !== null) {
          if (ms < lastMs.current || (ms === lastMs.current && lastKeys.current.has(key))) return;
          replaying.current = false;
        }
        if (ms !== lastMs.current) {
          lastMs.current = ms;
          lastKeys.current = new Set();
        }
        lastKeys.current.add(key);
      }
      pending.current.push({ id: nextId.current++, time: data.time, stderr: data.stream === "stderr", text: stripAnsi(data.line) });
      if (pending.current.length > MAX_LINES) {
        const excess = pending.current.length - MAX_LINES;
        pending.current.splice(0, excess);
        pendingDropped.current += excess;
      }
    },
    ["end"],
    { enabled: visible, autoReconnect: true },
  );

  useEffect(() => {
    if (status === "disconnected" || !visible) replaying.current = true;
  }, [status, visible]);

  // Batch incoming lines: a chatty container must not cause a render per line.
  useEffect(() => {
    const timer = setInterval(() => {
      if (paused) {
        setHeld(pending.current.length);
        return;
      }
      if (pending.current.length === 0) return;
      const batch = pending.current;
      const batchDropped = pendingDropped.current;
      pending.current = [];
      pendingDropped.current = 0;
      setHeld(0);
      setBuffer((prev) => {
        const all = prev.rows.length === 0 ? batch : [...prev.rows, ...batch];
        const over = Math.max(0, all.length - MAX_LINES);
        return { rows: over > 0 ? all.slice(over) : all, dropped: prev.dropped + batchDropped + over };
      });
    }, FLUSH_MS);
    return () => clearInterval(timer);
  }, [paused]);

  const needle = filter.trim();
  const lowered = needle.toLowerCase();
  const shown = lowered ? buffer.rows.filter((r) => r.text.toLowerCase().includes(lowered)) : buffer.rows;
  const pattern = useMemo(() => (needle ? new RegExp(`(${escapeRegExp(needle)})`, "i") : null), [needle]);

  useEffect(() => {
    const el = panel.current;
    if (follow && el) el.scrollTop = el.scrollHeight;
  }, [shown.length, follow, wrap, timestamps]);

  function onScroll() {
    const el = panel.current;
    if (!el) return;
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK);
  }

  function jumpToLatest() {
    setFollow(true);
    const el = panel.current;
    if (el) el.scrollTop = el.scrollHeight;
  }

  function clear() {
    pending.current = [];
    pendingDropped.current = 0;
    setHeld(0);
    setBuffer(EMPTY);
  }

  function startOver() {
    clear();
    lastMs.current = null;
    lastKeys.current = new Set();
    replaying.current = false;
    setStreamError(undefined);
    setFollow(true);
    reconnect();
  }

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(shown.map(plainText).join("\n"));
      toast.success(`Copied ${shown.length} ${shown.length === 1 ? "line" : "lines"}.`);
    } catch {
      toast.error("Could not copy: the browser refused clipboard access.");
    }
  }

  function download() {
    const blob = new Blob([shown.map(plainText).join("\n"), "\n"], { type: "text/plain" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = `${container}-logs.txt`;
    link.click();
    URL.revokeObjectURL(href);
    toast.success(`Downloaded ${shown.length} ${shown.length === 1 ? "line" : "lines"} as ${link.download}.`);
  }

  const view = connectionView(status, reconnecting, visible);
  const lost = visible && !reconnecting && (status === "disconnected" || status === "ended");
  const empty = buffer.rows.length === 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <ConnectionState view={view} subject="Log stream" />
        {lost && (
          <Button type="button" size="xs" variant="outline" onClick={startOver}>
            <RotateCwIcon />
            Reload
          </Button>
        )}
        <span className="ml-auto text-xs text-muted-foreground tabular">
          {needle ? `${shown.length} of ${buffer.rows.length}` : buffer.rows.length} {buffer.rows.length === 1 ? "line" : "lines"}
          {paused && held > 0 ? `, ${held} held` : ""}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter lines"
          aria-label="Filter log lines"
          className="h-8 w-full min-w-40 sm:w-64"
        />
        <Button type="button" size="sm" variant={follow ? "secondary" : "outline"} aria-pressed={follow} onClick={() => (follow ? setFollow(false) : jumpToLatest())}>
          <ArrowDownIcon />
          <span>Follow</span>
        </Button>
        <Button type="button" size="sm" variant={wrap ? "secondary" : "outline"} aria-pressed={wrap} onClick={() => setWrap((w) => !w)}>
          <WrapTextIcon />
          <span>Wrap</span>
        </Button>
        <Button type="button" size="sm" variant={timestamps ? "secondary" : "outline"} aria-pressed={timestamps} onClick={() => setTimestamps((t) => !t)}>
          <span>Times</span>
        </Button>
        <Button type="button" size="sm" variant={paused ? "secondary" : "outline"} aria-pressed={paused} onClick={() => setPaused((p) => !p)}>
          {paused ? <PlayIcon /> : <PauseIcon />}
          <span>{paused ? "Resume" : "Pause"}</span>
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={clear} disabled={empty && held === 0} aria-label="Clear the viewer">
            <ICONS.remove />
            <span className="hidden sm:inline">Clear</span>
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={copyAll} disabled={shown.length === 0} aria-label="Copy the shown lines">
            <CopyIcon />
            <span className="hidden sm:inline">Copy</span>
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={download} disabled={shown.length === 0} aria-label="Download the shown lines as a text file">
            <DownloadIcon />
            <span className="hidden sm:inline">Download</span>
          </Button>
        </div>
      </div>

      {lost && streamError && <p className="text-sm text-destructive">The agent reported: {streamError}</p>}

      <div className="relative">
        <div
          ref={panel}
          role="log"
          aria-live="off"
          aria-label={`Logs of ${container}`}
          tabIndex={0}
          onScroll={onScroll}
          className="h-[60vh] min-h-72 overflow-auto rounded-lg border bg-muted/30 p-3 font-mono text-xs leading-5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {buffer.dropped > 0 && (
            <p className="mb-2 border-b pb-2 text-muted-foreground">
              {buffer.dropped.toLocaleString()} older {buffer.dropped === 1 ? "line was" : "lines were"} dropped: the viewer keeps the latest{" "}
              {MAX_LINES.toLocaleString()}. Download the logs from the agent host for the full history.
            </p>
          )}
          {shown.length === 0 ? (
            <p className="text-muted-foreground">
              {!empty
                ? "No line matches the filter."
                : status === "connecting" || reconnecting
                  ? "Waiting for logs…"
                  : "This container has written no logs."}
            </p>
          ) : (
            shown.map((row) => <Row key={row.id} row={row} pattern={pattern} wrap={wrap} timestamps={timestamps} />)
          )}
        </div>
        {!follow && (
          <Button type="button" size="sm" className="absolute right-4 bottom-4 shadow-md" onClick={jumpToLatest}>
            <ArrowDownIcon />
            Jump to latest
          </Button>
        )}
      </div>
    </div>
  );
}
