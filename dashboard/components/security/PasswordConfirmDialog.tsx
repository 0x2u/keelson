"use client";

import { useActionState, useId, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { SecurityState } from "@/app/auth-actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StepUpAction } from "@/components/unlock";

export interface PasswordConfirmDialogProps {
  title: string;
  /** What exactly changes, in plain words. */
  description: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  action: (prev: SecurityState, form: FormData) => Promise<SecurityState>;
  /** The button that opens the dialog. */
  trigger: ReactNode;
  onSuccess?: (state: SecurityState) => void;
  /** Toast shown on success. Defaults to the confirm label. */
  successMessage?: string;
}

/** Asks for the current password again before a change to how the account is protected. */
export function PasswordConfirmDialog({ trigger, ...rest }: PasswordConfirmDialogProps) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <PasswordForm {...rest} close={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function PasswordForm({
  title,
  description,
  confirmLabel,
  destructive,
  action,
  onSuccess,
  successMessage,
  close,
}: Omit<PasswordConfirmDialogProps, "trigger"> & { close: () => void }) {
  const id = useId();
  const [password, setPassword] = useState("");
  const [state, formAction, pending] = useActionState<SecurityState, FormData>(async (prev, form) => {
    const next = await action(prev, form);
    if (next.ok) {
      toast.success(successMessage ?? confirmLabel);
      onSuccess?.(next);
      close();
    }
    return next;
  }, {});
  const errorId = `${id}-error`;

  return (
    <form action={formAction} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-password`}>Current password</Label>
        <Input
          id={`${id}-password`}
          name="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          autoFocus
          required
          spellCheck={false}
          aria-invalid={state.error !== undefined}
          aria-describedby={state.error !== undefined ? errorId : undefined}
        />
        {state.error && (
          <div className="flex flex-wrap items-center gap-2">
            <p id={errorId} role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
            <StepUpAction error={state.error} />
          </div>
        )}
      </div>
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" variant={destructive ? "destructive" : "default"} loading={pending}>
          {confirmLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}
