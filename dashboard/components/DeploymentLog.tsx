"use client";

import { ArrowDownIcon, ChevronRightIcon, DownloadIcon, RefreshCwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { Deployment, DeploymentEvent, PhaseName } from "@/lib/agent-types";
import { stripAnsi } from "@/lib/ansi-core";
import { groupByPhase, splitOutput, startsOpen, type LogSection } from "@/lib/deployment-log-core";
import { pipeline } from "@/lib/pipeline-core";
import { deploymentStatus, type Tone } from "@/lib/status";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/copy-button";
import { TONE_TEXT } from "@/components/deployments/step";
import { StatusDot } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useEventStream, type StreamStatus } from "@/components/useEventStream";

const EVENTS = ["event", "end", "error"] as const;

const LEVEL_CLASS: Record<DeploymentEvent["level"], string> = {
  info: "text-foreground",
  warn: "text-warning",
  error: "text-destructive",
  output: "text-foreground",
};

const LEVEL_LABEL: Record<DeploymentEvent["level"], string> = {
  info: "info",
  warn: "warning",
  error: "error",
  output: "container output",
};

const BANNER: Record<Tone, string> = {
  success: "border-success/40 bg-success/10 text-success",
  warning: "border-warning/40 bg-warning/10 text-warning",
  danger: "border-destructive/40 bg-destructive/10 text-destructive",
  info: "border-info/40 bg-info/10 text-info",
  muted: "border-border bg-muted text-muted-foreground",
};

const CONNECTION: Record<StreamStatus, { tone: Tone; label: string; live?: boolean }> = {
  connecting: { tone: "warning", label: "Connecting", live: true },
  live: { tone: "info", label: "Following live", live: true },
  ended: { tone: "muted", label: "Stream ended" },
  disconnected: { tone: "danger", label: "Connection lost" },
};

function isEvent(data: unknown): data is DeploymentEvent {
  return typeof data === "object" && data !== null && "seq" in data && "message" in data;
}

/** How long the page waits after a change of phase before it asks the server for the new state of the pipeline (a replay changes phase many times at once). */
const PHASE_REFRESH_MS = 300;

function asText(events: DeploymentEvent[]): string {
  return events.map((e) => `${e.time} ${e.level.toUpperCase().padEnd(5)} ${e.message}`).join("\n");
}

function Line({ e }: { e: DeploymentEvent }) {
  return (
    <div className="flex gap-3 px-3 hover:bg-accent/50">
      <time dateTime={e.time} className="shrink-0 select-none tabular text-muted-foreground">
        {e.time.slice(11, 19)}
      </time>
      <span className="sr-only">{LEVEL_LABEL[e.level]}:</span>
      <span className={cn("min-w-0 whitespace-pre-wrap break-all", LEVEL_CLASS[e.level])}>{e.message}</span>
    </div>
  );
}

