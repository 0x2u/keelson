"use client";

import { EyeIcon, LoaderCircleIcon } from "lucide-react";
import { ICONS } from "@/lib/icons";
import { useState } from "react";
import { configVersionAction } from "@/app/config-version-actions";
import { restoreVersionAction } from "@/app/config-actions";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DisabledWithReason, GatedButton } from "@/components/GatedButton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CopyButton } from "@/components/copy-button";
import { DiffView } from "@/components/config/DiffView";
import { saveFailure, useConfigSave } from "@/components/config/useConfigSave";
import { RelativeTime } from "@/components/relative-time";
import { Notice } from "@/components/states";
import type { ConfigVersion } from "@/lib/agent-types";

const SOURCE: Record<ConfigVersion["source"], string> = {
  startup: "Agent start",
  api: "Dashboard",
  file: "File edit",
  restore: "Restore",
};

type VersionText = { status: "idle" } | { status: "loading" } | { status: "ready"; content: string; files: { path: string; project: string }[] } | { status: "error"; message: string };

/** The changes restoring one version would make, in a side sheet. The text is fetched the first time the sheet opens. */
function ViewChanges({
  serverId,
  version,
  isCurrent,
  currentContent,
}: {
  serverId: string;
  version: ConfigVersion;
  isCurrent: boolean;
  currentContent: string;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<VersionText>({ status: "idle" });

  async function fetchText() {
    setText({ status: "loading" });
    try {
      const result = await configVersionAction(serverId, version.id);
      setText(result.ok ? { status: "ready", content: result.content, files: result.files } : { status: "error", message: result.message });
    } catch {
      setText({ status: "error", message: "The request failed before the agent answered." });
    }
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next && (text.status === "idle" || text.status === "error")) void fetchText();
  }

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(true)} aria-label={`View changes of version ${version.id}`}>
        <EyeIcon />
        View changes
      </Button>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="w-full sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>Version {version.id}</SheetTitle>
            <SheetDescription>
              {isCurrent
                ? "This is the current configuration."
                : "What the current configuration would look like after restoring this version: red lines go away, green lines come back."}
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            {text.status === "ready" && (
              <div className="space-y-3">
                {text.files.length > 0 && (
                  <Notice tone="info" title="This version holds project files too">
                    {text.files.map((f) => f.path).join(", ")}. The comparison below is of the shared file; restoring puts every file back, and a project file
                    that is not in this version is removed.
                  </Notice>
                )}
                <DiffView before={currentContent} after={text.content} identical={text.files.length > 0 ? "The shared file is identical to the current one." : "This version is identical to the current configuration."} className="max-h-none" />
              </div>
            )}
            {(text.status === "idle" || text.status === "loading") && (
              <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderCircleIcon aria-hidden className="size-4 animate-spin" />
                Loading this version…
              </p>
            )}
            {text.status === "error" && (
              <Notice
                title="Could not load this version"
                action={
                  <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => void fetchText()}>
                    Try again
                  </Button>
                }
              >
                {text.message}
              </Notice>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

/** Restore is off on a read-only server and for the version that is already current, with the reason on hover and focus. */
function RestoreButton({ canEdit, isCurrent, version, onClick }: { canEdit: boolean; isCurrent: boolean; version: ConfigVersion; onClick: () => void }) {
  const label = `Restore version ${version.id}`;
  if (!canEdit) {
    return (
      <GatedButton canDeploy={false} type="button" variant="outline" size="sm" aria-label={label}>
        <ICONS.rollback />
        Restore
      </GatedButton>
    );
  }
  const button = (
    <Button type="button" variant="outline" size="sm" onClick={onClick} disabled={isCurrent} aria-label={label}>
      <ICONS.rollback />
      Restore
    </Button>
  );
  return isCurrent ? <DisabledWithReason reason="Already the current configuration">{button}</DisabledWithReason> : button;
}

/**
 * The configuration history, newest first. `currentHash` and `currentContent` are the file as it is now: the newest
 * version with that hash is marked Current, and restoring is checked against that hash so an edit made meanwhile is noticed.
 */
export function VersionsList({
  serverId,
  versions,
  currentHash,
  currentContent,
  canEdit,
}: {
  serverId: string;
  versions: ConfigVersion[];
  currentHash: string;
  currentContent: string;
  canEdit: boolean;
}) {
  const [target, setTarget] = useState<ConfigVersion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { pending, run, dialogs } = useConfigSave();
  const currentId = versions.find((version) => version.hash === currentHash)?.id;

  async function restore(version: ConfigVersion) {
    setError(null);
    const { saved, result } = await run(
      "configuration",
      ({ force }) => restoreVersionAction(serverId, version.id, { base_hash: currentHash, force }),
      undefined,
      { inlineErrors: true, verb: "restored" },
    );
    if (saved) setTarget(null);
    else setError(saveFailure(result));
  }

  return (
    <>
      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Source</TableHead>
              <TableHead className="hidden md:table-cell">By</TableHead>
              <TableHead>Comment</TableHead>
              <TableHead className="hidden sm:table-cell">Hash</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {versions.map((version) => {
              const isCurrent = version.id === currentId;
              return (
                <TableRow key={version.id} id={`version-${version.id}`} className="scroll-mt-20 target:bg-muted/50">
                  <TableCell className="whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <RelativeTime at={version.at} />
                      {isCurrent && <Badge variant="success">Current</Badge>}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{SOURCE[version.source]}</Badge>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">{version.actor ?? <span className="text-muted-foreground">Unknown</span>}</TableCell>
                  <TableCell className="max-w-64 truncate" title={version.comment}>
                    {version.comment ?? <span className="text-muted-foreground">No comment</span>}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <span className="inline-flex items-center gap-1 font-mono text-xs">
                      {version.hash.slice(0, 8)}
                      <CopyButton value={version.hash} label={`Copy hash of version ${version.id}`} />
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      <ViewChanges serverId={serverId} version={version} isCurrent={isCurrent} currentContent={currentContent} />
                      <RestoreButton canEdit={canEdit} isCurrent={isCurrent} version={version} onClick={() => setTarget(version)} />
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (open) return;
          setTarget(null);
          setError(null);
        }}
        title={`Restore version ${target?.id}?`}
        description="The text of this version replaces the current configuration. It is saved as a new version and the agent applies it live, without a restart. Changes made since then are replaced, and stay in the history."
        confirmLabel="Restore and apply"
        pending={pending}
        error={error}
        onConfirm={() => target && void restore(target)}
      />

      {dialogs}
    </>
  );
}
