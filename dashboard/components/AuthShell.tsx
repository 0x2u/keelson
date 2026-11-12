import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { KeelsonMark, KeelsonWordmark } from "@/components/brand";

/**
 * The frame of the pages that are shown before there is a session: the mark, the name, what the product stands for, and
 * the card under them. It is the one place where the brand is the subject, so it gets a backdrop: a glow of the keel's
 * cyan from above, and the mark, very faint, rising from below.
 */
export function AuthShell({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden bg-background px-4 py-10">
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute inset-x-0 top-0 h-[36rem] bg-[radial-gradient(48rem_24rem_at_50%_-6rem,color-mix(in_srgb,var(--brand)_16%,transparent),transparent)]" />
        <KeelsonMark className="absolute -bottom-[26rem] left-1/2 size-[64rem] -translate-x-1/2 text-foreground opacity-[0.035]" />
      </div>
      <div className={cn("relative w-full space-y-6", wide ? "max-w-md" : "max-w-sm")}>
        <div className="flex flex-col items-center gap-3">
          <KeelsonMark className="size-14" />
          <div className="flex flex-col items-center gap-1">
            <KeelsonWordmark className="text-2xl" />
            <p className="text-sm text-muted-foreground">Sure deploys. Proven backups.</p>
          </div>
        </div>
        {children}
      </div>
    </main>
  );
}
