"use client";

import { ChevronDownIcon } from "lucide-react";
import Link from "next/link";
import { useActionState } from "react";
import { toast } from "sonner";
import { createServerAction, updateServerAction, type ServerFormState } from "@/app/actions";
import { TextAreaField, TextField, WriteOnlySecretField } from "@/components/forms/fields";
import { FOCUS_RING, FormCard } from "@/components/layout";
import { Notice } from "@/components/states";
import { StepUpAction } from "@/components/unlock";
import { Button } from "@/components/ui/button";
import { Card, CardFooter } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { toastCopy } from "@/lib/toast-core";

interface Initial {
  name: string;
  url: string;
  caCert: string;
  clientCert: string;
  canDeploy: boolean;
  hasClientKey: boolean;
  publicIp: string;
}

/** Add (no `serverId`) or edit one server. Secrets are write-only: never shown again. */
export function ServerForm({ serverId, initial }: { serverId?: string; initial?: Initial }) {
  const editing = serverId !== undefined;
  const bound = editing ? updateServerAction.bind(null, serverId) : createServerAction;

  async function submit(prev: ServerFormState, form: FormData): Promise<ServerFormState> {
    // On success the action redirects and Next hands back no state; any state means it failed.
    const result: ServerFormState | undefined = await bound(prev, form);
    if (result === undefined) {
      toast.success(toastCopy[editing ? "saved" : "added"](String(form.get("name") || "server")));
      return {};
    }
    // The form is still open: a failure is shown inside it (the notice and the highlighted fields), not as a toast.
    return result;
  }

  const [state, action, pending] = useActionState<ServerFormState, FormData>(submit, {});
  const v = state.values ?? initial;
  const e = state.errors ?? {};
  // Remount the inputs when a failed submit hands back values to show.
  const formKey = state.values ? JSON.stringify(state.values) : "initial";
  const tlsFilled = Boolean(v?.caCert || v?.clientCert || initial?.hasClientKey || e.caCert || e.clientCert || e.clientKey);

  return (
    <form action={action} key={formKey} className="max-w-2xl space-y-6" noValidate>
      {state.message && (
        <div className="grid gap-2">
          <Notice title="The agent did not accept these settings">
            {state.message}. Check that the agent is running, that the URL is reachable from this dashboard, and that the token
            matches the agent&apos;s token file.
          </Notice>
          <div>
            <StepUpAction error={state.message} />
          </div>
        </div>
      )}

      <FormCard title="Connection" description="How this dashboard reaches the agent. It checks that the agent answers before saving.">
        <TextField
          id="name"
          name="name"
          label="Name"
          help="Shown in the sidebar and in lists. Letters, digits and dashes read best."
          error={e.name}
          defaultValue={v?.name}
          maxLength={60}
          placeholder="vps-1"
        />

        <TextField
          id="url"
          name="url"
          type="url"
          inputMode="url"
          label="Agent URL"
          help="Where the agent listens, as seen from this dashboard."
          error={e.url}
          defaultValue={v?.url}
          placeholder="https://agent.example.com"
          mono
          inputClassName="text-xs md:text-xs"
        />

        <TextField
          id="publicIp"
          name="publicIp"
          label="Public address"
          optional
          help="The address domains of this server must point at. Leave it empty to use the agent URL's host, or what that name resolves to. Set it when the agent is reached over a private network, a tunnel or a name with several addresses."
          error={e.publicIp}
          defaultValue={v?.publicIp}
          placeholder="203.0.113.7"
          mono
          inputClassName="text-xs md:text-xs"
        />

        {editing ? (
          <WriteOnlySecretField
            id="token"
            label="API token"
            isSet
            error={e.token}
            help="The agent's token file value, used to read. It is never shown again. Replace it only after changing it on the agent."
          />
        ) : (
          <TextField
            id="token"
            name="token"
            type="password"
            label="API token"
            help="The contents of the agent's --token-file, at least 32 characters. It is used to read, and is never shown again."
            error={e.token}
          />
        )}
      </FormCard>

      <FormCard
        title="Deploy access"
        description="Without deploy access this server is read-only: you can see everything, but not deploy, roll back or run jobs."
      >
        <WriteOnlySecretField
          id="deploySecret"
          label="Deploy access secret"
          optional
          isSet={Boolean(editing && initial?.canDeploy)}
          error={e.deploySecret}
          help="At least 32 characters, different from the API token. Write-only: leave empty to keep the current value."
          extra={
            editing && initial?.canDeploy ? (
              <label className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
                <input type="checkbox" name="removeDeploySecret" className="size-4 accent-primary" />
                Remove the deploy access and make this server read-only
              </label>
            ) : null
          }
        />
      </FormCard>

      <Collapsible asChild defaultOpen={tlsFilled}>
        <Card className="gap-0 py-0">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className={`group flex w-full items-center justify-between gap-4 rounded-xl px-6 py-6 text-left ${FOCUS_RING}`}
            >
              <span className="space-y-1.5">
                <span className="block leading-none font-semibold">Mutual TLS</span>
                <span className="block text-sm text-muted-foreground">
                  Only for a private CA or an agent that requires client certificates.
                </span>
              </span>
              <ChevronDownIcon aria-hidden className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent forceMount className="data-[state=closed]:hidden">
            <div className="space-y-5 px-6 pb-6">
              <TextAreaField
                id="caCert"
                name="caCert"
                label="CA certificate"
                optional
                help="PEM. Only if the agent's certificate is not from a public CA."
                error={e.caCert}
                defaultValue={v?.caCert}
                mono
              />
              <TextAreaField
                id="clientCert"
                name="clientCert"
                label="Client certificate"
                optional
                help="PEM. Only if the agent requires mutual TLS."
                error={e.clientCert}
                defaultValue={v?.clientCert}
                mono
              />
              <WriteOnlySecretField
                id="clientKey"
                label="Client private key"
                optional
                multiline
                isSet={Boolean(editing && initial?.hasClientKey)}
                error={e.clientKey}
                help="PEM. Goes with the client certificate. Write-only: leave empty to keep the current key."
              />
            </div>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      <Card>
        <CardFooter className="justify-end gap-2">
          <Button asChild variant="ghost">
            <Link href={editing ? `/servers/${serverId}` : "/"}>Cancel</Link>
          </Button>
          <Button type="submit" loading={pending}>
            {pending ? "Checking the agent…" : editing ? "Save changes" : "Add server"}
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}
