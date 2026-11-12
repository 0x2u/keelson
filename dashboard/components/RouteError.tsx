"use client";

import Link from "next/link";
import { RotateCwIcon } from "lucide-react";
import { Notice } from "@/components/states";
import { Button } from "@/components/ui/button";

/**
 * A page failed while rendering. The digest lets the operator find the matching server log line. With `back`, the
 * notice also links out of the failing page (used where the layout above stays on screen with its tabs).
 */
export function RouteError({
  error,
  reset,
  back,
  className = "mx-auto max-w-xl pt-12",
}: {
  error: Error & { digest?: string };
  reset: () => void;
  back?: { href: string; label: string };
  className?: string;
}) {
  return (
    <div className={className}>
      <Notice
        title="This page could not be displayed"
        action={
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant="outline" onClick={reset}>
              <RotateCwIcon /> Retry
            </Button>
            {back && (
              <Button size="sm" variant="ghost" asChild>
                <Link href={back.href}>{back.label}</Link>
              </Button>
            )}
            {error.digest && <span className="font-mono text-xs text-muted-foreground">ref {error.digest}</span>}
          </div>
        }
      >
        Something failed on the server while loading this page. Your servers are not affected.
      </Notice>
    </div>
  );
}
