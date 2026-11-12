"use client";

import { ArchiveRestoreIcon, TriangleAlertIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { showOutcomeToast } from "@/components/outcome-toast";
import { restoreDatabaseAction } from "@/app/actions";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SecretValueInput } from "@/components/config/FormParts";
import { CheckboxField, FieldShell, SelectField, TextField } from "@/components/forms/fields";
import { Notice } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import type { DatabaseBackup } from "@/lib/agent-types";
import { defaultRestoreTarget, OVERWRITE_HELP, overwriteConfirmation, restoreProblems, restoreRequest, type RestoreDraft } from "@/lib/database-restore";
import { formatBytes } from "@/lib/format";
import { restoreToast } from "@/lib/toast-core";

/**
 * Restores a backup into a new database, or over the live one after typing its name. The age secret key lives in this
 * component's state only while the dialog is open: it is cleared once the request is sent, whatever the answer, and
 * whenever the dialog closes.
 */
export function RestoreDialog({
  serverId,
  name,
  database,
  backups,
  initialBackup,
  size = "sm",
  variant = "outline",
}: {
  serverId: string;
  /** The configured name of the database. */
  name: string;
  /** The PostgreSQL database name: what an overwrite has to be confirmed with. */
  database: string;
  /** Newest first. */
  backups: DatabaseBackup[];
  /** The backup selected when the dialog opens; the newest by default. */
  initialBackup?: string;
  size?: "sm" | "xs";
  variant?: "outline" | "ghost";
}) {
  const router = useRouter();
  const base = useId();
  const fresh = (): RestoreDraft => ({
    backup: initialBackup ?? backups[0]?.key ?? "",
    identity: "",
    target: defaultRestoreTarget(database),
    overwrite: false,
    confirm: "",
  });
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<RestoreDraft>(fresh);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  // Overwriting asks for the database's name in the confirmation dialog, so the draft's own `confirm` is the name once it passes.
  const checked: RestoreDraft = { ...draft, confirm: draft.overwrite ? database : "" };
  const problems = restoreProblems(checked, database, backups);
  const ready = Object.keys(problems).length === 0;
  const set = <K extends keyof RestoreDraft>(key: K, value: RestoreDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const id = (field: string) => `${base}-${field}`;

  function onOpenChange(next: boolean) {
    if (pending) return;
    setOpen(next);
    setError(null);
    setDraft(fresh());
  }

  /** The form is complete (`confirm` is satisfied by the typed name of the confirmation dialog). */
  async function run() {
    if (!ready || pending) return;
    setPending(true);
    setError(null);
    const result = await restoreDatabaseAction(serverId, name, restoreRequest(checked, database));
    setPending(false);
    set("identity", "");
    if (result.error) {
      setError(result.error);
      return;
    }
    setConfirming(false);
    setOpen(false);
    setDraft(fresh());
    showOutcomeToast(restoreToast({ serverId, database: name, runId: result.runId }), (href) => router.push(href));
    router.refresh();
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || pending) return;
    // Over live data the name is asked for first, in its own dialog; into a new database it goes straight out.
    if (draft.overwrite) {
      setError(null);
      setConfirming(true);
      return;
    }
    void run();
  }

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" variant={variant} size={size} aria-label={initialBackup ? `Restore ${initialBackup}` : `Restore ${name}`}>
          <ArchiveRestoreIcon />
          Restore
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <form onSubmit={onSubmit} noValidate className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Restore {name}</DialogTitle>
            <DialogDescription>
              The agent downloads the backup, decrypts it with your key in memory, and restores it. The key is never stored or logged.
            </DialogDescription>
          </DialogHeader>

          {error && !confirming && <Notice title="The restore did not start">{error}</Notice>}

          <SelectField
            id={id("backup")}
            label="Backup"
            value={draft.backup}
            onChange={(v) => set("backup", v)}
            options={backups.map((b) => ({ value: b.key, label: `${b.created_at.slice(0, 16).replace("T", " ")} UTC · ${formatBytes(b.size_bytes)}` }))}
            placeholder="Choose a backup"
            error={problems.backup}
          />

          <FieldShell
            id={id("identity")}
            label="Age secret key"
            required
            help="The key that matches a recipient of the backup (AGE-SECRET-KEY-1…). Paste it here; it is sent once and forgotten."
            error={draft.identity !== "" ? problems.identity : undefined}
          >
            <SecretValueInput
              id={id("identity")}
              label="age secret key"
              value={draft.identity}
              onChange={(v) => set("identity", v)}
              stored={false}
              invalid={draft.identity !== "" && Boolean(problems.identity)}
              describedBy={`${id("identity")}-help`}
            />
          </FieldShell>

          <TextField
            id={id("target")}
            label="Restore into a new database"
            help="The agent creates it and fails if it already exists, so nothing existing is touched."
            error={!draft.overwrite ? problems.target : undefined}
            value={draft.overwrite ? database : draft.target}
            onChange={(v) => set("target", v)}
            readOnly={draft.overwrite}
            mono
          />

          <CheckboxField
            id={id("overwrite")}
            label={
              <>
                Overwrite the live database <span className="font-mono">{database}</span>
              </>
            }
            help={OVERWRITE_HELP}
            checked={draft.overwrite}
            onChange={(v) => setDraft((d) => ({ ...d, overwrite: v, confirm: "" }))}
          />

          {draft.overwrite && (
            <p className="flex items-start gap-2 rounded-lg border border-destructive/40 p-3 text-sm text-destructive">
              <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
              Everything in {database} that is not in the backup is lost, and applications connected to it will see the change. You are asked to type its name before anything is sent.
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant={draft.overwrite ? "destructive" : "default"} loading={pending} disabled={!ready}>
              <ArchiveRestoreIcon />
              {draft.overwrite ? "Overwrite and restore" : "Restore"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <ConfirmDialog
      open={confirming}
      onOpenChange={(next) => {
        if (next) setError(null);
        setConfirming(next);
      }}
      title={`Overwrite ${database}?`}
      description={overwriteConfirmation(database)}
      confirmLabel="Overwrite and restore"
      destructive
      typeToConfirm={database}
      pending={pending}
      error={error}
      onConfirm={() => void run()}
    />
    </>
  );
}
