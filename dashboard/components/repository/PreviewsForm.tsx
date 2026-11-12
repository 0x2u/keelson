"use client";

import { useActionState, useId, useState } from "react";
import { toast } from "sonner";
import { setPreviewsAction, type GithubState } from "@/app/github-actions";
import { Notice } from "@/components/states";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/forms/fields";
import { Label } from "@/components/ui/label";
import { toastCopy } from "@/lib/toast-core";

/** The on/off switch and the workflow name of an app's previews. The workflow names offered come from its recent runs. */
export function PreviewsForm({ serverId, app, workflow, suggestions, instances }: { serverId: string; app: string; workflow: string | null; suggestions: string[]; instances: number }) {
  const [enabled, setEnabled] = useState(workflow !== null);
  const [state, action, pending] = useActionState<GithubState, FormData>(async (prev, form) => {
    const next = await setPreviewsAction(serverId, app, prev, form);
    if (next.ok) {
      if (next.notice) toast.warning(next.notice);
      else toast.success(toastCopy.saved("preview settings"));
    }
    return next;
  }, {});
  const id = useId();

  return (
    <form action={action} noValidate className="grid gap-4">
      <div className="flex items-center gap-2">
        <input
          id={`${id}-enabled`}
          name="enabled"
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="size-4 rounded border-input accent-primary"
        />
        <Label htmlFor={`${id}-enabled`}>Create a preview for each pull request</Label>
      </div>
      <TextField
        id={`${id}-workflow`}
        name="workflow"
        label="Workflow name"
        list={`${id}-workflows`}
        defaultValue={workflow ?? ""}
        placeholder="Build and push"
        autoComplete="off"
        spellCheck={false}
        disabled={!enabled}
        help={
          <>
            The name of the workflow as GitHub shows it. It must run on <span className="font-mono">pull_request</span> and build{" "}
            <span className="font-medium text-foreground">and push</span> the image tagged with the commit SHA (<span className="font-mono">${"{{ github.sha }}"}</span>
            ): when it succeeds, the server pulls that tag into the pull request&apos;s preview.
          </>
        }
      />
      <datalist id={`${id}-workflows`}>
        {suggestions.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      {!enabled && instances > 0 && (
        <div className="flex items-center gap-2">
          <input id={`${id}-remove`} name="removePreviews" type="checkbox" defaultChecked className="size-4 rounded border-input accent-primary" />
          <Label htmlFor={`${id}-remove`}>
            Also remove {instances} running {instances === 1 ? "preview" : "previews"}
          </Label>
        </div>
      )}
      {!enabled && instances > 0 && (
        <p className="text-xs text-muted-foreground">Previews that are not removed keep running until they expire or are deleted by hand.</p>
      )}
      {state.error && <Notice title="Could not save">{state.error}</Notice>}
      {state.ok && state.notice && (
        <Notice tone="warning" title="Saved, with a problem">
          {state.notice}
        </Notice>
      )}
      <div>
        <Button type="submit" loading={pending}>
          Save
        </Button>
      </div>
    </form>
  );
}
