"use client";

import Link from "next/link";
import { useActionState, useEffect, useId, useRef, useState } from "react";
import { startGithubConnectAction, type ConnectState } from "@/app/github-connect-actions";
import { Notice } from "@/components/states";
import { PublicUrlHelp } from "@/components/repository/PublicUrlHelp";
import { Button } from "@/components/ui/button";
import { ERROR_TEXT, FieldShell, TextField } from "@/components/forms/fields";
import { StepUpAction } from "@/components/unlock";

/**
 * Starts "Connect GitHub": the name of the App (editable, GitHub's names are unique), whose account it belongs to, and
 * the button. The server action answers with the manifest and the one-time address to post it to; the form that does
 * so submits itself, so GitHub's own page opens in this tab. When an App already exists, creating another replaces it
 * and the form also asks for the explicit confirmation and the password.
 */
export function GithubConnectForm({ defaultName, replacing, disabledReason }: { defaultName: string; replacing: boolean; disabledReason: string | null }) {
  const [state, action, pending] = useActionState<ConnectState, FormData>(startGithubConnectAction, {});
  const [account, setAccount] = useState<"user" | "org">("user");
  const id = useId();
  const post = useRef<HTMLFormElement>(null);
  const posted = useRef<string | null>(null);

  useEffect(() => {
    if (state.start && posted.current !== state.start.action) {
      posted.current = state.start.action;
      post.current?.submit();
    }
  }, [state]);

  if (disabledReason) {
    return (
      <Notice tone="warning" title="GitHub cannot be connected yet">
        <PublicUrlHelp
          why={
            <>
              GitHub can only call this dashboard back over https, and this dashboard has no https address: <code className="font-mono text-xs">KEELSON_PUBLIC_URL</code> is not set to one.
            </>
          }
          without={
            <>
              This step is optional. To deploy without GitHub, create a project <Link href="/projects/new?door=image" className="font-medium text-foreground underline underline-offset-4">from an image</Link>.
            </>
          }
        />
      </Notice>
    );
  }

  return (
    <>
      <form action={action} noValidate className="grid gap-4">
        <TextField
          id={`${id}-name`}
          name="name"
          label="Name of the GitHub App"
          help="Names are unique across GitHub, so a short suffix is added. Change it if you like."
          defaultValue={defaultName}
          maxLength={34}
          autoComplete="off"
          spellCheck={false}
          className="max-w-sm"
        />
        <FieldShell id={`${id}-account`} label="Create it under" group>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="account" value="user" checked={account === "user"} onChange={() => setAccount("user")} className="size-4 accent-primary" />
            My GitHub account
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="account" value="org" checked={account === "org"} onChange={() => setAccount("org")} className="size-4 accent-primary" />
            An organization
          </label>
          {account === "org" && (
            <TextField id={`${id}-org`} name="org" label="Organization login" placeholder="my-company" autoComplete="off" spellCheck={false} mono className="max-w-xs pl-6" />
          )}
        </FieldShell>
        {replacing && (
          <div className="grid gap-3 rounded-lg border border-warning/30 bg-warning/5 p-3">
            <p className="text-sm font-medium">This replaces the current GitHub App and webhook secret</p>
            <p className="text-sm text-muted-foreground">
              The old App&apos;s webhooks stop working the moment the new one is saved: builds and deploys from its pushes stop until the new App is installed on the
              same repositories.
            </p>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="confirmReplace" className="mt-0.5 size-4 accent-primary" required />
              Replace the current App and its webhook secret
            </label>
            <TextField id={`${id}-password`} name="password" label="Current password" type="password" autoComplete="current-password" className="max-w-xs" />
          </div>
        )}
        {state.error && (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className={ERROR_TEXT}>
              {state.error}
            </p>
            <StepUpAction error={state.error} />
          </div>
        )}
        <div>
          <Button type="submit" loading={pending || state.start !== undefined}>
            {state.start ? "Opening GitHub…" : "Connect GitHub"}
          </Button>
        </div>
      </form>
      {state.start && (
        <form ref={post} method="post" action={state.start.action} className="hidden">
          <input type="hidden" name="manifest" value={state.start.manifest} />
        </form>
      )}
    </>
  );
}
