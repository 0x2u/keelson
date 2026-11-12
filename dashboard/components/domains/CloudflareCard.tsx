"use client";

import { ExternalLinkIcon } from "lucide-react";
import { useActionState, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { connectCloudflareAction, disconnectCloudflareAction, type CloudflareState } from "@/app/domain-actions";
import { PasswordConfirmDialog } from "@/components/security/PasswordConfirmDialog";
import { Notice } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TextField } from "@/components/forms/fields";
import { StepUpAction } from "@/components/unlock";
import { toastCopy } from "@/lib/toast-core";

const TOKENS_PAGE = "https://dash.cloudflare.com/profile/api-tokens";

export interface CloudflareView {
  connectedAt: number;
  /** The token's id at Cloudflare (not its value). */
  tokenId: string | null;
  expiresOn: string | null;
}

export interface CloudflareZones {
  names: string[];
  truncated: boolean;
}

function TokenForm({ onDone, replacing }: { onDone?: () => void; replacing: boolean }) {
  const [state, action, pending] = useActionState<CloudflareState, FormData>(connectCloudflareAction, {});
  const id = useId();

  useEffect(() => {
    if (state.ok) {
      toast.success(toastCopy.added("Cloudflare connection"));
      onDone?.();
    }
  }, [state, onDone]);

  return (
    <form action={action} noValidate className="grid gap-4">
      <TextField
        id={`${id}-token`}
        name="token"
        label="API token"
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder="Paste the token"
        mono
        className="max-w-xl"
        help="Checked with Cloudflare before it is saved, then stored encrypted on this dashboard. It is never shown again and is only used from the server."
      />
      <TextField
        id={`${id}-password`}
        name="password"
        label="Current password"
        type="password"
        autoComplete="current-password"
        className="max-w-xs"
        help={`${replacing ? "Replacing" : "Storing"} a token that can change your DNS asks for your password again.`}
      />
      {state.error && (
        <Notice title="Cloudflare was not connected" action={<StepUpAction error={state.error} />}>{state.error}</Notice>
      )}
      <div>
        <Button type="submit" loading={pending}>
          {replacing ? "Replace the token" : "Connect Cloudflare"}
        </Button>
      </div>
    </form>
  );
}

/** The Cloudflare token the domain features use: its status, the zones it sees, and how to connect, replace or remove it. */
export function CloudflareCard({ connection, zones, error }: { connection: CloudflareView | null; zones: CloudflareZones | null; error: string | null }) {
  const [replacing, setReplacing] = useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cloudflare</CardTitle>
        <CardDescription>
          Creates the DNS record of an app&apos;s domain when you add the app, and checks that the domain works. Keelson creates the A or AAAA record of the host you give
          it and nothing else: a record that already exists with another value is only replaced after you confirm it by name, and no record is ever deleted on its own.
        </CardDescription>
        <CardAction>
          <Badge variant={connection ? "success" : "muted"}>{connection ? "Connected" : "Not connected"}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4">
        {connection && !replacing ? (
          <>
            <p className="text-sm">
              The token is valid{connection.expiresOn ? <> until <span className="font-medium">{connection.expiresOn.slice(0, 10)}</span></> : ""}.{" "}
              {zones ? (
                <>
                  It sees {zones.names.length}
                  {zones.truncated ? "+" : ""} zone{zones.names.length === 1 ? "" : "s"}.
                </>
              ) : null}
            </p>
            {error && <Notice tone="warning" title="The zones could not be listed">{error}</Notice>}
            {zones && zones.names.length > 0 && (
              <ul className="flex flex-wrap gap-2" aria-label="Zones the token sees">
                {zones.names.map((name) => (
                  <li key={name}>
                    <Badge variant="muted" className="font-mono">
                      {name}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setReplacing(true)}>
                Replace the token
              </Button>
              <PasswordConfirmDialog
                trigger={<Button variant="outline">Disconnect</Button>}
                title="Disconnect Cloudflare"
                description="The stored token is deleted from this dashboard. DNS records it created stay where they are, but new domains are no longer created or checked at Cloudflare. Revoke the token at Cloudflare too if you no longer need it."
                confirmLabel="Disconnect"
                destructive
                action={disconnectCloudflareAction}
                successMessage={toastCopy.removed("Cloudflare connection")}
              />
            </div>
          </>
        ) : (
          <>
            <div className="rounded-lg border bg-muted/40 p-3 text-sm">
              <p className="font-medium">Create a token with the least access it needs</p>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>
                  Open{" "}
                  <a href={TOKENS_PAGE} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline">
                    Cloudflare&apos;s API tokens page <ExternalLinkIcon aria-hidden className="size-3" />
                  </a>
                  , then <span className="font-medium text-foreground">Create Token</span> and <span className="font-medium text-foreground">Create Custom Token</span>.
                </li>
                <li>
                  Permissions: <span className="font-medium text-foreground">Zone → Zone → Read</span> and <span className="font-medium text-foreground">Zone → DNS → Edit</span>.
                </li>
                <li>
                  Zone resources: <span className="font-medium text-foreground">Include</span> only the zones you put apps on (or all zones of the account).
                </li>
                <li>Continue to the summary, create the token and paste it below. Cloudflare shows it once.</li>
              </ol>
            </div>
            <TokenForm replacing={connection !== null} onDone={() => setReplacing(false)} />
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
    </Card>
  );
}
