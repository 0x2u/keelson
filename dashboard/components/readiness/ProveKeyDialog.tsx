"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { verifyKeyAction } from "@/app/readiness-actions";
import { GatedButton } from "@/components/GatedButton";
import { SecretValueInput } from "@/components/config/FormParts";
import { FieldShell } from "@/components/forms/fields";
import { Notice } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ICONS } from "@/lib/icons";
import { keyInput, keyProofView, readinessToast, type KeyProofView } from "@/lib/readiness-run-core";

/**
 * Proves that the age secret key opens a backup of a database: the agent decrypts only enough of the newest scheduled backup
 * to authenticate it. The key lives in this component's state until the request is sent and is cleared at that moment,
 * whatever the answer; it is never stored.
 */
export function ProveKeyDialog({ serverId, name, canDeploy, label = "Prove the key" }: { serverId: string; name: string; canDeploy: boolean; label?: string }) {
  const router = useRouter();
  const base = useId();
  const [open, setOpen] = useState(false);
  const [identity, setIdentity] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<KeyProofView | null>(null);
  const problem = keyInput(identity).problem;

  function onOpenChange(next: boolean) {
    if (pending) return;
    setOpen(next);
    setIdentity("");
    setError(null);
    setAnswer(null);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (problem !== undefined || pending) return;
    const sent = identity;
    setIdentity("");
    setPending(true);
    setError(null);
    setAnswer(null);
    const out = await verifyKeyAction(serverId, name, { identity: sent });
    setPending(false);
    if (out.error !== undefined) {
      setError(out.error);
      return;
    }
    const view = keyProofView(out.result);
    setAnswer(view);
    if (view.ok) {
      toast.success(readinessToast.keyProven(name));
      router.refresh();
    }
  }

  return (
    <>
      <GatedButton canDeploy={canDeploy} type="button" variant="outline" size="xs" aria-label={`${label} of ${name}`} onClick={() => setOpen(true)}>
        <ICONS.secret />
        {label}
      </GatedButton>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <form onSubmit={(e) => void onSubmit(e)} noValidate className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Prove the key of {name}</DialogTitle>
              <DialogDescription>
                The agent decrypts the start of the newest scheduled backup with your key, in memory, to show that this key still opens it. The key is never stored or logged.
              </DialogDescription>
            </DialogHeader>

            {error !== null && <Notice title="The key could not be checked">{error}</Notice>}
            {answer !== null && (
              <Notice tone={answer.ok ? "info" : "warning"} title={answer.ok ? "The key works" : "The key does not open it"}>
                {answer.text}
              </Notice>
            )}

            <FieldShell
              id={`${base}-identity`}
              label="Age secret key"
              required
              help="The key that matches a recipient of the backups (AGE-SECRET-KEY-1…). Paste it here; it is sent once and forgotten."
              error={identity !== "" ? problem : undefined}
            >
              <SecretValueInput
                id={`${base}-identity`}
                label="age secret key"
                value={identity}
                onChange={setIdentity}
                stored={false}
                invalid={identity !== "" && problem !== undefined}
                describedBy={`${base}-identity-help`}
              />
            </FieldShell>

            <DialogFooter>
              <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
                {answer?.ok ? "Close" : "Cancel"}
              </Button>
              <Button type="submit" loading={pending} disabled={problem !== undefined}>
                <ICONS.secret />
                Check the key
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
