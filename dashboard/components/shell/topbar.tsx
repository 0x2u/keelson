"use client";

import { SearchIcon } from "lucide-react";
import { useCommandPalette } from "@/components/shell/command-palette";
import { Separator } from "@/components/ui/separator";
import { UnlockButton } from "@/components/shell/UnlockButton";
import { SidebarTrigger } from "@/components/ui/sidebar";

export function Topbar({ authenticator }: { authenticator: boolean }) {
  const palette = useCommandPalette();
  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
      <button
        type="button"
        onClick={palette.open}
        className="flex h-8 w-full max-w-sm items-center gap-2 rounded-md border bg-muted/50 px-3 text-sm text-muted-foreground transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <SearchIcon className="size-4" aria-hidden />
        <span className="flex-1 text-left">Search…</span>
        <kbd className="hidden rounded border bg-background px-1.5 font-mono text-[10px] sm:inline">⌘K</kbd>
      </button>
      <UnlockButton authenticator={authenticator} />
    </header>
  );
}
