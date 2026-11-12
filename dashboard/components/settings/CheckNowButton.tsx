"use client";

import { RefreshCwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { checkReleaseAction } from "@/app/release-actions";
import { toastActionError } from "@/components/unlock";
import { Button } from "@/components/ui/button";

/** Asks GitHub again which release is the latest (the dashboard asks once a day by itself), then shows what it found. */
export function CheckNowButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function check() {
    setPending(true);
    try {
      const r = await checkReleaseAction();
      if (r.limited) toast.info("Checked a moment ago", { description: "Wait a minute before checking again." });
      else if (r.failed) toastActionError("Could not check", "GitHub did not answer. The dashboard tries again later.");
      else if (r.status === "newer") toast.success(`Release ${r.tag} is available`);
      else if (r.status === "unknown") toast.info("No release to compare with");
      else toast.success("This dashboard is up to date");
      router.refresh();
    } catch {
      toastActionError("Could not check", "The dashboard did not answer.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Button type="button" variant="outline" size="sm" loading={pending} onClick={() => void check()}>
      <RefreshCwIcon />
      Check now
    </Button>
  );
}
