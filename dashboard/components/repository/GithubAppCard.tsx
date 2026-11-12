"use client";

import { ExternalLinkIcon } from "lucide-react";
import { useActionState, useEffect, useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { removeGithubAppAction, saveGithubAppAction, type GithubState } from "@/app/github-actions";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { RelativeTime } from "@/components/relative-time";
import { Notice } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TextAreaField, TextField } from "@/components/forms/fields";
import { StepUpAction } from "@/components/unlock";
import { toastCopy } from "@/lib/toast-core";

const NEW_APP = "https://github.com/settings/apps/new";

function CredentialsForm({ onDone }: { onDone?: () => void }) {
  const [state, action, pending] = useActionState<GithubState, FormData>(saveGithubAppAction, {});
  const id = useId();

  useEffect(() => {
    if (state.ok) {
      toast.success(toastCopy.saved("GitHub App"));
      onDone?.();
    }
  }, [state, onDone]);

  return (
    <form action={action} noValidate className="grid gap-4">
      <TextField id={`${id}-app`} name="appId" label="App ID" inputMode="numeric" autoComplete="off" spellCheck={false} placeholder="123456" mono />
      <TextAreaField
        id={`${id}-key`}
        name="privateKey"
        label="Private key"
        help="The .pem file GitHub downloads when you generate a private key. Stored encrypted on this dashboard and never shown again."
        autoComplete="off"
        spellCheck={false}
        rows={4}
        placeholder={"-----BEGIN RSA PRIVATE KEY-----\n…"}
        mono
        inputClassName="text-xs"
      />
      <TextField
        id={`${id}-slug`}
        name="slug"
        label="App name"
        optional
        help={<>The last part of the App&apos;s address, github.com/apps/&lt;name&gt;. Left empty, it is read from GitHub.</>}
        autoComplete="off"
        spellCheck={false}
        placeholder="my-deploy-app"
        mono
      />
      {state.error && <Notice title="That App was not accepted" action={<StepUpAction error={state.error} />}>{state.error}</Notice>}
      <div>
        <Button type="submit" loading={pending}>
          Save the App
        </Button>
      </div>
    </form>
  );
}

/**
 * The GitHub App that lets Keelson build and deploy from pushes and pull requests. Its private key is write-only: once
 * saved, the page can say only that one is set, and shows the App ID.
 */
export function GithubAppCard({ app, webhookSecretSet }: { app: { appId: string; slug: string | null; createdAt: number } | null; webhookSecretSet: boolean }) {
  const [replacing, setReplacing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [removing, startTransition] = useTransition();

  function remove() {
    startTransition(async () => {
      await removeGithubAppAction();
      setConfirming(false);
      toast.success(toastCopy.removed("GitHub App"));
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>GitHub App</CardTitle>
        <CardDescription>
          Install a GitHub App on a repository and Keelson deploys from its pushes and pull requests, without a CI workflow. The server&apos;s agent
          downloads the source with a short-lived token, builds it with Docker and deploys the result through the usual pipeline: health gate, release steps,
          rollback. Nothing builds until you add a <span className="font-mono">build:</span> block to the app on its agent and turn builds on, per app, on its
          Source page.
        </CardDescription>
        <CardAction>
          <Badge variant={app ? "success" : "muted"}>{app ? "Configured" : "Not set up"}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4">
        <Notice tone="warning" title="A build runs the repository's Dockerfile on the target server">
          Anyone who can push to a linked branch, or open a pull request from a branch of the same repository, can run code there. Pull requests from forks never
          build. Builds get no secrets: no build-time credentials, and the source token is limited to reading this repository. The private key is stored encrypted and
          only used from this dashboard&apos;s server.
        </Notice>

        {app && !replacing ? (
          <>
            <p className="text-sm">
              App ID <span className="font-mono font-medium">{app.appId}</span>
              {app.slug ? (
                <>
                  {" "}
                  (
                  <a href={`https://github.com/apps/${app.slug}`} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 underline-offset-4 hover:underline">
                    {app.slug} <ExternalLinkIcon className="size-3" />
                  </a>
                  )
                </>
              ) : null}
              , private key set, saved <RelativeTime at={app.createdAt} />. The key cannot be shown again.
            </p>
            {!webhookSecretSet && (
              <Notice tone="warning" title="The webhook secret is not set up">
                The App&apos;s webhook uses the same secret as the GitHub webhook below: generate it there, then paste it into the App&apos;s settings.
              </Notice>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setReplacing(true)}>
                Replace the credentials
              </Button>
              <Button variant="outline" onClick={() => setConfirming(true)}>
                Remove
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="rounded-lg border bg-muted/40 p-3 text-sm">
              <p className="font-medium">Create the App with the least access it needs</p>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>
                  Open{" "}
                  <a href={NEW_APP} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline">
                    GitHub&apos;s new App page <ExternalLinkIcon className="size-3" />
                  </a>
                  .
                </li>
                <li>
                  Webhook: active, with the payload URL and the <span className="font-medium text-foreground">same secret</span> as the GitHub webhook card below.
                </li>
                <li>
                  Repository permissions: <span className="font-medium text-foreground">Contents</span> read-only, <span className="font-medium text-foreground">Commit statuses</span>{" "}
                  read and write, <span className="font-medium text-foreground">Pull requests</span> read-only, <span className="font-medium text-foreground">Metadata</span>{" "}
                  read-only (always on). Nothing else.
                </li>
                <li>
                  Subscribe to events: <span className="font-medium text-foreground">Push</span> and <span className="font-medium text-foreground">Pull request</span>.
                </li>
                <li>Create it, generate a private key, and install the App on the repositories you deploy.</li>
                <li>Paste the App ID and the key here.</li>
              </ol>
            </div>
            <CredentialsForm onDone={() => setReplacing(false)} />
            {replacing && (
              <div>
                <Button variant="ghost" onClick={() => setReplacing(false)}>
                  Cancel
                </Button>
              </div>
            )}
          </>
        )}
        <p className="text-xs text-muted-foreground">
          Builds from this dashboard use github.com; GitHub Enterprise Server is not supported here yet. Build-time secrets (BuildKit secrets, private base-image
          credentials) are not supported yet either.
        </p>
      </CardContent>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Remove the GitHub App"
        description="The stored key is deleted and every app's builds are turned off. Delete the App, or its private key, on GitHub too if you no longer need it."
        confirmLabel="Remove GitHub App"
        destructive
        pending={removing}
        onConfirm={remove}
      />
    </Card>
  );
}
