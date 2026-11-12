import { Suspense } from "react";
import { DisabledWithReason } from "@/components/GatedButton";
import { RestoreDialog } from "@/components/databases/RestoreDialog";
import { Button } from "@/components/ui/button";
import { databaseBackups } from "@/lib/server-data";

/** Lists the backups at the database's destination, then offers the restore; the table paints without waiting for it. */
export function DatabaseRestore({ serverId, name, database }: { serverId: string; name: string; database: string }) {
  return (
    <Suspense
      fallback={
        <Button variant="outline" size="xs" disabled>
          Restore
        </Button>
      }
    >
      <Loaded serverId={serverId} name={name} database={database} />
    </Suspense>
  );
}

async function Loaded({ serverId, name, database }: { serverId: string; name: string; database: string }) {
  const result = await databaseBackups(serverId, name);
  if (result.error !== undefined) {
    return (
      <DisabledWithReason reason={result.error}>
        <Button variant="outline" size="xs" disabled>
          Restore: destination unreachable
        </Button>
      </DisabledWithReason>
    );
  }
  if (result.data.length === 0) {
    return (
      <DisabledWithReason reason="No backup at the destination yet">
        <Button variant="outline" size="xs" disabled>
          Restore
        </Button>
      </DisabledWithReason>
    );
  }
  return <RestoreDialog serverId={serverId} name={name} database={database} backups={result.data} size="xs" />;
}
