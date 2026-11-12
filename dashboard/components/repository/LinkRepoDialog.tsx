"use client";

import { LoaderCircleIcon } from "lucide-react";
import { ICONS } from "@/lib/icons";
import { useActionState, useId, useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { linkRepoAction, repoBranchesAction, type GithubState } from "@/app/github-actions";
import { RepositoryStep, type PickableRepo } from "@/components/new-project/RepositoryStep";
import { Notice } from "@/components/states";
import { StepUpAction } from "@/components/unlock";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { FieldShell, SelectField, TextField } from "@/components/forms/fields";
import { pickBranch } from "@/lib/github-core";
import { toastCopy } from "@/lib/toast-core";

type Branches = { state: "idle" | "loading" | "ready" | "failed"; names: string[]; error?: string };

/**
 * Link an app to its repository, or change the link. The repositories the GitHub App (or the connected token) can reach are
 * a searchable list, and the branches of the chosen one a menu, starting at its default branch: nothing has to be typed. A
 * repository that is not listed can still be named, with its branch.
 */
export function LinkRepoDialog({
  serverId,
  app,
  repos,
  current,
  trigger,
}: {
  serverId: string;
  app: string;
  repos: PickableRepo[];
  current?: { repo: string; branch: string };
  trigger?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<GithubState, FormData>(async (prev, form) => {
    const next = await linkRepoAction(serverId, app, prev, form);
    if (next.ok) {
      toast.success(toastCopy.saved("repository link"));
      setOpen(false);
    }
    return next;
  }, {});
  const id = useId();
  const listed = current === undefined || repos.some((r) => r.fullName.toLowerCase() === current.repo.toLowerCase());
  const [manual, setManual] = useState(repos.length === 0 || !listed);
  const [repo, setRepo] = useState(current?.repo ?? "");
  const [branch, setBranch] = useState(current?.branch ?? "");
  const [branches, setBranches] = useState<Branches>({ state: "idle", names: [] });
  const [loading, startLoading] = useTransition();

  function load(name: string, defaultBranch?: string, keep?: string) {
    setBranches({ state: "loading", names: [] });
    startLoading(async () => {
      const found = await repoBranchesAction(name);
      if (found.error || found.branches.length === 0) {
        setBranches({ state: "failed", names: [], error: found.error ?? "This repository has no branch yet." });
        setBranch((b) => keep ?? (b || defaultBranch || "main"));
        return;
      }
      setBranches({ state: "ready", names: found.branches });
      setBranch(keep && found.branches.includes(keep) ? keep : pickBranch(found.branches, defaultBranch));
    });
  }

  function choose(r: PickableRepo) {
    setRepo(r.fullName);
    load(r.fullName, r.defaultBranch || undefined);
  }

  function onOpenChange(next: boolean) {
    if (pending) return;
    setOpen(next);
    // Opening on a link that exists: its branches are read now, and its branch stays chosen.
    if (next && current && listed && !manual && branches.state === "idle") load(current.repo, undefined, current.branch);
  }

  const canSubmit = repo.trim() !== "" && branch.trim() !== "" && !pending && !loading;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="outline">
            <ICONS.source />
            {current ? "Change repository" : "Link a repository"}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <form action={action} noValidate className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Repository of {app}</DialogTitle>
            <DialogDescription>The repository this app&apos;s images are built from, and the branch that gets deployed.</DialogDescription>
          </DialogHeader>
          <input type="hidden" name="repo" value={repo} />
          <input type="hidden" name="branch" value={branch} />

          {manual ? (
            <div className="space-y-2">
              <TextField
                id={`${id}-repo`}
                label="Repository"
                value={repo}
                onChange={setRepo}
                placeholder="owner/name or its GitHub address"
                autoComplete="off"
                spellCheck={false}
                mono
              />
              {repos.length > 0 && (
                <button type="button" className="w-fit text-xs underline underline-offset-4" onClick={() => setManual(false)}>
                  Choose from the list instead
                </button>
              )}
            </div>
          ) : (
            <FieldShell id={`${id}-repo`} label="Repository" group>
              <div className="max-h-72 overflow-y-auto">
                <RepositoryStep repos={repos} selected={repo} onSelect={choose} />
              </div>
              <button type="button" className="w-fit text-xs underline underline-offset-4" onClick={() => setManual(true)}>
                The repository is not in the list
              </button>
            </FieldShell>
          )}

          {!manual && branches.state === "ready" ? (
            <SelectField id={`${id}-branch`} label="Branch" value={branch} onChange={setBranch} options={branches.names.map((n) => ({ value: n, label: n }))} />
          ) : (
            <div className="flex items-end gap-2">
              <TextField
                id={`${id}-branch`}
                label="Branch"
                value={branch}
                onChange={setBranch}
                placeholder={repo === "" && !manual ? "Choose a repository first" : "main"}
                disabled={!manual && repo === ""}
                autoComplete="off"
                spellCheck={false}
                mono
                className="max-w-60"
                help={!manual && branches.state === "failed" ? `The branches could not be listed (${branches.error}): type the branch.` : undefined}
              />
              {(branches.state === "loading" || loading) && <LoaderCircleIcon aria-label="Reading the branches" className="mb-2 size-4 animate-spin text-muted-foreground" />}
            </div>
          )}

          {state.error && <Notice title="Could not link this repository" action={<StepUpAction error={state.error} />}>{state.error}</Notice>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" loading={pending} disabled={!canSubmit}>
              Link repository
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
