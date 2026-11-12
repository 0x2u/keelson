"use client";

import { ArrowRightIcon, KeyboardIcon, LogOutIcon, MonitorIcon, MoonIcon, SunIcon, ZapIcon } from "lucide-react";
import { ICONS } from "@/lib/icons";
import { useTheme } from "next-themes";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { logout } from "@/app/actions";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  RECENT_KEY,
  addRecent,
  buildRegistry,
  contextOf,
  emptyIndex,
  groupRanked,
  initialGroups,
  parseRecent,
  rank,
  type PaletteCommand,
  type PaletteEntry,
  type PaletteGroup,
  type PaletteIndex,
} from "@/lib/palette-core";
import { PALETTE_FOOTER, SHORTCUT_SHEET, createShortcuts } from "@/lib/shortcuts-core";

interface PaletteContext {
  open: () => void;
}

const Ctx = createContext<PaletteContext | null>(null);

export function useCommandPalette(): PaletteContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useCommandPalette must be used inside <CommandPaletteProvider>");
  return ctx;
}

type Icon = ComponentType<{ className?: string }>;

const GROUP_ICONS: Record<PaletteGroup, Icon> = {
  Recent: ICONS.history,
  Actions: ZapIcon,
  "Go to": ArrowRightIcon,
  Projects: ICONS.project,
  Servers: ICONS.server,
  Apps: ICONS.deploy,
  Domains: ICONS.domain,
  Jobs: ICONS.job,
  Databases: ICONS.database,
  Containers: ICONS.container,
  Preferences: SunIcon,
};

const COMMAND_ICONS: Record<PaletteCommand, Icon> = {
  "theme-light": SunIcon,
  "theme-dark": MoonIcon,
  "theme-system": MonitorIcon,
  "sign-out": LogOutIcon,
  shortcuts: KeyboardIcon,
};

const INDEX_TTL_MS = 30_000;

function Keys({ keys, alone }: { keys: string[]; alone: boolean }) {
  return (
    <span className={`${alone ? "ml-auto" : "ml-2"} flex shrink-0 items-center gap-1`}>
      {keys.map((k, i) => (
        <kbd key={`${i}-${k}`} className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground">
          {k}
        </kbd>
      ))}
    </span>
  );
}

function ShortcutSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>They work anywhere except while you type in a field.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {SHORTCUT_SHEET.map((section) => (
            <section key={section.title} aria-labelledby={`shortcuts-${section.title}`}>
              <h3 id={`shortcuts-${section.title}`} className="mb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {section.title}
              </h3>
              <ul className="divide-y rounded-md border">
                {section.items.map((item) => (
                  <li key={item.keys.join(" ")} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span>{item.label}</span>
                    <span className="flex items-center gap-1">
                      {item.keys.map((k, i) => (
                        <kbd key={`${i}-${k}`} className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">
                          {k}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The ⌘K palette: jump to anything on any server, start an action (it opens the page whose dialog asks: the palette itself
 * never changes anything), or run a preference. Also the keyboard shortcuts of the whole dashboard (g then a letter, ?).
 */
export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { setTheme } = useTheme();
  const [isOpen, setOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState<PaletteIndex>(emptyIndex);
  const [loading, setLoading] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const openRef = useRef(false);
  const fetched = useRef({ loadedAt: 0, loading: false });
  const [shortcuts] = useState(() => createShortcuts());

  // The index is fetched when the palette opens, and refreshed when it is older than the TTL.
  const refresh = useCallback(() => {
    if (fetched.current.loading || Date.now() - fetched.current.loadedAt < INDEX_TTL_MS) return;
    fetched.current.loading = true;
    setLoading(true);
    fetch("/api/fleet/search", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<PaletteIndex>) : null))
      .then((value) => {
        if (value === null) return;
        setIndex(value);
        fetched.current.loadedAt = Date.now();
      })
      .catch(() => undefined)
      .finally(() => {
        fetched.current.loading = false;
        setLoading(false);
      });
  }, []);

  const setPalette = useCallback(
    (next: boolean) => {
      openRef.current = next;
      setOpen(next);
      if (next) {
        setQuery("");
        setRecent(parseRecent(window.localStorage.getItem(RECENT_KEY)));
        refresh();
      }
    },
    [refresh],
  );
  const open = useCallback(() => setPalette(true), [setPalette]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPalette(!openRef.current);
        return;
      }
      // A dialog (the palette, the sheet, a confirmation) owns the keyboard while it is open.
      const blocked = openRef.current || document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;
      const result = shortcuts.handle(
        { key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, repeat: e.repeat, target: e.target instanceof HTMLElement ? e.target : null },
        blocked,
      );
      if (result?.type === "go") {
        e.preventDefault();
        router.push(result.href);
      } else if (result?.type === "help") {
        e.preventDefault();
        setSheetOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPalette, router, shortcuts]);

  const context = useMemo(() => contextOf(pathname), [pathname]);
  const registry = useMemo(() => buildRegistry(index, context), [index, context]);
  const groups = useMemo(
    () => (query.trim() === "" ? initialGroups(registry, context, recent) : groupRanked(rank(registry, query, { context, recent }))),
    [registry, context, recent, query],
  );

  const choose = useCallback(
    (entry: PaletteEntry) => {
      setPalette(false);
      const original = { id: entry.id, group: entry.origin ?? entry.group };
      const next = addRecent(recent, original);
      if (next !== recent) window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      if (entry.href !== undefined) {
        router.push(entry.href);
        return;
      }
      switch (entry.command) {
        case "theme-light":
          setTheme("light");
          break;
        case "theme-dark":
          setTheme("dark");
          break;
        case "theme-system":
          setTheme("system");
          break;
        case "sign-out":
          void logout();
          break;
        case "shortcuts":
          setSheetOpen(true);
          break;
      }
    },
    [recent, router, setPalette, setTheme],
  );

  return (
    <Ctx.Provider value={{ open }}>
      {children}
      <CommandDialog
        open={isOpen}
        onOpenChange={setPalette}
        title="Search"
        description="Jump to a project, app, job, database, domain, server or container, or start an action."
        commandProps={{ shouldFilter: false, loop: true }}
      >
        <CommandInput value={query} onValueChange={setQuery} placeholder="Search, or type an action: deploy, roll back, run job, restart…" />
        <CommandList>
          <CommandEmpty>{loading ? "Searching…" : "Nothing matches."}</CommandEmpty>
          {groups.map(({ group, entries }) => (
            <CommandGroup key={group} heading={group}>
              {entries.map((entry) => {
                const Icon = entry.command ? COMMAND_ICONS[entry.command] : GROUP_ICONS[entry.origin ?? entry.group];
                return (
                  <CommandItem key={`${group}:${entry.id}`} value={`${group}:${entry.id}`} onSelect={() => choose(entry)}>
                    <Icon />
                    <span className="truncate">{entry.label}</span>
                    {entry.hint !== undefined && <span className="ml-auto truncate pl-3 text-xs text-muted-foreground">{entry.hint}</span>}
                    {entry.shortcut !== undefined && <Keys keys={entry.shortcut} alone={entry.hint === undefined} />}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ))}
        </CommandList>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t px-3 py-2 text-[11px] text-muted-foreground" data-testid="palette-footer">
          <span>{PALETTE_FOOTER}</span>
          {index.truncated && <span>A large fleet: only the first of each kind is listed. Type more to narrow.</span>}
        </div>
      </CommandDialog>
      <ShortcutSheet open={sheetOpen} onOpenChange={setSheetOpen} />
    </Ctx.Provider>
  );
}
