"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { generateWebhookSecretAction, removeWebhookSecretAction } from "@/app/github-actions";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CopyButton } from "@/components/copy-button";
import { RelativeTime } from "@/components/relative-time";
import { Notice } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StepUpAction } from "@/components/unlock";
import { toastCopy } from "@/lib/toast-core";

function Setting({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <li>
      {name}: <span className="font-medium text-foreground">{children}</span>
    </li>
  );
}

/** Where a value to paste into GitHub is shown: selectable, with a copy button. */
function Copyable({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1.5">
      <p className="text-sm font-medium">{label}</p>
      <div className="flex items-center gap-1 rounded-md border bg-muted/40 py-1 pr-1 pl-3">
        <code className="min-w-0 flex-1 break-all font-mono text-xs select-all">{value}</code>
        <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} />
      </div>
    </div>
  );
}

/**
 * The webhook that lets GitHub tell this dashboard a workflow finished. The secret is write-only: it is shown right
 * after it is generated, in this component's memory only, and afterwards the page can say only that one is set.
 */
export function GithubWebhookCard({ url, since }: { url: string | null; since: number | null }) {
  const [secret, setSecret] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<"regenerate" | "remove" | null>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function generate() {
    startTransition(async () => {
      setError(null);
      try {
        const out = await generateWebhookSecretAction();
        setSecret(out.secret ?? null);
        if (out.error) setError(out.error);
      } catch {
        setError("Could not generate the secret. Try again.");
      }
      setConfirming(null);
    });
  }

  function remove() {
    startTransition(async () => {
      await removeWebhookSecretAction();
      setSecret(null);
      setConfirming(null);
      toast.success(toastCopy.removed("webhook secret"));
    });
  }

  const configured = since !== null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>GitHub webhook</CardTitle>
        <CardDescription>
          Lets GitHub tell this dashboard that a workflow succeeded, so an app with automatic deploys on is deployed without anyone clicking, that a pull
          request was closed, so its preview is removed, and, through the GitHub App, that a branch was pushed or a pull request opened, so the app is built.
          Every delivery is checked against a secret that only this dashboard and GitHub know. The GitHub App&apos;s webhook uses the same address and secret.
        </CardDescription>
        <CardAction>
          <Badge variant={configured ? "success" : "muted"}>{configured ? "Secret set" : "Not set up"}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4">
        {secret !== null && (
          <>
            <Notice tone="warning" title="Copy the secret now">
              It is shown only this once and cannot be read back. If you lose it, generate a new one and paste it into GitHub again.
            </Notice>
            <Copyable label="Secret" value={secret} />
          </>
        )}
        {error && <Notice title="Could not set the secret" action={<StepUpAction error={error} />}>{error}</Notice>}

        {configured && secret === null && (
          <p className="text-sm">
            A secret is set, generated <RelativeTime at={since} />. It cannot be shown again.
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {configured ? (
            <>
              <Button variant="outline" onClick={() => setConfirming("regenerate")} disabled={pending}>
                Regenerate the secret
              </Button>
              <Button variant="outline" onClick={() => setConfirming("remove")} disabled={pending}>
                Remove
              </Button>
            </>
          ) : (
            <Button onClick={generate} loading={pending}>
              Generate a secret
            </Button>
          )}
        </div>

        <div className="grid gap-3 rounded-lg border bg-muted/40 p-3 text-sm">
          <p className="font-medium">In the repository&apos;s settings on GitHub, under Webhooks, add a webhook with:</p>
          {url ? (
            <Copyable label="Payload URL" value={url} />
          ) : (
            <Notice tone="warning">
              This dashboard does not know its own address. Set KEELSON_PUBLIC_URL, or open this page through the address GitHub should call, then add{" "}
              <span className="font-mono">/api/webhooks/github</span> to it.
            </Notice>
          )}
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            <Setting name="Content type">application/json</Setting>
            <Setting name="Secret">the secret generated on this card</Setting>
            <Setting name="Events">
              Let me select individual events, then only &ldquo;Workflow runs&rdquo; and &ldquo;Pull requests&rdquo;. For the GitHub App (its own settings, not a
              repository webhook), &ldquo;Push&rdquo; and &ldquo;Pull request&rdquo;
            </Setting>
            <Setting name="Active">yes</Setting>
          </ul>
          <p className="text-xs text-muted-foreground">
            GitHub has to reach this address from the internet. If the dashboard is limited with KEELSON_ALLOWED_IPS, allow GitHub&apos;s webhook ranges too (listed at
            api.github.com/meta, under &ldquo;hooks&rdquo;).
          </p>
        </div>
      </CardContent>

      <ConfirmDialog
        open={confirming === "remove"}
        onOpenChange={(open) => setConfirming(open ? "remove" : null)}
        title="Remove the webhook secret"
        description="The dashboard stops accepting deliveries from GitHub: automatic deploys do nothing until you set a secret up again."
        confirmLabel="Remove secret"
        destructive
        pending={pending}
        onConfirm={remove}
      />
      <ConfirmDialog
        open={confirming === "regenerate"}
        onOpenChange={(open) => setConfirming(open ? "regenerate" : null)}
        title="Regenerate the webhook secret"
        description="The current secret stops working at once. Deliveries from GitHub are refused until you paste the new secret into the webhook's settings there."
        confirmLabel="Regenerate"
        pending={pending}
        onConfirm={generate}
      />
    </Card>
  );
}
