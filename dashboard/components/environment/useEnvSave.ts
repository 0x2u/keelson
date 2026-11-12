"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveEnvAction } from "@/app/env-actions";
import { showSaveNotice } from "@/components/save-notice-toast";
import type { EnvIssue, EnvScope } from "@/lib/agent-types";
import { envSavedNotice, type EnvEdit } from "@/lib/env-core";

export interface EnvSaveFailure {
  message: string;
  issues: EnvIssue[];
}

/**
 * Saves a change of one scope through the server action. The values leave in that call and are not kept here: a failure
 * keeps only the text and the problems by name. A success tells what it takes to apply (a persistent notice with a prefilled
 * Deploy for the app's own scope) and refreshes the page's list.
 */
export function useEnvSave(o: { serverId: string; app: string; scope: EnvScope; servingImage: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [failure, setFailure] = useState<EnvSaveFailure | null>(null);

  const save = (edits: EnvEdit[], unset: string[], onDone?: () => void) => {
    setFailure(null);
    start(async () => {
      const result = await saveEnvAction(o.serverId, o.app, o.scope, edits, unset);
      if (!result.ok) {
        setFailure({ message: result.error, issues: result.issues });
        return;
      }
      showSaveNotice(
        envSavedNotice(o.scope, { serverId: o.serverId, app: o.app, servingImage: o.servingImage, buildKeys: edits.filter((e) => e.build).length }),
        (href) => router.push(href),
      );
      router.refresh();
      onDone?.();
    });
  };

  return { save, pending, failure, clearFailure: () => setFailure(null) };
}
