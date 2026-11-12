"use client";

import { RotateCwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";

/** Loads the page again from the server: for a card that says something could not be read. */
export function RetryButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button size="sm" variant="outline" loading={pending} onClick={() => startTransition(() => router.refresh())}>
      <RotateCwIcon /> Retry
    </Button>
  );
}
