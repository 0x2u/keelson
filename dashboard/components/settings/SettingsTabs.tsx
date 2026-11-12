"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SETTINGS_TABS, activeSettingsTab, type SettingsTab } from "@/lib/settings-nav-core";
import { cn } from "@/lib/utils";

/** The pages of Settings: the same bar as a project's (the current page marked, sideways scroll on a narrow screen). `pathname` is for tests; the page reads its own. */
export function SettingsTabs({ pathname, tabs = SETTINGS_TABS }: { pathname?: string; tabs?: readonly SettingsTab[] }) {
  const current = usePathname();
  const active = activeSettingsTab(pathname ?? current ?? "");
  return (
    <div className="relative mb-6">
      <div aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-border" />
      <nav aria-label="Settings sections" className="flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((tab) => (
          <Link
            key={tab.id}
            href={tab.href}
            aria-current={tab.id === active ? "page" : undefined}
            className={cn(
              "relative flex h-10 shrink-0 items-center border-b-2 px-3 text-sm font-medium whitespace-nowrap transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
              tab.id === active ? "border-brand-text text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
