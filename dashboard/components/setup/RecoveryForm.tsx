"use client";

import { DownloadIcon } from "lucide-react";
import { useActionState, useId, useState } from "react";
import { toast } from "sonner";
import { finishRecoveryAction, type RecoveryState } from "@/app/setup/actions";
import { Notice } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RECOVERY_FILE_NAME } from "@/lib/setup-core";

/**
 * The second setup step. With a generated key: the download of the recovery file, then the confirmation that unlocks Continue
 * (the dashboard also refuses to continue before the file was fetched). With a key from the environment there is nothing to
 * download, only the confirmation.
 */
export function RecoveryForm({ fromFile, downloaded }: { fromFile: boolean; downloaded: boolean }) {
  const [state, action, pending] = useActionState<RecoveryState, FormData>(finishRecoveryAction, {});
  const id = useId();
  const [fetched, setFetched] = useState(downloaded);
  const [downloading, setDownloading] = useState(false);
  const [saved, setSaved] = useState(false);
  const canConfirm = !fromFile || fetched;

  async function download() {
    setDownloading(true);
    try {
      const res = await fetch("/setup/recovery/file", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        toast.error("Could not download the recovery file", { description: body?.error ?? `The dashboard answered ${res.status}` });
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = RECOVERY_FILE_NAME;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setFetched(true);
      toast.success("Downloaded the recovery file");
    } catch {
      toast.error("Could not download the recovery file", { description: "The dashboard did not answer." });
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="grid gap-5">
      {fromFile && (
        <div className="grid gap-2">
          <Button type="button" variant={fetched ? "outline" : "default"} loading={downloading} onClick={() => void download()} className="w-full">
            <DownloadIcon />
            {fetched ? "Download it again" : `Download ${RECOVERY_FILE_NAME}`}
          </Button>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {fetched ? "Downloaded. Check that the file is where you expect it, then confirm below." : "The confirmation below unlocks once the file is downloaded."}
          </p>
        </div>
      )}
      <form action={action} noValidate className="grid gap-4">
        {state.error && <Notice title="Not yet">{state.error}</Notice>}
        <div className="flex items-start gap-3">
          <input
            id={id}
            name="saved"
            type="checkbox"
            checked={saved && canConfirm}
            disabled={!canConfirm}
            onChange={(event) => setSaved(event.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-primary disabled:cursor-not-allowed disabled:opacity-50"
          />
          <Label htmlFor={id} className="font-normal">
            {fromFile ? "I saved it" : "I know where my master key is kept"}
          </Label>
        </div>
        <Button type="submit" loading={pending} disabled={!(saved && canConfirm)} className="w-full">
          Continue
        </Button>
      </form>
    </div>
  );
}
