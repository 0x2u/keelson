"use client";

import { SmartphoneIcon } from "lucide-react";
import { useActionState, useId, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  confirmTotpAction,
  disableTotpAction,
  pendingTotpSetupAction,
  startTotpSetupAction,
  type SecurityState,
  type TotpSetup,
} from "@/app/auth-actions";
import { PasswordConfirmDialog } from "@/components/security/PasswordConfirmDialog";
import { RecoveryCodesDialog } from "@/components/security/RecoveryCodesDialog";
import { CopyButton } from "@/components/copy-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TextField } from "@/components/forms/fields";
import { StepUpAction, toastActionError } from "@/components/unlock";
import { toastCopy } from "@/lib/toast-core";

export function TotpSection({ enabled }: { enabled: boolean }) {
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [starting, startTransition] = useTransition();

  function begin() {
    startTransition(async () => {
      try {
        const pending = await pendingTotpSetupAction();
        const next = pending ?? (await startTotpSetupAction());
        if ("error" in next) toastActionError("Could not start setup", next.error);
        else setSetup(next);
      } catch {
        toastActionError("Could not start setup", "Reload the page and try again.");
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Authenticator app</CardTitle>
        <CardDescription>
          Signing in then needs a 6-digit code from an app such as 1Password, Aegis or Google Authenticator, on top of your password. The code changes every
          30 seconds.
        </CardDescription>
        <CardAction>
          <Badge variant={enabled ? "success" : "muted"}>{enabled ? "Enabled" : "Not set up"}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {enabled ? (
          <PasswordConfirmDialog
            title="Disable the authenticator app"
            description="Signing in will no longer ask for a code from your authenticator app. If it is your only second factor, your password alone will protect this dashboard again. Your recovery codes stay on file."
            confirmLabel="Disable authenticator"
            successMessage={toastCopy.done("removed", "authenticator app")}
            destructive
            action={disableTotpAction}
            trigger={
              <Button variant="outline" className="text-destructive hover:text-destructive">
                Disable
              </Button>
            }
          />
        ) : (
          <Button onClick={begin} loading={starting}>
            <SmartphoneIcon />
            Set up authenticator
          </Button>
        )}
      </CardContent>
      <Dialog open={setup !== null} onOpenChange={(open) => !open && setSetup(null)}>
        <DialogContent className="sm:max-w-md">
          {setup && (
            <SetupForm
              setup={setup}
              onRestart={setSetup}
              onEnabled={(codes) => {
                setSetup(null);
                if (codes.length > 0) setRecoveryCodes(codes);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <RecoveryCodesDialog codes={recoveryCodes} onDone={() => setRecoveryCodes(null)} />
    </Card>
  );
}

function SetupForm({ setup, onRestart, onEnabled }: { setup: TotpSetup; onRestart: (setup: TotpSetup) => void; onEnabled: (codes: string[]) => void }) {
  const id = useId();
  const [code, setCode] = useState("");
  const [restarting, startTransition] = useTransition();
  const [restartError, setRestartError] = useState<string | null>(null);
  const [state, formAction, pending] = useActionState<SecurityState, FormData>(async (prev, form) => {
    const next = await confirmTotpAction(prev, form);
    if (next.ok) {
      toast.success(toastCopy.added("authenticator app"));
      onEnabled(next.recoveryCodes ?? []);
    }
    return next;
  }, {});
  const grouped = setup.secret.match(/.{1,4}/g)?.join(" ") ?? setup.secret;

  function restart() {
    setRestartError(null);
    startTransition(async () => {
      try {
        const next = await startTotpSetupAction();
        if ("error" in next) {
          setRestartError(next.error);
          return;
        }
        onRestart(next);
        setCode("");
      } catch {
        setRestartError("Could not create a new secret. Reload the page and try again.");
      }
    });
  }

  return (
    <form action={formAction} noValidate className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Set up authenticator app</DialogTitle>
        <DialogDescription>Scan the QR code with your authenticator app, then enter the 6-digit code it shows to confirm.</DialogDescription>
      </DialogHeader>
      <div className="flex justify-center">
        {/* A data URL: next/image adds nothing here. White background so it scans in dark mode. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={setup.qr} alt="QR code to add Keelson to your authenticator app" width={224} height={224} className="size-56 rounded-md bg-white" />
      </div>
      <div className="grid gap-1.5">
        <p className="text-sm text-muted-foreground">Cannot scan? Type this secret into your app instead.</p>
        <div className="flex items-center gap-1 rounded-md border bg-muted/40 px-3 py-2">
          <code className="min-w-0 flex-1 font-mono text-sm break-all select-all">{grouped}</code>
          <CopyButton value={setup.secret} label="Copy secret" />
        </div>
      </div>
      <div className="grid gap-2">
        <TextField
          id={`${id}-code`}
          name="code"
          label="6-digit code"
          error={state.error ?? restartError ?? undefined}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 ]*"
          maxLength={7}
          value={code}
          onChange={setCode}
          mono
          inputClassName="tracking-widest"
        />
        {(state.error ?? restartError) && <StepUpAction error={state.error ?? restartError} />}
      </div>
      <DialogFooter className="sm:justify-between">
        <Button type="button" variant="ghost" onClick={restart} loading={restarting} disabled={pending}>
          New secret
        </Button>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" loading={pending}>
            Verify and enable
          </Button>
        </div>
      </DialogFooter>
    </form>
  );
}
