"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { StatusDot } from "@/components/status";
import { activeTab, type TabView } from "@/lib/nav-core";
import { cn } from "@/lib/utils";

/**
 * The tabs of a server: each is a page of its own. The one you are on is marked, a dot says where something needs a look,
 * and on a narrow screen the bar scrolls sideways with the current tab brought into view and a fade on each side that
 * has more, so no label is cut off without a sign.
 */
export function ServerTabs({ serverId, tabs }: { serverId: string; tabs: TabView[] }) {
  const pathname = usePathname();
  const active = activeTab(pathname, serverId);
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setEdges({ left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 });
    const current = el.querySelector<HTMLElement>('[aria-current="page"]');
    if (current) {
      const target = current.offsetLeft - (el.clientWidth - current.offsetWidth) / 2;
      el.scrollLeft = Math.max(0, target);
    }
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      el.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [active, tabs.length]);

  return (
    <div className="relative mb-6">
      <div aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-border" />
      <nav ref={scroller} aria-label="Server sections" className="flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((tab) => (
          <Link
            key={tab.id}
            href={tab.href}
            scroll={false}
            aria-current={tab.id === active ? "page" : undefined}
            className={cn(
              "relative flex h-10 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm font-medium whitespace-nowrap transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
              tab.id === active ? "border-brand-text text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
            {tab.count !== undefined && <span className="tabular text-xs font-normal text-muted-foreground">{tab.count}</span>}
            {tab.attention && (
              <>
                <StatusDot tone={tab.attention.tone} />
                <span className="sr-only">{tab.attention.label}</span>
              </>
            )}
          </Link>
        ))}
      </nav>
      {edges.left && <div aria-hidden data-edge="left" className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-background to-transparent" />}
      {edges.right && <div aria-hidden data-edge="right" className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-background to-transparent" />}
    </div>
  );
}
