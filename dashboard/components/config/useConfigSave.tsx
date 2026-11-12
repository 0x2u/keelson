"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { ConfigActionResult } from "@/app/config-actions";
import { showSaveNotice } from "@/components/save-notice-toast";
import type { SaveNotice } from "@/lib/app-config-core";
import type { ConfigIssue } from "@/lib/agent-types";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { toastActionError } from "@/components/unlock";
import { toastCopy } from "@/lib/toast-core";
import { IssuesList } from "@/components/config/IssuesList";

export interface ConfigSaveRun {
  saved: boolean;
  result: ConfigActionResult;
}

/** The agent wants these warnings acknowledged; `settle` carries the user's answer back to the waiting `run`. */
interface Acknowledgement {
  issues: ConfigIssue[];
  settle: (confirmed: boolean) => void;
}

/** What `run` may be told: where a failure is reported and which past-tense verb the success toast uses. */
export interface ConfigSaveOptions {
  /** The caller shows the failure inside its open dialog (see `saveFailure`); `run` stays quiet about it. */
  inlineErrors?: boolean;
  verb?: Parameters<typeof toastCopy.done>[0];
}

/** The message of a failed run that has none to show next to fields (not `invalid`, not `changed`, which has its own dialog). */
export function saveFailure(result: ConfigActionResult): string | null {
  if (result.ok) return null;
  if (result.kind === "busy") return result.message ?? "The agent cannot apply this change right now. Try again in a moment.";
  if (result.kind === "needs_acknowledgement") return result.message ?? "The agent still asks for confirmation. Reload and try again.";
  if (result.kind === "error") return result.message;
  return null;
}

const NO_ANSWER: ConfigActionResult = {
  ok: false,
  kind: "error",
  message: "The request failed before the agent answered. Check the connection and try again.",
  issues: [],
};

/**
 * Runs configuration changes and handles every outcome the agent can answer with, so each screen only has to show
 * its own `invalid` issues next to its fields. Render `dialogs` once in the component that calls `run`.
 */
export function useConfigSave(): {
  pending: boolean;
  /**
   * Runs a change. Success: toast and refresh. needs_acknowledgement: a confirmation listing the warnings, then the
   * change again with `force`. changed: a dialog offering to reload. busy and error: a toast with the cause, or nothing
   * with `inlineErrors` (the caller shows `saveFailure(result)` in its open dialog).
   * `invalid` is returned untouched so the caller can show the issues beside its fields.
   * `notice` replaces the default "Saved <label>" toast: what the save means for the running version, with its action.
   */
  run(label: string, save: (opts: { force: boolean }) => Promise<ConfigActionResult>, notice?: SaveNotice, options?: ConfigSaveOptions): Promise<ConfigSaveRun>;
  dialogs: ReactNode;
} {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [acknowledgement, setAcknowledgement] = useState<Acknowledgement | null>(null);
  const [changedOpen, setChangedOpen] = useState(false);

  const run = useCallback(
    async (label: string, save: (opts: { force: boolean }) => Promise<ConfigActionResult>, notice?: SaveNotice, options?: ConfigSaveOptions): Promise<ConfigSaveRun> => {
      setPending(true);
      try {
        let force = false;
        for (;;) {
          let result: ConfigActionResult;
          try {
            result = await save({ force });
          } catch {
            result = NO_ANSWER;
          }

          if (result.ok) {
            if (notice) showSaveNotice(notice, (href) => router.push(href));
            else toast.success(toastCopy.done(options?.verb ?? "saved", label));
            router.refresh();
            return { saved: true, result };
          }

          if (result.kind === "needs_acknowledgement" && !force) {
            setPending(false);
            const { issues } = result;
            const confirmed = await new Promise<boolean>((settle) => setAcknowledgement({ issues, settle }));
            setPending(true);
            if (!confirmed) return { saved: false, result };
            force = true;
            continue;
          }

          if (result.kind === "changed") setChangedOpen(true);
          else if (!options?.inlineErrors) {
            const message = saveFailure(result);
            if (message !== null) toastActionError(toastCopy.failed(options?.verb ?? "saved", label), message);
          }
          return { saved: false, result };
        }
      } finally {
        setPending(false);
      }
    },
    [router],
  );

  function answer(confirmed: boolean) {
    acknowledgement?.settle(confirmed);
    setAcknowledgement(null);
  }

  const dialogs = (
    <>
      <ConfirmDialog
        open={acknowledgement !== null}
        onOpenChange={(open) => !open && answer(false)}
        title="Apply these changes?"
        description="The agent applies this configuration live and asks you to confirm what it will do. Nothing has been changed yet."
        confirmLabel="Apply anyway"
        destructive
        onConfirm={() => answer(true)}
      >
        <IssuesList issues={acknowledgement?.issues ?? []} />
      </ConfirmDialog>

      <ConfirmDialog
        open={changedOpen}
        onOpenChange={setChangedOpen}
        title="This configuration was changed elsewhere"
        description="The configuration on the agent changed after you opened it, from another session or by editing the file. Nothing was saved. Reload to see the current version, then make your change again. Reloading discards what is not saved here, so copy your text first if you need it."
        confirmLabel="Reload"
        onConfirm={() => {
          setChangedOpen(false);
          router.refresh();
        }}
      />
    </>
  );

  return { pending, run, dialogs };
}
