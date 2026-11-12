"use client";

import { ExternalLinkIcon } from "lucide-react";
import { useActionState, useEffect, useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { connectGithubAction, disconnectGithubAction, type GithubState } from "@/app/github-actions";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Notice } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TextField } from "@/components/forms/fields";
import { StepUpAction } from "@/components/unlock";
import { toastCopy } from "@/lib/toast-core";

const NEW_TOKEN = "https://github.com/settings/personal-access-tokens/new";

function TokenForm({ onDone }: { onDone?: () => void }) {
  const [state, action, pending] = useActionState<GithubState, FormData>(connectGithubAction, {});
  const id = useId();

  useEffect(() => {
    if (state.ok) {
      toast.success(toastCopy.done("added", "GitHub connection"));
      onDone?.();
    }
  }, [state, onDone]);

  return (
    <form action={action} noValidate className="grid gap-4">
      <TextField
        id={id}
        name="token"
        label="Fine-grained access token"
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder="github_pat_…"
        mono
        help="Stored encrypted on this dashboard. It is used to read from GitHub, and to post the status of a preview when it may."
      />
      {state.error && <Notice title="That token was not accepted" action={<StepUpAction error={state.error} />}>{state.error}</Notice>}
      <div>
        <Button type="submit" loading={pending}>
          Connect GitHub
        </Button>
      </div>
    </form>
  );
}

export function GithubConnectionCard({ account }: { account: string | null }) {
  const [replacing, setReplacing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [disconnecting, startTransition] = useTransition();

  function disconnect() {
    startTransition(async () => {
      await disconnectGithubAction();
      setConfirming(false);
      toast.success(toastCopy.removed("GitHub connection"));
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>GitHub</CardTitle>
        <CardDescription>
          Shows each app&apos;s commits and CI runs beside its deployments, and lets you deploy a commit that passed. Keelson reads from GitHub and writes one
          thing only: commit statuses (&ldquo;keelson/preview&rdquo; for a pull request&apos;s preview, &ldquo;keelson/build&rdquo; for the GitHub App&apos;s builds), if
          the token or the App is allowed to. It never comments or changes anything else there. With the GitHub App set up this token is optional: it only feeds the
          commits and CI runs on an app&apos;s Source page.
        </CardDescription>
        <CardAction>
          <Badge variant={account ? "success" : "muted"}>{account ? "Connected" : "Not connected"}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4">
        {account && !replacing ? (
          <>
            <p className="text-sm">
              Connected as <span className="font-medium">{account}</span>.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setReplacing(true)}>
                Replace the token
              </Button>
              <Button variant="outline" onClick={() => setConfirming(true)}>
                Disconnect
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="rounded-lg border bg-muted/40 p-3 text-sm">
              <p className="font-medium">Create a token with the least access it needs</p>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>
                  Open{" "}
                  <a href={NEW_TOKEN} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline">
                    GitHub&apos;s new fine-grained token page <ExternalLinkIcon className="size-3" />
                  </a>
                  .
                </li>
                <li>Repository access: only the repositories you deploy.</li>
                <li>
                  Permissions: <span className="font-medium text-foreground">Contents</span>, <span className="font-medium text-foreground">Actions</span> and{" "}
                  <span className="font-medium text-foreground">Metadata</span>, all set to read-only.
                </li>
                <li>
                  Optional, for previews: <span className="font-medium text-foreground">Commit statuses</span> set to read and write, so a pull request shows whether its
                  preview is up. Without it previews still work and the status is simply not posted.
                </li>
                <li>Pick an expiry and generate it, then paste it here.</li>
              </ol>
            </div>
            <TokenForm onDone={() => setReplacing(false)} />
            {replacing && (
              <div>
                <Button variant="ghost" onClick={() => setReplacing(false)}>
                  Cancel
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Disconnect GitHub"
        description="The stored token is deleted from this dashboard. Apps keep their repository link, but their commits and CI runs are hidden until you connect again. Revoke the token on GitHub too if you no longer need it."
        confirmLabel="Disconnect GitHub"
        destructive
        pending={disconnecting}
        onConfirm={disconnect}
      />
    </Card>
  );
}
