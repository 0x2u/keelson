"use client";

import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";

/**
 * Re-renders the server page every few seconds while something it shows is still running. The next refresh is only
 * scheduled once the previous one has finished: a page with a slow part (the database probe) would otherwise have
 * every refresh replaced by the next before it could show anything.
 */
export function RefreshWhile({ active, everyMs = 3000 }: { active: boolean; everyMs?: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  useEffect(() => {
    if (!active || pending) return;
    const id = setTimeout(() => start(() => router.refresh()), everyMs);
    return () => clearTimeout(id);
  }, [active, pending, everyMs, router]);
  return null;
}
