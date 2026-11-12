"use client";

import { SaveIcon } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TextField } from "@/components/forms/fields";
import { DiffView } from "@/components/config/DiffView";
import { IssuesList } from "@/components/config/IssuesList";
import { Notice } from "@/components/states";
import { StepUpAction } from "@/components/unlock";
import type { ConfigIssue } from "@/lib/agent-types";

const COMMENT_MAX = 200;

/**
 * The last look before a change goes live: what changes (diff against the saved text), what the agent warns about,
 * and an optional comment for the version history. Saving stays off while the draft has errors or is still being checked.
 */
export function ReviewChangesDialog({
  open,
  onOpenChange,
  original,
  draft,
  issues,
  checking,
  checkFailure,
  pending,
  error,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  original: string;
  draft: string;
  /** Errors and warnings found for the draft. */
  issues: ConfigIssue[];
  /** The draft has changed since the last check. */
  checking: boolean;
  /** Why the check could not run, if it could not. */
  checkFailure?: string;
  pending: boolean;
  /** Why the last save failed; shown here, where the operator is looking. */
  error?: string | null;
  onSave: (comment: string) => void;
}) {
  const [comment, setComment] = useState("");
  const commentId = useId();
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.length - errors;
  const blocked = checking || errors > 0 || checkFailure !== undefined;

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <form
          noValidate
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!blocked && !pending) onSave(comment.trim());
          }}
        >
          <DialogHeader>
            <DialogTitle>Review changes</DialogTitle>
            <DialogDescription>
              Saving writes the file on the agent as a new version and applies it live, without a restart. Lines in green are added, lines in red are removed.
            </DialogDescription>
          </DialogHeader>

          <DiffView before={original} after={draft} />

          {checkFailure !== undefined && (
            <Notice title="The configuration could not be checked">
              {checkFailure} The check must pass before you can save.
            </Notice>
          )}
          {errors > 0 && (
            <Notice title={`Fix ${errors} ${errors === 1 ? "error" : "errors"} before saving`}>The agent refuses a configuration that has errors.</Notice>
          )}
          {issues.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium">
                {errors} {errors === 1 ? "error" : "errors"}, {warnings} {warnings === 1 ? "warning" : "warnings"}
              </p>
              <IssuesList issues={issues} />
              {warnings > 0 && errors === 0 && (
                <p className="text-xs text-muted-foreground">Warnings do not block saving; the agent may ask you to confirm some of them.</p>
              )}
            </div>
          )}

          <TextField
            id={commentId}
            label="Comment"
            optional
            help={`Shown in the version history. ${comment.length}/${COMMENT_MAX}`}
            value={comment}
            onChange={setComment}
            maxLength={COMMENT_MAX}
            placeholder="What changed and why"
          />

          {error && (
            <div className="flex flex-wrap items-center gap-2">
              <p role="alert" className="text-sm text-destructive-text">
                {error}
              </p>
              <StepUpAction error={error} />
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" loading={pending || checking} disabled={blocked || pending}>
              <SaveIcon />
              {pending ? "Saving…" : checking ? "Checking…" : "Save and apply"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
