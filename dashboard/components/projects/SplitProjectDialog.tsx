"use client";

import { FilePlus2Icon, LoaderCircleIcon } from "lucide-react";
import { useState } from "react";
import type { SplitPlan } from "@/lib/agent-types";
import { GatedButton } from "@/components/GatedButton";
import { planSplitAction, splitProjectAction, type SplitPlanResult } from "@/app/project-config-actions";
import { IssuesList } from "@/components/config/IssuesList";
import { saveFailure, useConfigSave } from "@/components/config/useConfigSave";
import { Notice } from "@/components/states";
import { Button } from "@/components/ui/button";
import { StepUpAction } from "@/components/unlock";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { keptLabel, splitNotice, splitPlanView } from "@/lib/project-config-core";

/** The plan as lists: what moves, by kind, and what stays in the apps file with the reason. */
export function SplitPlanSummary({ plan }: { plan: SplitPlan }) {
  const view = splitPlanView(plan);
  return (
    <div className="space-y-4 text-sm" data-testid="split-plan">
      <p>{view.summary}</p>
      {view.moves.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Moves to {view.file}</h3>
          <ul className="divide-y rounded-md border bg-card">
            {view.moves.map((m) => (
              <li key={m.label} className="flex flex-wrap gap-x-3 gap-y-1 px-3 py-2">
                <span className="w-32 shrink-0 text-muted-foreground">{m.label}</span>
                <span className="min-w-0 flex-1 font-mono text-xs break-all">{m.names.join(", ")}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {view.kept.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Stays in the shared configuration</h3>
          <ul className="divide-y rounded-md border bg-card">
            {view.kept.map((k) => (
              <li key={`${k.kind}/${k.name}`} className="px-3 py-2">
                <span className="font-mono text-xs">{keptLabel(k)}</span>
                <span className="ml-2 text-muted-foreground">{k.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * "Give <project> its own file": asks the agent what it would move (nothing is written), shows that plan and what stays
 * and why, and only then writes it. The apply is based on the hash the plan was made on, so what is written is what was
 * shown; if the configuration changed in between, the agent refuses and nothing moves.
 */
export function SplitProjectDialog({ serverId, serverName, project, canEdit }: { serverId: string; serverName: string; project: string; canEdit: boolean }) {
  const save = useConfigSave();
  const [open, setOpen] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [plan, setPlan] = useState<SplitPlanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function show() {
    setOpen(true);
    setPlan(null);
    setError(null);
    setPlanning(true);
    try {
      setPlan(await planSplitAction(serverId, project));
    } catch {
      setPlan({ ok: false, message: "The request failed before the agent answered. Check the connection and try again." });
    } finally {
      setPlanning(false);
    }
  }

  async function apply(result: Extract<SplitPlanResult, { ok: true }>) {
    setError(null);
    const { saved, result: outcome } = await save.run(
      `configuration of ${project}`,
      ({ force }) => splitProjectAction(serverId, project, { base_hash: result.hash, force }),
      splitNotice(project, serverId, result.plan.file),
      { inlineErrors: true },
    );
    if (saved) setOpen(false);
    else setError(saveFailure(outcome));
  }

  if (!canEdit) {
    return (
      <GatedButton canDeploy={false} type="button" variant="outline">
        <FilePlus2Icon />
        Give {project} its own file
      </GatedButton>
    );
  }

  const ready = plan?.ok ? plan : null;
  return (
    <>
      <Button type="button" variant="outline" onClick={show} disabled={save.pending}>
        <FilePlus2Icon />
        Give {project} its own file
      </Button>
      <Dialog open={open} onOpenChange={(next) => !save.pending && setOpen(next)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Give {project} its own file on {serverName}</DialogTitle>
            <DialogDescription>
              The apps, jobs and databases of {project} move out of the shared configuration into their own file. The agent checks that what runs does not
              change. Nothing has been written yet.
            </DialogDescription>
          </DialogHeader>

          {planning && (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircleIcon aria-hidden className="size-4 animate-spin" />
              Asking the agent what would move…
            </p>
          )}
          {plan && !plan.ok && <Notice title={`${project} cannot get its own file`}>{plan.message}</Notice>}
          {ready && (
            <>
              <SplitPlanSummary plan={ready.plan} />
              {ready.issues.length > 0 && <IssuesList issues={ready.issues} />}
            </>
          )}

          {error && (
            <div className="flex flex-wrap items-center gap-2">
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
              <StepUpAction error={error} />
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={save.pending}>
              Cancel
            </Button>
            <Button type="button" loading={save.pending} disabled={!ready || splitPlanView(ready.plan).moved === 0} onClick={() => ready && apply(ready)}>
              <FilePlus2Icon />
              {save.pending ? "Moving…" : `Create ${ready?.plan.file ?? "the file"}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {save.dialogs}
    </>
  );
}
