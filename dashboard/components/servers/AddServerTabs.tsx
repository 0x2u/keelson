"use client";

import { ChevronDownIcon } from "lucide-react";
import { ConnectMachine } from "@/components/servers/ConnectMachine";
import { ConnectServer } from "@/components/servers/ConnectServer";
import { EnrolServer } from "@/components/servers/EnrolServer";
import { ImportServers } from "@/components/servers/ImportServers";
import { ManualInstall } from "@/components/servers/ManualInstall";
import { SshInstallWizard, type InstallPrefill } from "@/components/servers/SshInstallWizard";
import { ServerForm } from "@/components/ServerForm";
import { FOCUS_RING } from "@/components/layout";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/** One line each: when to use this way instead of the command above. */
function When({ children }: { children: string }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

/**
 * Add a server: the one-command install first. Everything that reaches the agent from the dashboard (SSH, a code, an
 * address and token, mutual TLS) or connects something other than a server stays, folded under Advanced. A prefill (from an
 * import) or an enrolment string in the link opens Advanced on the tab that takes it: the installer filled in, or the code
 * tab with the field filled, never sent.
 */
export function AddServerTabs({ prefill, enrol }: { prefill?: InstallPrefill; enrol?: string }) {
  const prefilled = prefill !== undefined && Object.values(prefill).some((v) => v !== undefined);
  return (
    <div className="max-w-3xl space-y-6">
      <ConnectServer />
      <Collapsible asChild defaultOpen={enrol !== undefined || prefilled}>
        <section data-testid="add-server-advanced" className="space-y-6">
          <CollapsibleTrigger asChild>
            <button type="button" className={`group flex w-full items-center justify-between gap-4 rounded-xl border bg-card px-6 py-4 text-left shadow-xs ${FOCUS_RING}`}>
              <span className="space-y-1.5">
                <span className="block leading-none font-semibold">Advanced</span>
                <span className="block text-sm text-muted-foreground">Reach the agent from this dashboard (SSH, a code, an address), run it yourself, or connect a computer that builds.</span>
              </span>
              <ChevronDownIcon aria-hidden className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent forceMount className="data-[state=closed]:hidden">
            <div>
              <Tabs defaultValue={enrol ? "enrol" : "ssh"} className="gap-6">
                <TabsList variant="line" aria-label="How to add the server" className="max-w-full overflow-x-auto overflow-y-hidden [scrollbar-width:none]">
                  <TabsTrigger value="ssh">Install over SSH</TabsTrigger>
                  <TabsTrigger value="enrol">Enrol with a code</TabsTrigger>
                  <TabsTrigger value="machine">A computer that connects</TabsTrigger>
                  <TabsTrigger value="manual">Run it yourself</TabsTrigger>
                  <TabsTrigger value="existing">Existing agent</TabsTrigger>
                  <TabsTrigger value="import">Import a file</TabsTrigger>
                </TabsList>
                <TabsContent value="ssh" className="space-y-4">
                  <When>When the server can be reached over SSH from this dashboard, and its agent should be reached at an address with mutual TLS.</When>
                  <SshInstallWizard prefill={prefill} />
                </TabsContent>
                <TabsContent value="enrol" className="space-y-4">
                  <When>When the agent runs on a server this dashboard can reach, and you want mutual TLS without typing certificates: the agent prints a one-time line to paste here.</When>
                  <EnrolServer initial={enrol} />
                </TabsContent>
                <TabsContent value="machine" className="space-y-4">
                  <When>For a Mac or laptop that does not serve traffic: it can build images, and it is not a server to deploy to.</When>
                  <ConnectMachine />
                </TabsContent>
                <TabsContent value="manual" className="space-y-4">
                  <When>When this dashboard has no SSH access to the server: you run the installer there and paste what it prints.</When>
                  <ManualInstall />
                </TabsContent>
                <TabsContent value="existing" className="space-y-4">
                  <When>For an agent you already run: give its address and token. The dashboard checks that it answers before saving.</When>
                  <ServerForm />
                </TabsContent>
                <TabsContent value="import" className="space-y-4">
                  <When>To register several servers at once from a JSON file.</When>
                  <ImportServers />
                </TabsContent>
              </Tabs>
            </div>
          </CollapsibleContent>
        </section>
      </Collapsible>
    </div>
  );
}
