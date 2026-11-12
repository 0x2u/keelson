"use client";

import { LoaderCircleIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { renameFactsAction, renameProjectAction, type RenameFactsResult, type RenameProjectResult } from "@/app/project-lifecycle-actions";
import { ERROR_TEXT, TextField } from "@/components/forms/fields";
import { Notice } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StepUpAction } from "@/components/unlock";
import { projectHref } from "@/lib/nav-core";
import { planRenameProject, renameCountsText, type RenamePlan } from "@/lib/project-lifecycle-core";

/** What renaming does, server by server: the counts, the one save each gets, and what stops it. */
export function RenamePlanSummary({ plan }: { plan: Extract<RenamePlan, { ok: true }> }) {
  return (
    <div className="grid gap-3 text-sm" data-testid="rename-plan">
      <p>
        Renames {plan.from} to {plan.to}: {renameCountsText(plan.totals)} on {plan.servers.length === 1 ? "1 server" : `${plan.servers.length} servers`}, one save per server.
      </p>
      <ul className="divide-y rounded-md border bg-card">
        {plan.servers.map((s) => (
          <li key={s.server.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2">
            <span className="font-medium">{s.server.name}</span>
            <span className="text-muted-foreground">{renameCountsText(s)}</span>
            <span className="w-full text-xs break-words text-muted-foreground">{s.changes.map((c) => c.name).join(", ")}</span>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground">Only the project label changes. Nothing is deployed and no container is touched.</p>
      {plan.blockers.length > 0 && (
        <Notice tone="warning" title="The rename cannot be made yet">
          <ul className="list-disc space-y-1 pl-4">
            {plan.blockers.map((b) => (
              <li key={`${b.serverId}-${b.reason}`}>
                {b.serverName}: {b.reason}
              </li>
            ))}
          </ul>
        </Notice>
      )}
    </div>
  );
}

/**
 * "Rename project": reads what carries the project's name on each server, shows what would be rewritten (and what stops it),
 * and on confirmation rewrites the label with one save per server. The project's address changes with its name, so the
 * page moves to the new one.
 */
export function RenameProjectDialog({ project, open, onOpenChange }: { project: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">{open && <RenameForm project={project} onClose={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  );
}

function RenameForm({ project, onClose }: { project: string; onClose: () => void }) {
  const router = useRouter();
  const [facts, setFacts] = useState<RenameFactsResult | null>(null);
  const [to, setTo] = useState("");
  const [pending, start] = useTransition();
  const [outcome, setOutcome] = useState<RenameProjectResult | null>(null);

  useEffect(() => {
    let current = true;
    const show = (result: RenameFactsResult) => {
      if (current) setFacts(result);
    };
    renameFactsAction(project)
      .then(show)
      .catch(() => show({ ok: false, message: "The request failed before the dashboard answered. Check the connection and try again." }));
    return () => {
      current = false;
    };
  }, [project]);

  const plan = useMemo(() => (facts?.ok ? planRenameProject({ from: project, to, facts: facts.facts, existingProjects: facts.existingProjects }) : null), [facts, project, to]);
  const ready = plan?.ok && plan.blockers.length === 0 ? plan : null;

  function rename() {
    if (!ready) return;
    start(async () => {
      let result: RenameProjectResult;
      try {
        result = await renameProjectAction(project, ready.to);
      } catch {
        result = { ok: false, message: "The request failed before the dashboard answered. Check the connection and try again." };
      }
      setOutcome(result);
      if (result.ok && result.servers.every((s) => s.ok)) {
        toast.success(`Renamed ${project} to ${ready.to}`);
        onClose();
        router.push(projectHref(ready.to));
      } else if (result.ok) {
        router.refresh();
      }
    });
  }

  const partial = outcome?.ok && outcome.servers.some((s) => !s.ok) ? outcome : null;
  return (
    <>
      <DialogHeader>
        <DialogTitle>Rename {project}</DialogTitle>
        <DialogDescription>A project is named by the label of its apps. Renaming rewrites that label on every server that has one.</DialogDescription>
      </DialogHeader>

      {facts === null && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircleIcon aria-hidden className="size-4 animate-spin" />
          Reading the servers…
        </p>
      )}
      {facts && !facts.ok && <Notice title={`${project} cannot be renamed`}>{facts.message}</Notice>}
      {facts?.ok && (
        <form
          className="grid gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            rename();
          }}
        >
          <TextField id="rename-project" label="New name" value={to} onChange={setTo} autoFocus disabled={pending || partial !== null} />
          {plan && !plan.ok && to.trim() !== "" && (
            <p role="alert" className={ERROR_TEXT}>
              {plan.reason}
            </p>
          )}
          {plan?.ok && <RenamePlanSummary plan={plan} />}
          {outcome && !outcome.ok && (
            <div className="flex flex-wrap items-center gap-2">
              <p role="alert" className="text-sm text-destructive">
                {outcome.message}
              </p>
              <StepUpAction error={outcome.message} />
            </div>
          )}
          {partial && (
            <Notice tone="warning" title="The rename was not saved everywhere">
              <ul className="list-disc space-y-1 pl-4" data-testid="rename-results">
                {partial.servers.map((s) => (
                  <li key={s.serverId}>
                    {s.serverName}: {s.ok ? `renamed, ${s.changed} changed` : s.message}
                  </li>
                ))}
              </ul>
              <p className="mt-2">
                The servers that failed still use the old name, so the project shows under both names. Open their apps and set the Project of each to {to.trim()} (Edit app).
              </p>
            </Notice>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              {partial ? "Close" : "Cancel"}
            </Button>
            {!partial && (
              <Button type="submit" loading={pending} disabled={!ready}>
                Rename project
              </Button>
            )}
          </DialogFooter>
        </form>
      )}
    </>
  );
}
