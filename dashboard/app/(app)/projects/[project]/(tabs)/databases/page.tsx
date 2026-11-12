import { entityMetadata, routeName } from "@/lib/metadata";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DatabasesTable } from "@/components/databases/DatabasesTable";
import { DatabaseRestore } from "@/components/databases/DatabaseRestore";
import { hubTabPath } from "@/lib/project-hub-jobs-core";
import { loadProjectHub } from "@/lib/project-hub";

export async function generateMetadata({ params }: { params: Promise<{ project: string }> }): Promise<Metadata> {
  return entityMetadata(routeName((await params).project), "Databases");
}
export const dynamic = "force-dynamic";

export default async function ProjectDatabasesPage({ params }: { params: Promise<{ project: string }> }) {
  const name = decodeURIComponent((await params).project);
  const hub = await loadProjectHub(name);
  if (!hub) notFound();
  return (
    <DatabasesTable
      scope="project"
      entries={hub.members.databases.map((h) => ({ server: h.server, db: h.db, project: hub.name, hub: h }))}
      unanswered={hub.unreachable}
      servers={hub.facts.map((f) => f.server)}
      from={hubTabPath(hub.name, "databases")}
      filter={{ project: hub.name }}
      now={hub.generatedAt}
      unassigned={hub.members.unassignedDatabases}
      restore={(serverId, database) => <DatabaseRestore serverId={serverId} name={database} database={hub.members.databases.find((d) => d.server.id === serverId && d.db.name === database)?.db.database ?? database} />}
    />
  );
}
