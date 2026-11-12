"use client";

import Link from "next/link";
import { CopyButton } from "@/components/copy-button";
import { CheckboxField } from "@/components/forms/fields";
import { Notice } from "@/components/states";
import { Button } from "@/components/ui/button";

/**
 * The private key that reads the new database's backups, shown once: the agent keeps only the public half, the
 * dashboard keeps nothing, and a lost key makes the encrypted backups unreadable. The way on (the deployment) opens
 * only after the operator says it is saved, because leaving the page loses the key for good.
 */
export function BackupKeyNotice({
  backupKey,
  recipient,
  saved,
  onSaved,
  deploymentHref,
}: {
  backupKey: string;
  recipient?: string;
  saved: boolean;
  onSaved: (saved: boolean) => void;
  /** Where to go on once the key is saved; absent while a step of the creation is still to be retried. */
  deploymentHref?: string;
}) {
  return (
    <Notice tone="warning" title="Save the database's backup key now">
      <p className="text-sm">
        The backups of the new database are encrypted. This key is needed to read them back, and it is shown <strong>only here, only now</strong>: Keelson and the agent keep no copy. Store it in your password manager.
      </p>
      <div className="mt-3 flex items-start gap-2 rounded-md border bg-muted/40 p-2">
        <code data-testid="backup-key" className="min-w-0 flex-1 break-all font-mono text-xs">
          {backupKey}
        </code>
        <CopyButton value={backupKey} label="Copy the backup key" />
      </div>
      {recipient && (
        <p className="mt-2 break-all text-xs text-muted-foreground">
          Public half (not secret): <span className="font-mono">{recipient}</span>
        </p>
      )}
      <div className="mt-3 grid gap-3">
        <CheckboxField id="backup-key-saved" label="I have saved this key somewhere safe" checked={saved} onChange={onSaved} />
        {deploymentHref &&
          (saved ? (
            <Button asChild className="w-fit">
              <Link href={deploymentHref}>Open the deployment</Link>
            </Button>
          ) : (
            <Button type="button" className="w-fit" disabled>
              Open the deployment
            </Button>
          ))}
      </div>
    </Notice>
  );
}
