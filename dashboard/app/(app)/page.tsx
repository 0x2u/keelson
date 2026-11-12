import { Suspense } from "react";
import type { Metadata } from "next";
import { BackupSize } from "@/components/home/BackupSize";
import { TrustLine } from "@/components/readiness/TrustLine";
import { HomeView } from "@/components/home/HomeView";
import { secondFactorEnrolled } from "@/lib/auth/store";
import { loadRunningFleet } from "@/lib/fleet";
import { placementsOf } from "@/lib/home-core";
import { loadCardContext } from "@/lib/project-page";
import { projectView } from "@/lib/project-view-core";
import { groupProjects } from "@/lib/projects-core";

export const metadata: Metadata = { title: "Home" };
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const servers = await loadRunningFleet();
  const projects = groupProjects(placementsOf(servers));
  const context = await loadCardContext(projects);
  const now = Date.now(); // eslint-disable-line react-hooks/purity -- a server component renders once per request
  return (
    <HomeView
      servers={servers}
      projects={projects.map((p) => projectView(p, context))}
      now={now}
      generatedAt={now}
      needsSecondFactor={!secondFactorEnrolled()}
      trust={
        <Suspense fallback={null}>
          <TrustLine servers={servers} now={now} />
        </Suspense>
      }
      backupSize={(serverId, database) => (
        <Suspense fallback={null}>
          <BackupSize serverId={serverId} database={database} />
        </Suspense>
      )}
    />
  );
}
