"use client";

import { DownloadIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { toastActionError } from "@/components/unlock";
import { Button } from "@/components/ui/button";

/** The name the server gave the file ("keelson-dashboard-20261102-120000.db"), from its Content-Disposition. */
function fileNameOf(res: Response): string {
  return /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "keelson-dashboard.db";
}

/**
 * Downloads a consistent copy of the dashboard's database. A sensitive action: a session that is not unlocked is refused,
 * and the refusal offers the Unlock dialog. The copy goes straight from the response to the browser's download.
 */
export function DownloadCopyButton({ label = "Download a copy" }: { label?: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function download() {
    setPending(true);
    try {
      const res = await fetch("/api/dashboard-backup", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        toastActionError("Could not download the copy", body?.error ?? `The dashboard answered ${res.status}`);
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = fileNameOf(res);
      link.click();
      URL.revokeObjectURL(url);
      toast.success("Downloaded a copy of the dashboard");
      router.refresh();
    } catch {
      toastActionError("Could not download the copy", "The dashboard did not answer.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Button type="button" loading={pending} onClick={() => void download()}>
      <DownloadIcon />
      {label}
    </Button>
  );
}
