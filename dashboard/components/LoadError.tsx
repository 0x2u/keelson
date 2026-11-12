import Link from "next/link";
import type { ReactNode } from "react";
import { RetryButton } from "@/components/RetryButton";
import { Notice } from "@/components/states";
import { Button } from "@/components/ui/button";

/**
 * The card of a page that could not read what it shows (the agent did not answer, the item is gone): the cause, a way to try
 * again and a way back to the list it belongs to, so a failing page is never a dead end.
 */
export function LoadError({ title, back, children }: { title: string; back: { href: string; label: string }; children: ReactNode }) {
  return (
    <Notice
      title={title}
      action={
        <div className="flex flex-wrap items-center gap-3">
          <RetryButton />
          <Button asChild size="sm" variant="ghost">
            <Link href={back.href}>{back.label}</Link>
          </Button>
        </div>
      }
    >
      {children}
    </Notice>
  );
}
