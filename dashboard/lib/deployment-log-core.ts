import type { DeploymentEvent, DeploymentPhase, PhaseName } from "@/lib/agent-types";
import { PHASE_ORDER, phaseLabel } from "@/lib/pipeline-core";

/**
 * A failed deployment stores the last lines of the failed container's output as events of level "output", next to the
 * agent's own steps. They are application output, not steps: they belong in their own, collapsed block.
 */
export function splitOutput(events: DeploymentEvent[]): { steps: DeploymentEvent[]; output: DeploymentEvent[] } {
  const steps: DeploymentEvent[] = [];
  const output: DeploymentEvent[] = [];
  for (const e of events) (e.level === "output" ? output : steps).push(e);
  return { steps, output };
}

/** The lines of one phase of the log (`phase` null: the lines that happened outside any phase, shown as "Other"). */
export interface LogSection {
  phase: PhaseName | null;
  label: string;
  events: DeploymentEvent[];
}

/**
 * The log grouped by phase, in pipeline order, "Other" last. Null when no line says its phase (an agent that does not
 * track them): the log is then one flat list, as it always was.
 */
export function groupByPhase(steps: DeploymentEvent[]): LogSection[] | null {
  if (!steps.some((e) => e.phase !== undefined && PHASE_ORDER.includes(e.phase))) return null;
  const sections = new Map<PhaseName | null, DeploymentEvent[]>();
  for (const e of steps) {
    const key = e.phase !== undefined && PHASE_ORDER.includes(e.phase) ? e.phase : null;
    const list = sections.get(key);
    if (list) list.push(e);
    else sections.set(key, [e]);
  }
  return [...PHASE_ORDER, null].flatMap((phase) => {
    const events = sections.get(phase);
    return events ? [{ phase, label: phase === null ? "Other" : phaseLabel(phase), events }] : [];
  });
}

/**
 * Whether a section starts open: the phase that runs or failed (the agent's word), the phase the newest line came from
 * while the log is followed live (`live`; the page learns of a new phase a moment after the stream does), and "Other"
 * only when it holds an error. The reader's own opening and closing wins over this.
 */
export function startsOpen(section: LogSection, phases: DeploymentPhase[] | undefined, live: PhaseName | null): boolean {
  if (section.phase === null) return section.events.some((e) => e.level === "error");
  if (section.phase === live) return true;
  return phases?.some((p) => p.name === section.phase && (p.status === "running" || p.status === "failed")) ?? false;
}
