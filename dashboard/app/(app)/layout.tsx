import { cookies, headers } from "next/headers";
import type { ReactNode } from "react";
import { AppSidebar } from "@/components/shell/app-sidebar";
import { CommandPaletteProvider } from "@/components/shell/command-palette";
import { ShellOwnerProvider } from "@/components/shell/shell-owner";
import { Topbar } from "@/components/shell/topbar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { dashboardVersion } from "@/lib/agent-binaries";
import { totpEnabled } from "@/lib/auth/store";
import { listServers } from "@/lib/servers";
import { releaseCheckSoon } from "@/lib/release-check";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  // With KEELSON_REQUIRE_2FA a password-only session may reach exactly one page: where the second factor is set up.
  const pathname = (await headers()).get("x-pathname");
  await requireSession({ allowSetupSession: pathname === "/settings/security" });
  const servers = listServers().map((s) => ({ id: s.id, name: s.name }));
  const defaultOpen = (await cookies()).get("sidebar_state")?.value !== "false";
  const release = releaseCheckSoon();

  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <CommandPaletteProvider>
        <ShellOwnerProvider>
          <AppSidebar servers={servers} version={dashboardVersion()} update={release.status === "newer" && release.latest ? { tag: release.latest.tag } : null} />
          <SidebarInset id="main" className="min-w-0 bg-[radial-gradient(70rem_26rem_at_60%_-10rem,color-mix(in_srgb,var(--brand)_6%,transparent),transparent)]">
            <Topbar authenticator={totpEnabled()} />
            <div className="flex-1 px-4 py-6 md:px-8">
              <div className="mx-auto w-full max-w-6xl">{children}</div>
            </div>
          </SidebarInset>
        </ShellOwnerProvider>
      </CommandPaletteProvider>
    </SidebarProvider>
  );
}
