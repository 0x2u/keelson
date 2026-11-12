import { entityMetadata } from "@/lib/metadata";
import { loadServer } from "@/lib/data";
import type { Metadata } from "next";
import { ContainersCard } from "@/components/servers/ContainersCard";
import { serverContainers } from "@/lib/server-data";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const server = loadServer(id);
  return entityMetadata("Containers", server.name);
}

/** Every container on the server. Reads the container list and nothing else. */
export default async function ContainersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ContainersCard serverId={id} containers={await serverContainers(id)} />;
}
