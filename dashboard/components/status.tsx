import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { BackupState } from "@/lib/databases-fleet-core";
import type { RunState } from "@/lib/github-core";
import type { DeliveryOutcome } from "@/lib/github-webhook-core";
import type { JobState } from "@/lib/project-hub-jobs-core";
import type { ReadinessState } from "@/lib/readiness-core";
import {
  BACKUP_STATES,
  ciStatus,
  containerStatus,
  deliveryStatus,
  deploymentStatus,
  jobRunStatus,
  JOB_STATES,
  READINESS,
  serverStatus,
  type ServerAttention,
  type StatusView,
  type Tone,
} from "@/lib/status";

const DOT: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
  info: "bg-info",
  muted: "bg-muted-foreground/50",
};

/** A coloured dot. Never the only carrier of meaning: pair it with a label or a title. */
export function StatusDot({ tone, live, className }: { tone: Tone; live?: boolean; className?: string }) {
  return (
    <span aria-hidden className={cn("relative inline-flex size-2 shrink-0", className)}>
      {live && <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-60", DOT[tone])} />}
      <span className={cn("relative inline-flex size-2 rounded-full", DOT[tone])} />
    </span>
  );
}

/** A status from lib/status. Callers pass a looked-up view, never a {tone, label} written in place (a test enforces it). */
export function StatusBadge({ view }: { view: StatusView }) {
  return (
    <Badge variant={view.tone}>
      <StatusDot tone={view.tone} live={view.live} />
      {view.label}
    </Badge>
  );
}

/** `image` is what the deployment put in service: a roll back that worked then says which version it went back to. */
export function DeploymentBadge({ status, trigger, image }: { status: string; trigger?: string; image?: string }) {
  return <StatusBadge view={deploymentStatus(status, trigger, image)} />;
}

export function JobBadge({ status }: { status: string }) {
  return <StatusBadge view={jobRunStatus(status)} />;
}

export function JobStateBadge({ state }: { state: JobState }) {
  return <StatusBadge view={JOB_STATES[state]} />;
}

export function BackupBadge({ state }: { state: BackupState }) {
  return <StatusBadge view={BACKUP_STATES[state]} />;
}

export function ReadinessBadge({ state }: { state: ReadinessState }) {
  return <StatusBadge view={READINESS[state]} />;
}

export function ContainerBadge({ state, health }: { state: string; health?: string }) {
  return <StatusBadge view={containerStatus(state, health)} />;
}

export function CiBadge({ state }: { state: RunState }) {
  return <StatusBadge view={ciStatus(state)} />;
}

export function DeliveryBadge({ outcome }: { outcome: DeliveryOutcome }) {
  return <StatusBadge view={deliveryStatus(outcome)} />;
}

/** The one badge a server wears everywhere: Online, the attention verdict, Offline or Unreachable. */
export function ServerStatusBadge({ reachable, machine, attention }: { reachable: boolean; machine?: boolean; attention?: ServerAttention }) {
  return <StatusBadge view={serverStatus({ reachable, machine, attention })} />;
}
