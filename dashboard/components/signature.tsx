import type { ReactNode } from "react";
import type { Tone } from "@/lib/status";
import { cn } from "@/lib/utils";

// The pieces the interface is recognised by: a heading that reads as an instrument label, a status orb, a gauge and a
// figure. They carry no logic: callers pass what a lib/*-core function computed.

/** The class of a section's title: a small label in the display face, not a heading of body size. */
export const EYEBROW = "font-display text-[0.75rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground";

const ORB: Record<Tone, { core: string; halo: string }> = {
  success: { core: "bg-success", halo: "bg-success/25" },
  warning: { core: "bg-warning", halo: "bg-warning/25" },
  danger: { core: "bg-destructive", halo: "bg-destructive/25" },
  info: { core: "bg-info", halo: "bg-info/25" },
  muted: { core: "bg-muted-foreground/60", halo: "bg-muted-foreground/15" },
};

/**
 * The state of the whole, drawn large: a core, a halo and, while something is not as it should be, a slow pulse. Decorative:
 * the words next to it say the state.
 */
export function Orb({ tone, className }: { tone: Tone; className?: string }) {
  const c = ORB[tone];
  return (
    <span aria-hidden className={cn("relative inline-flex size-12 shrink-0 items-center justify-center", className)}>
      <span className={cn("absolute inset-0 rounded-full", c.halo, tone !== "success" && tone !== "muted" && "motion-safe:animate-pulse")} />
      <span className={cn("absolute inset-2 rounded-full opacity-40", c.halo)} />
      <span className={cn("relative size-4 rounded-full shadow-[0_0_18px_2px_currentColor]", c.core, tone === "success" ? "text-success/50" : tone === "warning" ? "text-warning/50" : tone === "danger" ? "text-destructive/50" : tone === "info" ? "text-info/50" : "text-transparent")} />
    </span>
  );
}

const FILL: Record<Tone, string> = { success: "bg-foreground/55", info: "bg-info", warning: "bg-warning", danger: "bg-destructive", muted: "bg-muted-foreground/40" };
const TEXT: Record<Tone, string> = { success: "text-foreground", info: "text-info-text", warning: "text-warning-text", danger: "text-destructive-text", muted: "text-muted-foreground" };

/**
 * One measure against its limit: a label, the value in words and a thin bar. A healthy bar is neutral and only a measure
 * that needs a look takes a colour, so a screen of gauges stays calm until one of them is not.
 */
export function Gauge({ label, value, fraction, tone }: { label: string; value: string; fraction: number; tone: Tone }) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0)) * 100;
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn("tabular font-medium", TEXT[tone])}>{value}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted" role="presentation">
        <div className={cn("h-full rounded-full", FILL[tone])} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** A number with its label: the big figure of a summary. */
export function Figure({ label, children, note, tone = "muted" }: { label: string; children: ReactNode; note?: ReactNode; tone?: Tone }) {
  return (
    <div className="min-w-0 space-y-1">
      <p className={EYEBROW}>{label}</p>
      <p className="tabular font-display text-2xl font-semibold tracking-tight">{children}</p>
      {note !== undefined && <p className={cn("text-xs", tone === "muted" ? "text-muted-foreground" : TEXT[tone])}>{note}</p>}
    </div>
  );
}
