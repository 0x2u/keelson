"use client";

import { useId, useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StepUpAction } from "@/components/unlock";
import { confirmEnabled } from "@/lib/confirm-core";

export interface ConfirmDialogProps {
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  /** The exact name to type before the confirm button works. */
  typeToConfirm?: string;
  pending?: boolean;
  onConfirm: () => void;
  /** An error of the confirmed action, shown inside the dialog (with Unlock when the server asks for step-up). */
  error?: string | null;
  /** Extra content between the description and the buttons. */
  children?: ReactNode;
  /** The element that opens the dialog; omit when `open` is controlled. */
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * The one confirmation dialog. Destructive work with a name to protect asks for it typed; everything else confirms with
 * one click. While the action runs the dialog stays open, the confirm button is busy and Cancel is off.
 */
export function ConfirmDialog({ trigger, open, onOpenChange, pending = false, ...rest }: ConfirmDialogProps) {
  const [inner, setInner] = useState(false);
  const controlled = open !== undefined;
  const isOpen = controlled ? open : inner;
  return (
    <AlertDialog
      open={isOpen}
      onOpenChange={(next) => {
        if (pending) return;
        if (!controlled) setInner(next);
        onOpenChange?.(next);
      }}
    >
      {trigger !== undefined && <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>}
      <AlertDialogContent>
        <ConfirmBody pending={pending} {...rest} />
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The dialog's content; exported for tests, use ConfirmDialog. */
export function ConfirmBody({ title, description, confirmLabel, destructive, typeToConfirm, pending, onConfirm, error, children }: Omit<ConfirmDialogProps, "trigger" | "open" | "onOpenChange"> & { pending: boolean }) {
  const id = useId();
  const [typed, setTyped] = useState("");
  const enabled = confirmEnabled({ typed, required: typeToConfirm, pending });
  const errorId = `${id}-error`;
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (enabled) onConfirm();
      }}
    >
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
      </AlertDialogHeader>
      {children}
      {typeToConfirm !== undefined && (
        <div className="grid gap-2">
          <Label htmlFor={`${id}-name`}>
            Type <span className="font-mono font-semibold">{typeToConfirm}</span> to confirm
          </Label>
          <Input
            id={`${id}-name`}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            disabled={pending}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
          />
        </div>
      )}
      {error && (
        <div className="flex flex-wrap items-center gap-2">
          <p id={errorId} role="alert" className="text-sm text-destructive">
            {error}
          </p>
          <StepUpAction error={error} />
        </div>
      )}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
        <Button type="submit" variant={destructive ? "destructive" : "default"} loading={pending} disabled={!enabled}>
          {confirmLabel}
        </Button>
      </AlertDialogFooter>
    </form>
  );
}
