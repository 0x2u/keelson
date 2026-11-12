"use client";

import { browserSupportsWebAuthn, startRegistration, type PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { FingerprintIcon } from "lucide-react";
import { ICONS } from "@/lib/icons";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { deletePasskeyAction } from "@/app/auth-actions";
import { PasswordConfirmDialog } from "@/components/security/PasswordConfirmDialog";
import { PublicUrlHelp } from "@/components/repository/PublicUrlHelp";
import { RelativeTime } from "@/components/relative-time";
import { EmptyState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toastCopy } from "@/lib/toast-core";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TextField } from "@/components/forms/fields";
import { parseUserAgent } from "@/lib/user-agent";

export interface PasskeyView {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  transports: string[];
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message = typeof data === "object" && data !== null && "error" in data && typeof data.error === "string" ? data.error : null;
    throw new Error(message ?? `The server answered ${res.status}.`);
  }
  return data as T;
}

export function PasskeysSection({ available, passkeys }: { available: boolean; passkeys: PasskeyView[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Passkeys</CardTitle>
        <CardDescription>
          A passkey is a key stored on your device or security key and unlocked with its fingerprint, face or PIN. It can sign you in without a password, and it
          cannot be phished.
        </CardDescription>
        {available && (
          <CardAction>
            <AddPasskey />
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {!available ? (
          <PublicUrlHelp
            why={
              <>
                Passkeys are off: browsers only allow them on a secure address, and this dashboard has no https address (<code className="font-mono text-xs">KEELSON_PUBLIC_URL</code> is not set).
              </>
            }
            without="Your password and an authenticator app work without them."
          />
        ) : passkeys.length === 0 ? (
          <div className="rounded-md border border-dashed">
            <EmptyState icon={FingerprintIcon} title="No passkeys yet">
              Add one to sign in with your device instead of typing a password and a code.
            </EmptyState>
          </div>
        ) : (
          <ul className="divide-y rounded-md border">
            {passkeys.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="truncate text-sm font-medium">{p.name}</p>
                  <p className="text-xs text-muted-foreground">
                    Added <RelativeTime at={p.createdAt} /> · Last used{" "}
                    {p.lastUsedAt === null ? "never" : <RelativeTime at={p.lastUsedAt} />}
                  </p>
                </div>
                {p.transports.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {p.transports.map((t) => (
                      <Badge key={t} variant="muted">
                        {t}
                      </Badge>
                    ))}
                  </div>
                )}
                <PasswordConfirmDialog
                  title={`Remove passkey "${p.name}"`}
                  description="This passkey will no longer sign in to this dashboard. The key stays on your device until you delete it there. If it is your only second factor, your password alone will protect this dashboard again."
                  confirmLabel="Remove passkey"
                  successMessage={toastCopy.removed("passkey")}
                  destructive
                  action={deletePasskeyAction.bind(null, p.id)}
                  trigger={
                    <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" aria-label={`Remove passkey ${p.name}`}>
                      <ICONS.remove /> Remove
                    </Button>
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function AddPasskey() {
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("Passkey");
  const [supported, setSupported] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  function onOpenChange(next: boolean) {
    if (busy) return;
    setOpen(next);
    if (!next) return;
    setError(null);
    setNote(null);
    setSupported(browserSupportsWebAuthn());
    const device = parseUserAgent(navigator.userAgent);
    setName(device === "Unknown browser" ? "Passkey" : device);
  }

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const label = name.trim() || "Passkey";
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const optionsJSON = await postJson<PublicKeyCredentialCreationOptionsJSON>("/api/auth/passkey/register/options");
      const response = await startRegistration({ optionsJSON });
      await postJson<{ ok: true }>("/api/auth/passkey/register/verify", { response, name: label });
      setOpen(false);
      toast.success(toastCopy.added(`passkey ${label}`));
      router.refresh();
    } catch (e) {
      const kind = typeof e === "object" && e !== null && "name" in e && typeof e.name === "string" ? e.name : "";
      if (kind === "NotAllowedError") {
        setNote("Nothing was added: the request was cancelled or timed out. You can try again when you are ready.");
      } else if (kind === "InvalidStateError") {
        setError("This device already has a passkey for Keelson. Remove the old one first, or use another device or security key.");
      } else {
        setError(e instanceof Error ? e.message : "Could not add the passkey.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Button onClick={() => onOpenChange(true)}>
        <ICONS.add /> Add a passkey
      </Button>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={register} noValidate className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Add a passkey</DialogTitle>
            <DialogDescription>Give it a name you will recognise, then follow your browser&apos;s prompt.</DialogDescription>
          </DialogHeader>
          {!supported && (
            <p role="alert" className="text-sm text-destructive-text">
              This browser does not support passkeys. Try a current version of Chrome, Edge, Firefox or Safari.
            </p>
          )}
          <TextField
            id={`${id}-name`}
            label="Name"
            optional
            help={note ?? undefined}
            error={error ?? undefined}
            value={name}
            onChange={setName}
            maxLength={60}
            autoFocus
          />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" loading={busy} disabled={!supported}>
              {busy ? "Waiting for your device…" : "Add passkey"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
