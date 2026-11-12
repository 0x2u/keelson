"use client";

import { LockIcon, LockOpenIcon } from "lucide-react";
import { useActionState, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { unlockAction, unlockStatusAction } from "@/app/step-up-actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UNLOCK_EVENT } from "@/lib/gate-core";
import type { UnlockResult } from "@/lib/step-up";

/**
 * The padlock in the top bar. Sensitive changes (what an app runs, secrets, servers, a restore over live data) need the
 * password and the authenticator code again, once, and then stay possible for ten minutes. A session that was merely
 * stolen has neither.
 */
export function UnlockButton({ authenticator }: { authenticator: boolean }) {
  const [until, setUntil] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    void unlockStatusAction().then((s) => setUntil(s.until));
  }, []);
  // Any "Unlock" action (a refused sensitive change) opens this same dialog.
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(UNLOCK_EVENT, show);
    return () => window.removeEventListener(UNLOCK_EVENT, show);
  }, []);
  useEffect(() => {
    if (until === null) return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [until]);

  const unlocked = until !== null && until > now;
  const minutes = unlocked ? Math.max(1, Math.ceil((until - now) / 60_000)) : 0;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto gap-2"
          title={unlocked ? `Sensitive changes are unlocked for ${minutes} more minute${minutes === 1 ? "" : "s"}` : "Unlock sensitive changes"}
        >
          {unlocked ? <LockOpenIcon className="size-4 text-warning-text" aria-hidden /> : <LockIcon className="size-4" aria-hidden />}
          <span className="hidden sm:inline">{unlocked ? `Unlocked, ${minutes} min` : "Unlock changes"}</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <UnlockForm
          authenticator={authenticator}
          onDone={(next) => {
            setUntil(next);
            setNow(Date.now());
            setOpen(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function UnlockForm({ authenticator, onDone }: { authenticator: boolean; onDone: (until: number) => void }) {
  const id = useId();
  const [state, action, pending] = useActionState<UnlockResult, FormData>(async (prev, form) => {
    const next = await unlockAction(prev, form);
    if (next.until) {
      toast.success("Unlocked sensitive changes for ten minutes");
      onDone(next.until);
    }
    return next;
  }, {});
  const errorId = `${id}-error`;
  const invalid = state.error !== undefined;
  return (
    <form action={action} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Unlock sensitive changes</DialogTitle>
        <DialogDescription id={`${id}-description`}>
          What an app runs, stored variables, servers and a restore over live data need your password{authenticator ? " and a code from your authenticator app" : ""} again. They stay possible for ten minutes.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-password`}>Password</Label>
        <Input id={`${id}-password`} name="password" type="password" autoComplete="current-password" required autoFocus aria-invalid={invalid} aria-describedby={invalid ? errorId : undefined} />
      </div>
      {authenticator && (
        <div className="grid gap-2">
          <Label htmlFor={`${id}-code`}>Authenticator code</Label>
          <Input id={`${id}-code`} name="code" inputMode="numeric" autoComplete="one-time-code" placeholder="123456 or a recovery code" required aria-invalid={invalid} aria-describedby={invalid ? errorId : undefined} />
        </div>
      )}
      {state.error && (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" loading={pending}>
          Unlock
        </Button>
      </DialogFooter>
    </form>
  );
}
