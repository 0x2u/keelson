"use client";

import { ArchiveRestoreIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { restoreTestAction, startRestoreTestAction } from "@/app/readiness-actions";
import { GatedButton } from "@/components/GatedButton";
import { SecretValueInput } from "@/components/config/FormParts";
import { FieldShell, SelectField } from "@/components/forms/fields";
import { Notice } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { DatabaseBackup } from "@/lib/agent-types";
import { formatBytes } from "@/lib/format";
import { defaultTestBackup, keyInput, readinessToast, TEST_GIVE_UP_MS, TEST_POLL_MS, testProgress, VERDICT_RULE, type TestProgress } from "@/lib/readiness-run-core";

type Phase = { name: "idle" } | { name: "starting" } | { name: "running"; testId: string; since: number } | { name: "done"; progress: Exclude<TestProgress, { phase: "running" }> } | { name: "stalled" };

const backupLabel = (b: DatabaseBackup): string => `${b.created_at.slice(0, 16).replace("T", " ")} UTC · ${formatBytes(b.size_bytes)}${b.kind ? ` · taken before a ${b.kind === "pre-deploy" ? "deployment" : "restore"}` : ""}`;

/**
 * Restores a backup into a scratch database on the server, counts the rows of every table there and in the live database,
 * and drops the scratch database: it shows, table by table, what is in the backup and what is there now, with the verdict.
 * The age secret key lives in this component's state until the request is sent and is cleared at that moment; it is
 * never stored. No unlock is needed: nothing existing is touched.
 */
export function TestRestoreDialog({ serverId, name, backups, canDeploy, label = "Test restore" }: { serverId: string; name: string; backups: DatabaseBackup[]; canDeploy: boolean; label?: string }) {
  const router = useRouter();
  const base = useId();
  const [open, setOpen] = useState(false);
  const [backup, setBackup] = useState(() => defaultTestBackup(backups));
  const [identity, setIdentity] = useState("");
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const problem = keyInput(identity).problem;
  const busy = phase.name === "starting" || phase.name === "running";

  // Follow a running test until the agent says it is over, or until the dialog goes away.
  const testId = phase.name === "running" ? phase.testId : null;
  const since = phase.name === "running" ? phase.since : 0;
  useEffect(() => {
    if (testId === null) return;
    let live = true;
    const timer = setTimeout(async function poll() {
      if (!live) return;
      const out = await restoreTestAction(serverId, name, testId);
      if (!live) return;
      if (out.error !== undefined) {
        setPhase({ name: "idle" });
        setError(out.error);
        return;
      }
      const progress = testProgress(out.test);
      if (progress.phase !== "running") {
        setPhase({ name: "done", progress });
        if (progress.phase === "passed") toast.success(readinessToast.restorePassed(name));
        else toast.error(readinessToast.restoreFailed(name));
        router.refresh();
        return;
      }
      if (Date.now() - since > TEST_GIVE_UP_MS) {
        setPhase({ name: "stalled" });
        return;
      }
      setTimeout(poll, TEST_POLL_MS);
    }, TEST_POLL_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [testId, since, serverId, name, router]);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) return;
    setIdentity("");
    setError(null);
    setBackup(defaultTestBackup(backups));
    setPhase({ name: "idle" });
    // The test goes on in the agent whatever the dialog does: the list shows how it ended.
    if (started.current) router.refresh();
    started.current = false;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (problem !== undefined || backup === "" || busy) return;
    const sent = identity;
    setIdentity("");
    setError(null);
    setPhase({ name: "starting" });
    const out = await startRestoreTestAction(serverId, name, { identity: sent, backup });
    if (out.error !== undefined) {
      setPhase({ name: "idle" });
      setError(out.error);
      return;
    }
    started.current = true;
    setPhase({ name: "running", testId: out.testId, since: Date.now() });
  }

  const result = phase.name === "done" ? phase.progress : null;

  return (
    <>
      <GatedButton canDeploy={canDeploy} type="button" variant="outline" size="xs" aria-label={`${label} of ${name}`} onClick={() => setOpen(true)}>
        <ArchiveRestoreIcon />
        {label}
      </GatedButton>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
          <form onSubmit={(e) => void onSubmit(e)} noValidate className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Test a restore of {name}</DialogTitle>
              <DialogDescription>
                The agent restores the backup into a scratch database on the server, compares its row counts with the live database, and drops the scratch database. Nothing existing is touched, and your key is never stored or logged.
              </DialogDescription>
            </DialogHeader>

            {error !== null && <Notice title="The test did not run">{error}</Notice>}

            {result === null && (
              <>
                <SelectField
                  id={`${base}-backup`}
                  label="Backup"
                  value={backup}
                  onChange={setBackup}
                  options={backups.map((b) => ({ value: b.key, label: backupLabel(b) }))}
                  placeholder="Choose a backup"
                  help="The newest scheduled backup unless you choose another."
                />
                <FieldShell
                  id={`${base}-identity`}
                  label="Age secret key"
                  required
                  help="The key that matches a recipient of the backup (AGE-SECRET-KEY-1…). Paste it here; it is sent once and forgotten."
                  error={identity !== "" ? problem : undefined}
                >
                  <SecretValueInput
                    id={`${base}-identity`}
                    label="age secret key"
                    value={identity}
                    onChange={setIdentity}
                    stored={false}
                    invalid={identity !== "" && problem !== undefined}
                    describedBy={`${base}-identity-help`}
                  />
                </FieldShell>
              </>
            )}

            {busy && (
              <p role="status" className="text-sm text-muted-foreground" data-testid="restore-test-running">
                {phase.name === "starting" ? "Starting the test…" : "Restoring into a scratch database and counting rows…"}
              </p>
            )}
            {phase.name === "stalled" && <Notice tone="warning" title="The test is taking very long">The agent has not finished it yet. Close this and look at the database again later: it records how the test ended.</Notice>}

            {result !== null && (
              <div className="space-y-3" data-testid="restore-test-result">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <Badge variant={result.phase === "passed" ? "success" : "destructive"}>{result.phase === "passed" ? "Passed" : "Failed"}</Badge>
                  {result.headline}
                </p>
                {result.phase === "failed" && result.error !== undefined && <p className="text-sm break-words text-destructive-text">{result.error}</p>}
                {result.rows.length > 0 ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Table</TableHead>
                        <TableHead className="text-right">In the backup</TableHead>
                        <TableHead className="text-right">Now</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.rows.map((r) => (
                        <TableRow key={r.table}>
                          <TableCell className="font-mono text-xs">{r.table}</TableCell>
                          <TableCell className="text-right tabular">{r.backup}</TableCell>
                          <TableCell className="text-right tabular">{r.live}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <p className="text-sm text-muted-foreground">No table was counted.</p>
                )}
                <p className="text-xs text-muted-foreground">{VERDICT_RULE}</p>
              </div>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {result !== null || phase.name === "running" ? "Close" : "Cancel"}
              </Button>
              {result === null && (
                <Button type="submit" loading={busy} disabled={problem !== undefined || backup === ""}>
                  <ArchiveRestoreIcon />
                  Start the test
                </Button>
              )}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