/** One phase of the log: a header that opens and closes it, with what became of the phase and how many lines it has. */
function Section({ section, state, open, onOpenChange }: { section: LogSection; state: { label: string; tone: Tone } | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} data-phase={section.phase ?? "other"}>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-1 text-left font-sans text-sm font-medium hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
        {section.label}
        {state !== null && <span className={cn("text-xs font-normal", TONE_TEXT[state.tone])}>{state.label}</span>}
        <span className="ml-auto text-xs font-normal tabular text-muted-foreground">
          {section.events.length} {section.events.length === 1 ? "line" : "lines"}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pb-1">
        {section.events.map((e) => (
          <Line key={e.seq} e={e} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

type Toggled = Partial<Record<PhaseName | "other", boolean>>;

/**
 * The lines of the log: one flat list as it always was, or, when the lines say their phase, a collapsible section per
 * phase (the running or failed one open, the others closed, "Other" for what belongs to none) with its line count.
 */
export function LogLines({
  steps,
  deployment,
  live,
  toggled,
  onToggle,
  empty,
}: {
  steps: DeploymentEvent[];
  deployment: Pick<Deployment, "status" | "trigger" | "phases">;
  /** The phase of the newest line while the log is followed live: it is open even before the page learns of the phase. */
  live: PhaseName | null;
  /** The sections the reader opened (true) or closed (false); the others follow the phase. */
  toggled: Toggled;
  onToggle: (key: PhaseName | "other", open: boolean) => void;
  empty: string;
}) {
  const sections = groupByPhase(steps);
  if (steps.length === 0) return <p className="px-3 text-muted-foreground">{empty}</p>;
  if (sections === null) return steps.map((e) => <Line key={e.seq} e={e} />);
  const pipelineSteps = pipeline(deployment)?.steps ?? [];
  return sections.map((section) => {
    const key = section.phase ?? "other";
    const step = pipelineSteps.find((s) => s.name === section.phase);
    const state = step?.state === "running" || step?.state === "failed" ? { label: step.view.label, tone: step.view.tone } : null;
    return <Section key={key} section={section} state={state} open={toggled[key] ?? startsOpen(section, deployment.phases, live)} onOpenChange={(open) => onToggle(key, open)} />;
  });
}

/**
 * Follows a deployment as it happens. The agent replays the whole log first, so a finished deployment shows its full
 * history. The log is grouped by phase when the agent says which phase each line belongs to (the running or failed one
 * open, the others closed) and is one flat list otherwise. While the deployment runs, a change of phase refreshes the
 * page so its pipeline moves on; when it ends, the page is refreshed so its header shows the final status.
 */
export function DeploymentLog({ serverId, deployment }: { serverId: string; deployment: Pick<Deployment, "id" | "ref" | "status" | "trigger" | "phases"> }) {
  const router = useRouter();
  const deploymentId = deployment.id;
  const [events, setEvents] = useState<DeploymentEvent[]>([]);
  const [final, setFinal] = useState<string | null>(null);
  const [following, setFollowing] = useState(true);
  // Sections the reader opened or closed; every other one follows the phase.
  const [toggled, setToggled] = useState<Toggled>({});
  const scroller = useRef<HTMLDivElement>(null);
  const lastPhase = useRef<PhaseName | undefined>(undefined);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const running = deployment.status === "running";

  useEffect(() => () => clearTimeout(refreshTimer.current), []);

  const { status, reconnect } = useEventStream(
    `/api/servers/${serverId}/deployments/${deploymentId}/events`,
    EVENTS,
    (event, data) => {
      if (event === "event" && isEvent(data)) {
        setEvents((prev) => (prev.some((e) => e.seq === data.seq) ? prev : [...prev, { ...data, message: stripAnsi(data.message) }]));
        if (running && data.phase !== undefined && data.phase !== lastPhase.current) {
          lastPhase.current = data.phase;
          clearTimeout(refreshTimer.current);
          refreshTimer.current = setTimeout(() => router.refresh(), PHASE_REFRESH_MS);
        }
      } else if (event === "end") {
        clearTimeout(refreshTimer.current);
        setFinal(typeof data === "object" && data !== null && "status" in data ? String(data.status) : "finished");
        router.refresh();
      }
    },
  );

  useEffect(() => {
    const el = scroller.current;
    if (following && el) el.scrollTop = el.scrollHeight;
  }, [events, following]);

  function onScroll() {
    const el = scroller.current;
    if (el) setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  }

  function download() {
    const url = URL.createObjectURL(new Blob([asText(events), "\n"], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `deployment-${deploymentId}.log`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const { steps, output } = splitOutput(events);
  const live = final === null && running ? (events.at(-1)?.phase ?? null) : null;
  const connection = CONNECTION[status];
  const result = final === null ? null : deploymentStatus(final, deployment.trigger, deployment.ref);

  return (
    <div className="space-y-3">
      {result && (
        <div role="status" className={cn("flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium", BANNER[result.tone])}>
          <StatusDot tone={result.tone} />
          Finished: {result.label.charAt(0).toLowerCase() + result.label.slice(1)}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm" role="status">
          <StatusDot tone={connection.tone} live={connection.live} />
          <span>{connection.label}</span>
          {status === "disconnected" && (
            <Button type="button" size="xs" variant="outline" onClick={reconnect}>
              <RefreshCwIcon />
              Reconnect
            </Button>
          )}
        </div>
        <div className="flex items-center gap-1">
          <span className="mr-1 text-xs tabular text-muted-foreground">{steps.length} lines</span>
          <CopyButton value={asText(events)} label="Copy log" />
          <Button type="button" variant="ghost" size="icon-xs" onClick={download} disabled={events.length === 0} aria-label="Download log" title="Download log">
            <DownloadIcon />
          </Button>
        </div>
      </div>

      <div className="relative">
        <div
          ref={scroller}
          onScroll={onScroll}
          role="log"
          aria-label="Deployment log"
          aria-live="off"
          tabIndex={0}
          className="h-[28rem] max-h-[70vh] overflow-auto rounded-lg border bg-muted/30 py-2 font-mono text-xs leading-5 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <LogLines
            steps={steps}
            deployment={deployment}
            live={live}
            toggled={toggled}
            onToggle={(key, open) => setToggled((prev) => ({ ...prev, [key]: open }))}
            empty={status === "disconnected" ? "No events received." : "Waiting for events…"}
          />
        </div>
        {!following && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="absolute bottom-3 right-4 shadow-md"
            onClick={() => setFollowing(true)}
          >
            <ArrowDownIcon />
            Jump to latest
          </Button>
        )}
      </div>

      {output.length > 0 && (
        <details className="group rounded-lg border">
          <summary className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring">
            Container output (last lines)
            <span className="text-xs font-normal tabular text-muted-foreground">{output.length} lines</span>
          </summary>
          <div className="space-y-2 border-t p-3">
            <div className="flex justify-end">
              <CopyButton value={output.map((e) => e.message).join("\n")} label="Copy container output" />
            </div>
            <pre role="log" aria-label="Container output" tabIndex={0} className="max-h-96 overflow-auto rounded-md bg-muted/30 p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-all focus-visible:ring-2 focus-visible:ring-ring">
              {output.map((e) => e.message).join("\n")}
            </pre>
          </div>
        </details>
      )}
    </div>
  );
}
