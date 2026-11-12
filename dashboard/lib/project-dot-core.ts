import type { ServerSnapshot } from "@/lib/attention-core";
import { environmentState, groupProjects, type Placement } from "@/lib/projects-core";
import type { StatusView, Tone } from "@/lib/status";

// The sidebar's dot for a project: where its worst environment stands, in the one environment vocabulary (lib/status
// ENVIRONMENTS), from the apps the servers answered. A server that did not answer contributes nothing: a project that
// lives only there has no dot to show (grey, "Status unknown"), never a stale "Running".

/** One project as /api/fleet/health reports it. */
export interface ProjectDotStatus {
  name: string;
  tone: Tone;
  label: string;
}

const SEVERITY: Record<Tone, number> = { danger: 4, warning: 3, info: 2, success: 1, muted: 0 };

/** The projects of the servers' apps, each with the state of its worst environment (alphabetical, as the Projects page lists them). */
export function projectDots(snapshots: Pick<ServerSnapshot, "server" | "apps">[]): ProjectDotStatus[] {
  const placements: Placement[] = snapshots.flatMap((s) => (s.apps ?? []).map((app): Placement => ({ server: { ...s.server, canDeploy: false }, app, jobs: [] })));
  return groupProjects(placements).map((p) => {
    let worst: StatusView | null = null;
    for (const env of p.environments) {
      for (const placement of env.placements) {
        const state = environmentState(placement.app);
        if (worst === null || SEVERITY[state.tone] > SEVERITY[worst.tone]) worst = { tone: state.tone, label: state.label };
      }
    }
    return { name: p.name, tone: worst?.tone ?? "muted", label: worst?.label ?? "Status unknown" };
  });
}
