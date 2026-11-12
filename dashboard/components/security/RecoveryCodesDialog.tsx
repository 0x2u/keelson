"use client";

import { CopyIcon, DownloadIcon } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { toastCopy } from "@/lib/toast-core";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

/**
 * Shows recovery codes exactly once. It cannot be dismissed until the operator confirms they
 * saved the codes, because closing it loses them for good.
 */
export function RecoveryCodesDialog({ codes, onDone }: { codes: string[] | null; onDone: () => void }) {
  return (
    <Dialog open={codes !== null}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-md"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        {codes && <CodesBody codes={codes} onDone={onDone} />}
      </DialogContent>
    </Dialog>
  );
}

function CodesBody({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const id = useId();
  const [saved, setSaved] = useState(false);
  const text = codes.join("\n");

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(toastCopy.copied("recovery codes"));
    } catch {
      toast.error(toastCopy.failed("copied", "to the clipboard"), { description: "The browser refused clipboard access" });
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([`Keelson recovery codes\nEach code works once.\n\n${text}\n`], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "keelson-recovery-codes.txt";
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Your recovery codes</DialogTitle>
        <DialogDescription>
          These are shown once. If you lose your authenticator and passkeys, a recovery code is the only way to sign in. Each code works a single time, and
          any earlier codes no longer work.
        </DialogDescription>
      </DialogHeader>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border bg-muted/40 p-4 font-mono text-sm" aria-label="Recovery codes">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={copyAll}>
          <CopyIcon /> Copy all
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={download}>
          <DownloadIcon /> Download .txt
        </Button>
      </div>
      <div className="flex items-start gap-2">
        <input
          id={`${id}-saved`}
          type="checkbox"
          checked={saved}
          onChange={(event) => setSaved(event.target.checked)}
          className="mt-0.5 size-4 accent-primary"
        />
        <Label htmlFor={`${id}-saved`} className="font-normal">
          I saved these codes
        </Label>
      </div>
      <DialogFooter>
        <Button type="button" disabled={!saved} onClick={onDone}>
          Close
        </Button>
      </DialogFooter>
    </>
  );
}
