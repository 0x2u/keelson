"use client";

import { ChevronRightIcon, ChevronsUpDownIcon, ExternalLinkIcon, LogOutIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { ICONS } from "@/lib/icons";
import { useTheme } from "next-themes";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ComponentType } from "react";
import { logout } from "@/app/actions";
import { StatusDot } from "@/components/status";
import { KeelsonMark, KeelsonWordmark } from "@/components/brand";
import { useFleetHealth } from "@/components/shell/use-fleet-health";
import { useShellOwner } from "@/components/shell/shell-owner";
import { serverDot } from "@/lib/server-dot-core";
import { FOOTER_NAV, NAV, projectHref, projectsEntryLit, serversEntryLit, sidebarActive } from "@/lib/nav-core";
import type { Tone } from "@/lib/status";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";

export interface SidebarServer {
  id: string;
  name: string;
}

const NAV_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  "/": ICONS.home,
  "/projects": ICONS.project,
  "/servers": ICONS.server,
  "/activity": ICONS.activity,
  "/settings": ICONS.settings,
};

/** The documentation of the repository, in a new tab. */
const DOCS_URL = "https://github.com/0x2u/keelson/tree/main/docs";

function AccountMenu() {
  const { theme, setTheme } = useTheme();
  const { isMobile } = useSidebar();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent">
          <span className="flex size-8 items-center justify-center rounded-md bg-muted text-xs font-semibold">OP</span>
          <span className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-medium">Operator</span>
            <span className="truncate text-xs text-muted-foreground">Signed in</span>
          </span>
          <ChevronsUpDownIcon className="ml-auto size-4 text-muted-foreground" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side={isMobile ? "bottom" : "right"} align="end" className="w-56">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={setTheme}>
          <DropdownMenuRadioItem value="light"><SunIcon /> Light</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark"><MoonIcon /> Dark</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system"><MonitorIcon /> System</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a href={DOCS_URL} target="_blank" rel="noreferrer noopener">
            <ExternalLinkIcon /> Docs
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </DropdownMenuItem>
        <form action={logout}>
          <button type="submit" className="relative flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none hover:bg-accent focus-visible:bg-accent [&_svg]:size-4 [&_svg]:text-muted-foreground">
            <LogOutIcon /> Sign out
          </button>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface ListItem {
  key: string;
  href: string;
  label: string;
  tone: Tone;
  /** What the dot says, for the tooltip and screen readers: the colour is never the only carrier. */
  status: string;
  active: boolean;
}

/**
 * An entry of the sidebar that stands for a list page and, under it, folded away at will, the things the list holds, each with its
 * live status dot and an "add" line at the end. The icon-only sidebar hides the list, as does folding it: then the entry stands
 * for the page, so the current page is never left unmarked.
 */
function ExpandableEntry({
  href,
  label,
  noun,
  icon: Icon,
  items,
  add,
  lit,
  onNavigate,
}: {
  href: string;
  label: string;
  noun: string;
  icon: ComponentType<{ className?: string }>;
  items: ListItem[];
  add: { href: string; label: string; active: boolean };
  lit: (listShown: boolean) => boolean;
  onNavigate: () => void;
}) {
  const { state, isMobile } = useSidebar();
  const [open, setOpen] = useState(true);
  const listShown = open && (state === "expanded" || isMobile);

  return (
    <Collapsible asChild open={open} onOpenChange={setOpen}>
      <SidebarMenuItem>
        <SidebarMenuButton asChild isActive={lit(listShown)} tooltip={label}>
          <Link href={href} onClick={onNavigate}>
            <Icon />
            <span>{label}</span>
          </Link>
        </SidebarMenuButton>
        <CollapsibleTrigger asChild>
          <SidebarMenuAction aria-label={open ? `Hide the ${noun} list` : `Show the ${noun} list`} className="data-[state=open]:rotate-90">
            <ChevronRightIcon />
          </SidebarMenuAction>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {items.map((item) => (
              <SidebarMenuSubItem key={item.key}>
                <SidebarMenuSubButton asChild isActive={item.active}>
                  <Link href={item.href} onClick={onNavigate} title={`${item.label} · ${item.status}`}>
                    <StatusDot tone={item.tone} />
                    <span>{item.label}</span>
                    <span className="sr-only">{item.status}</span>
                  </Link>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))}
            <SidebarMenuSubItem>
              <SidebarMenuSubButton asChild isActive={add.active} className="text-muted-foreground">
                <Link href={add.href} onClick={onNavigate}>
                  <ICONS.add />
                  <span>{add.label}</span>
                </Link>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

/** Projects in the sidebar: where you operate. Each with the state of its worst environment. */
function ProjectsMenu({ onNavigate }: { onNavigate: () => void }) {
  const pathname = usePathname();
  const owner = useShellOwner();
  const { projects } = useFleetHealth();
  const active = sidebarActive(pathname, owner);
  return (
    <ExpandableEntry
      href="/projects"
      label="Projects"
      noun="project"
      icon={ICONS.project}
      items={projects.map((p) => ({ key: p.name, href: projectHref(p.name), label: p.name, tone: p.tone, status: p.label, active: active.project === p.name }))}
      add={{ href: "/projects/new", label: "New project", active: active.addProject }}
      lit={(listShown) => projectsEntryLit(pathname, listShown, owner)}
      onNavigate={onNavigate}
    />
  );
}

/** Servers in the sidebar: infrastructure. Each with its live status dot. */
function ServersMenu({ servers, onNavigate }: { servers: SidebarServer[]; onNavigate: () => void }) {
  const pathname = usePathname();
  const owner = useShellOwner();
  const health = useFleetHealth().servers;
  const active = sidebarActive(pathname, owner);
  return (
    <ExpandableEntry
      href="/servers"
      label="Servers"
      noun="server"
      icon={ICONS.server}
      items={servers.map((s) => {
        const view = serverDot(health[s.id]);
        return { key: s.id, href: `/servers/${s.id}`, label: s.name, tone: view.tone, status: view.label, active: active.server === s.id };
      })}
      add={{ href: "/servers/new", label: "Add server", active: active.addServer }}
      lit={(listShown) => serversEntryLit(pathname, listShown, owner)}
      onNavigate={onNavigate}
    />
  );
}

export function AppSidebar({ servers, version, update }: { servers: SidebarServer[]; version: string; /** The release this dashboard can be updated to, when a newer one is known. */ update?: { tag: string } | null }) {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  const close = () => setOpenMobile(false);
  const owner = useShellOwner();
  const { section } = sidebarActive(pathname, owner);

  return (
    <Sidebar collapsible="icon">
      {/* One landmark for everything in the sidebar, so no link of it sits outside a region (display: contents keeps the layout). */}
      <nav aria-label="Main" className="contents">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip="Keelson" className="group-data-[collapsible=icon]:p-1.5!">
              <Link href="/" onClick={close}>
                {/* In a wrapper: the button sizes its direct icons at 16 px, and the mark is not one of them. Smaller once the sidebar is collapsed to its icons. */}
                <span className="flex size-8 items-center justify-center text-sidebar-accent-foreground group-data-[collapsible=icon]:size-5">
                  <KeelsonMark className="size-full" />
                </span>
                <KeelsonWordmark className="text-[1.0625rem] text-sidebar-accent-foreground group-data-[collapsible=icon]:hidden" />
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV.map(({ href, label }) => {
                if (href === "/projects") return <ProjectsMenu key={href} onNavigate={close} />;
                if (href === "/servers") return <ServersMenu key={href} servers={servers} onNavigate={close} />;
                const Icon = NAV_ICONS[href];
                return (
                  <SidebarMenuItem key={href}>
                    <SidebarMenuButton asChild isActive={section === href} tooltip={label}>
                      <Link href={href} onClick={close}>
                        <Icon />
                        <span>{label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          {FOOTER_NAV.map(({ href, label }) => {
            const Icon = NAV_ICONS[href];
            return (
              <SidebarMenuItem key={href}>
                <SidebarMenuButton asChild isActive={section === href} tooltip={label}>
                  <Link href={href} onClick={close}>
                    <Icon />
                    <span>{label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
          <SidebarMenuItem>
            <AccountMenu />
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="flex items-center gap-2 px-2 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
          <p className="min-w-0 truncate" title={`Keelson ${version}`}>
            Keelson {version}
          </p>
          {update && (
            <Link
              href="/settings#settings-about"
              onClick={close}
              title={`Keelson ${update.tag} is available`}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none"
            >
              <span aria-hidden className="size-1.5 rounded-full bg-info" />
              Update available
            </Link>
          )}
        </div>
      </SidebarFooter>
      </nav>
      <SidebarRail />
    </Sidebar>
  );
}
