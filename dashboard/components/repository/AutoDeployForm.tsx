"use client";

import { useActionState, useId, useState } from "react";
import { toast } from "sonner";
import { setAutoDeployAction, type GithubState } from "@/app/github-actions";
import { Notice } from "@/components/states";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/forms/fields";
import { Label } from "@/components/ui/label";
import { toastCopy } from "@/lib/toast-core";

/** The on/off switch and the workflow name of an app's automatic deploys. The workflow names offered come from its recent runs. */
export function AutoDeployForm({ serverId, app, workflow, suggestions }: { serverId: string; app: string; workflow: string | null; suggestions: string[] }) {
  const [enabled, setEnabled] = useState(workflow !== null);
  const [state, action, pending] = useActionState<GithubState, FormData>(async (prev, form) => {
    const next = await setAutoDeployAction(serverId, app, prev, form);
    if (next.ok) toast.success(toastCopy.saved("automatic deploy settings"));
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
        <Label htmlFor={`${id}-enabled`}>Deploy automatically when the workflow succeeds</Label>
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
            The name of the workflow as GitHub shows it. It must build <span className="font-medium text-foreground">and push</span> the image tagged with the commit
            SHA (<span className="font-mono">${"{{ github.sha }}"}</span>): when it succeeds on the linked branch, the server pulls that tag.
          </>
        }
      />
      <datalist id={`${id}-workflows`}>
        {suggestions.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      {state.error && <Notice title="Could not save">{state.error}</Notice>}
      <div>
        <Button type="submit" loading={pending}>
          Save
        </Button>
      </div>
    </form>
  );
}
