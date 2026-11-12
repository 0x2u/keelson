import { Suspense } from "react";
import { DisabledWithReason } from "@/components/GatedButton";
import { TestRestoreDialog } from "@/components/readiness/TestRestoreDialog";
import { Button } from "@/components/ui/button";
import { databaseBackups } from "@/lib/server-data";

/** Lists the backups at the database's destination (read from the destination, so it can be slow), then offers the restore test; the checklist paints without waiting for it. */
export function TestRestoreAction({ serverId, name, canDeploy, label }: { serverId: string; name: string; canDeploy: boolean; label?: string }) {
  return (
    <Suspense
      fallback={
        <Button variant="outline" size="xs" disabled>
          {label ?? "Test restore"}
        </Button>
      }
    >
      <Loaded serverId={serverId} name={name} canDeploy={canDeploy} label={label} />
    </Suspense>
  );
}

async function Loaded({ serverId, name, canDeploy, label }: { serverId: string; name: string; canDeploy: boolean; label?: string }) {
  const result = await databaseBackups(serverId, name);
  const reason = result.error !== undefined ? result.error : result.data.length === 0 ? "No backup at the destination yet" : null;
  if (reason !== null) {
    return (
      <DisabledWithReason reason={reason}>
        <Button variant="outline" size="xs" disabled>
          {label ?? "Test restore"}
        </Button>
      </DisabledWithReason>
    );
  }
  return <TestRestoreDialog serverId={serverId} name={name} backups={result.data ?? []} canDeploy={canDeploy} label={label} />;
}
