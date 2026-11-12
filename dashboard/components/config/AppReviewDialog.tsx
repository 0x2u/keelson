"use client";

import { SaveIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { IMPACT_LABEL, type ChangeRow, type FieldChange, type SaveImpact } from "@/lib/app-config-core";
import { cn } from "@/lib/utils";

const IMPACT_VARIANT: Record<SaveImpact, "warning" | "info" | "success"> = { redeploy: "warning", "next-deploy": "info", live: "success" };

const KIND: Record<ChangeRow["kind"], { symbol: string; label: string; className: string }> = {
  added: { symbol: "+", label: "Added", className: "text-success" },
  removed: { symbol: "\u2212", label: "Removed", className: "text-destructive" },
  changed: { symbol: "~", label: "Changed", className: "text-warning-text" },
};

function Row({ row, secret }: { row: ChangeRow; secret: boolean }) {
  const { symbol, label, className } = KIND[row.kind];
  return (
    <li className="flex items-baseline gap-2 font-mono text-xs leading-5">
      <span aria-hidden className={cn("w-3 shrink-0 text-center", className)}>
        {symbol}
      </span>
      <span className="sr-only">{label}: </span>
      <span className="min-w-0 break-all">
        {row.name !== undefined && <span className="font-medium">{row.name}</span>}
        {secret ? (
          <span className="text-muted-foreground"> {row.kind === "changed" ? "value changed" : row.kind === "added" ? "added" : "removed"}</span>
        ) : (
          <>
            {row.name !== undefined && ": "}
            {row.before !== undefined && <span className={cn(row.kind === "changed" && "text-destructive line-through decoration-1")}>{row.before === "" ? "(empty)" : row.before}</span>}
            {row.kind === "changed" && <span className="text-muted-foreground"> → </span>}
            {row.after !== undefined && <span className={cn(row.kind === "changed" && "text-success")}>{row.after === "" ? "(empty)" : row.after}</span>}
          </>
        )}
      </span>
    </li>
  );
}

/** The changes of an app, field by field. Environment values never appear: only which variable changed. */
export function AppChangesList({ changes, creating = false }: { changes: FieldChange[]; creating?: boolean }) {
  if (changes.length === 0) return <p className="text-sm text-muted-foreground">Nothing changed: saving would write the same configuration.</p>;
  return (
    <ul className="divide-y rounded-md border bg-card">
      {changes.map((change) => (
        <li key={change.field} className="space-y-1.5 px-3 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium capitalize">{change.label}</span>
            {!creating && <Badge variant={IMPACT_VARIANT[change.impact]}>{IMPACT_LABEL[change.impact]}</Badge>}
          </div>
          <ul className="space-y-0.5">
            {change.rows.map((row, i) => (
              <Row key={i} row={row} secret={change.field === "env"} />
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/**
 * The step between "Save" and the agent: what exactly is about to change, with Back to keep editing and Confirm to
 * save. Nothing has been sent while it is open.
 */
export function AppReviewDialog({
  open,
  onOpenChange,
  changes,
  creating,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  changes: FieldChange[];
  creating: boolean;
  pending: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{creating ? "Review the new app" : "Review changes"}</DialogTitle>
          <DialogDescription>
            {creating
              ? "Nothing is written until you confirm. The app is added to the configuration; deploy it to start it."
              : "Nothing is written until you confirm. Environment values are never shown: only which variable changed."}
          </DialogDescription>
        </DialogHeader>
        <AppReviewBody changes={changes} creating={creating} pending={pending} onBack={() => onOpenChange(false)} onConfirm={onConfirm} />
      </DialogContent>
    </Dialog>
  );
}

/** The review without its dialog frame: the changes, what they mean for the running version, Back and Confirm. */
export function AppReviewBody({
  changes,
  creating,
  pending,
  onBack,
  onConfirm,
}: {
  changes: FieldChange[];
  creating: boolean;
  pending: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const needsRedeploy = changes.some((c) => c.impact === "redeploy");
  return (
    <>
      <AppChangesList changes={changes} creating={creating} />
      {!creating && needsRedeploy && (
        <p className="text-sm text-muted-foreground">Some of these changes only take effect in a new container: the running version keeps its settings until you deploy.</p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onBack} disabled={pending}>
          Back
        </Button>
        <Button type="button" onClick={onConfirm} loading={pending}>
          <SaveIcon />
          {pending ? "Saving…" : "Confirm and save"}
        </Button>
      </DialogFooter>
    </>
  );
}
