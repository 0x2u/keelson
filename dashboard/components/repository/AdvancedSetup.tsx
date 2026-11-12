"use client";

import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

/** The manual way in, closed by default: creating the App by hand, a read-only token and the webhook secret on their own. */
export function AdvancedSetup({ children, defaultOpen = false }: { children: ReactNode; defaultOpen?: boolean }) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="rounded-xl border">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="group flex w-full items-center justify-between gap-4 rounded-xl px-6 py-4 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <span className="space-y-1">
            <span className="block leading-none font-semibold">Advanced / manual setup</span>
            <span className="block text-sm text-muted-foreground">
              Create the GitHub App yourself and paste its key, connect a read-only token, or manage the webhook secret on its own.
            </span>
          </span>
          <ChevronDownIcon aria-hidden className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent forceMount className="data-[state=closed]:hidden">
        <div className="grid gap-6 px-4 pb-4 sm:px-6 sm:pb-6">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
