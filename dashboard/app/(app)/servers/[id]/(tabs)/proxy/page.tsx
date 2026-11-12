import { entityMetadata } from "@/lib/metadata";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { loadServer } from "@/lib/data";
import { canRunApps } from "@/lib/machine-core";
import { HealthSkeleton } from "@/components/ServerSkeleton";
import { ProxyOverview } from "@/components/servers/ProxyOverview";
import { serverProxy } from "@/lib/server-data";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const server = loadServer(id);
  return entityMetadata("Proxy", server.name);
}

/** The reverse proxy: routes, domains and whether what runs is what the agent generates. Reads the proxy and nothing else. */
export default async function ProxyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!canRunApps(loadServer(id))) redirect(`/servers/${id}`);
  return (
    <Suspense fallback={<HealthSkeleton rows={3} />}>
      <ProxyOverview serverId={id} proxy={serverProxy(id)} />
    </Suspense>
  );
}
