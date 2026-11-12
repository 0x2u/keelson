import { CheckIcon, CircleDashedIcon, LoaderCircleIcon, MinusIcon, XIcon } from "lucide-react";
import { ICONS } from "@/lib/icons";
import type { StepState } from "@/lib/pipeline-core";
import type { Tone } from "@/lib/status";
import { cn } from "@/lib/utils";

/** The small text shade of each tone (the `-text` token passes AA on its theme). */
export const TONE_TEXT: Record<Tone, string> = {
  success: "text-success-text",
  warning: "text-warning-text",
  danger: "text-destructive-text",
  info: "text-info-text",
  muted: "text-muted-foreground",
};

const GLYPHS = {
  done: CheckIcon,
  running: LoaderCircleIcon,
  failed: XIcon,
  skipped: MinusIcon,
  pending: CircleDashedIcon,
  notReached: CircleDashedIcon,
  elsewhere: ICONS.server,
} as const satisfies Record<StepState, typeof CheckIcon>;

/** The shape of a step's state: a tick, a spinner, a cross, a dash, a dashed circle. Always next to the state in words. */
export function StepGlyph({ state, className }: { state: StepState; className?: string }) {
  const Glyph = GLYPHS[state];
  return <Glyph aria-hidden className={cn("size-3.5 shrink-0", state === "running" && "animate-spin motion-reduce:animate-none", className)} />;
}
