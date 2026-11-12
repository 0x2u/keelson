"use client";

import { useActionState, useId, useState } from "react";
import { toast } from "sonner";
import { setBuildModesAction, type GithubState } from "@/app/github-actions";
import { Notice } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { toastCopy } from "@/lib/toast-core";

/** The two switches of an app's GitHub App builds. A mode can be switched off whatever the App's state, but on only with an App. */
export function BuildForm({ serverId, app, appConfigured, onPush, previews }: { serverId: string; app: string; appConfigured: boolean; onPush: boolean; previews: boolean }) {
  const [push, setPush] = useState(onPush);
  const [pulls, setPulls] = useState(previews);
  const [state, action, pending] = useActionState<GithubState, FormData>(async (prev, form) => {
    const next = await setBuildModesAction(serverId, app, prev, form);
    if (next.ok) toast.success(toastCopy.saved("build settings"));
    return next;
  }, {});
  const id = useId();

  return (
    <form action={action} className="grid gap-4">
      <div className="flex items-center gap-2">
        <input
          id={`${id}-push`}
          name="onPush"
          type="checkbox"
          checked={push}
          onChange={(e) => setPush(e.target.checked)}
          disabled={!appConfigured && !onPush}
          className="size-4 rounded border-input accent-primary"
        />
        <Label htmlFor={`${id}-push`}>Deploy each push to the linked branch</Label>
      </div>
      <div className="flex items-center gap-2">
        <input
          id={`${id}-previews`}
          name="previews"
          type="checkbox"
          checked={pulls}
          onChange={(e) => setPulls(e.target.checked)}
          disabled={!appConfigured && !previews}
          className="size-4 rounded border-input accent-primary"
        />
        <Label htmlFor={`${id}-previews`}>Deploy a preview of each pull request (same repository only)</Label>
      </div>
      {state.error && <Notice title="Could not save">{state.error}</Notice>}
      <div>
        <Button type="submit" loading={pending}>
          Save
        </Button>
      </div>
    </form>
  );
}
