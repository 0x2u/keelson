import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

// The Keelson mark: two frames of a hull over its keel. The frames take the colour of the text around them, the keel is
// always the brand cyan. The same paths are in docs/brand (the files to use outside the dashboard).
const FRAME_UPPER = "M14 224.2A26 26 0 0 1 29.4 200.5L341.2 60.5A46 46 0 0 1 378.8 60.5L690.6 200.5A26 26 0 0 1 706 224.2L706 255.8A26 26 0 0 1 671.7 280.4L364.4 177.5A14 14 0 0 0 355.6 177.5L48.3 280.4A26 26 0 0 1 14 255.8Z";
const FRAME_LOWER = "M14 348.1A26 26 0 0 1 32.3 323.3L346.4 226.2A46 46 0 0 1 373.6 226.2L687.7 323.3A26 26 0 0 1 706 348.1L706 382.5A26 26 0 0 1 674.1 407.9L363.2 335.7A14 14 0 0 0 356.8 335.7L45.9 407.9A26 26 0 0 1 14 382.5Z";
const KEEL = "M36.7 449L357.8 377.5A10 10 0 0 1 362.2 377.5L683.3 449A29 29 0 0 1 688.8 503.7Q530 543 365.3 663.1A9 9 0 0 1 354.7 663.1Q190 543 31.2 503.7A29 29 0 0 1 36.7 449Z";

/** The mark alone. Decorative by default: give it a `title` where it stands for the name. */
export function KeelsonMark({ className, title, ...props }: ComponentProps<"svg"> & { title?: string }) {
  return (
    <svg viewBox="0 0 720 720" className={cn("size-7 shrink-0", className)} role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true} {...props}>
      <path fill="currentColor" d={FRAME_UPPER} />
      <path fill="currentColor" d={FRAME_LOWER} />
      <path fill="var(--brand)" d={KEEL} />
    </svg>
  );
}

/** The name, in the display face. */
export function KeelsonWordmark({ className }: { className?: string }) {
  return <span className={cn("font-display font-semibold tracking-tight", className)}>Keelson</span>;
}
