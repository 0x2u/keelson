"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { toast } from "sonner";
import type { OutcomeToast } from "@/lib/toast-core";

/** Shows a toast with its action link. `push` opens the link in the app (the router's), so no page reload. */
export function showOutcomeToast(spec: OutcomeToast, push: (href: string) => void): void {
  toast.success(spec.title, {
    description: spec.description,
    duration: spec.duration,
    action: { label: spec.action.label, onClick: () => push(spec.action.href) },
  });
}

/** Shows the toast and opens what it links to: a deployment goes to its log at once, and the toast stays to link back. */
export function useOpenOutcome(): (spec: OutcomeToast) => void {
  const router = useRouter();
  return useCallback(
    (spec) => {
      showOutcomeToast(spec, (href) => router.push(href));
      router.push(spec.action.href);
    },
    [router],
  );
}
