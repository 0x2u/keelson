"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { CircleAlertIcon, CircleCheckIcon, LoaderCircleIcon, SaveIcon, TriangleAlertIcon } from "lucide-react";
import { ICONS } from "@/lib/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { saveConfigAction, validateConfigAction } from "@/app/config-actions";
import { saveProjectConfigAction, validateProjectConfigAction } from "@/app/project-config-actions";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IssuesList } from "@/components/config/IssuesList";
import { ReviewChangesDialog } from "@/components/config/ReviewChangesDialog";
import { saveFailure, useConfigSave } from "@/components/config/useConfigSave";
import { YamlEditor, type YamlEditorHandle } from "@/components/config/YamlEditor";
import { RelativeTime } from "@/components/relative-time";
import { Notice } from "@/components/states";
import type { ConfigIssue } from "@/lib/agent-types";
import { issuesInFile } from "@/lib/project-config-core";

/** How long the draft must rest before it is sent to the agent for checking. */
const DEBOUNCE_MS = 600;

/** The agent's verdict on one exact text. */
interface Checked {
  text: string;
  issues: ConfigIssue[];
  /** Why the check could not run. */
  failure?: string;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** One line saying where the check stands; the live region announces changes to screen readers. */
function CheckStatus({ checked, errors, warnings }: { checked: Checked | null; errors: number; warnings: number }) {
  let icon = <CircleCheckIcon aria-hidden className="size-4 text-success" />;
  let text = "No problems found";
  if (checked === null) {
    icon = <LoaderCircleIcon aria-hidden className="size-4 animate-spin text-muted-foreground" />;
    text = "Checking…";
  } else if (checked.failure !== undefined) {
    icon = <CircleAlertIcon aria-hidden className="size-4 text-destructive" />;
    text = "Could not check";
  } else if (errors > 0) {
    icon = <CircleAlertIcon aria-hidden className="size-4 text-destructive" />;
    text = warnings > 0 ? `${plural(errors, "error")}, ${plural(warnings, "warning")}` : plural(errors, "error");
  } else if (warnings > 0) {
    icon = <TriangleAlertIcon aria-hidden className="size-4 text-warning" />;
    text = plural(warnings, "warning");
  }
  return (
    <p role="status" className={checked === null ? "flex items-center gap-1.5 text-muted-foreground" : "flex items-center gap-1.5"}>
      {icon}
      <span>{text}</span>
    </p>
  );
}

/**
 * The configuration file as text, checked by the agent while you type. Mount it with `key={hash}`: a saved or
 * reloaded document then starts a fresh draft from the new content. With `project` it edits that project's own file
 * (projects.d/<project>.yaml) and `hash` is that file's hash; without, it edits the apps file and `hash` is the
 * configuration's. `file` is the path of the file shown, so that issues of the other files are listed without a jump.
 */
export function ConfigEditor({
  serverId,
  content,
  hash,
  modifiedAt,
  canEdit,
  project,
  file,
}: {
  serverId: string;
  /** The file as the agent holds it, secrets shown as <hidden>. */
  content: string;
  /** Hash of that file: sent back with every save so an edit made elsewhere is noticed. */
  hash: string;
  modifiedAt: string;
  /** False without the deploy secret: the text is shown, not editable. */
  canEdit: boolean;
  project?: string;
  file?: string;
}) {
  const [draft, setDraft] = useState(content);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  // The address a click inside the app was heading for while unsaved text is open: the leave dialog asks, then goes there.
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const router = useRouter();
  const editor = useRef<YamlEditorHandle>(null);
  const { pending, run, dialogs } = useConfigSave();

  const dirty = draft !== content;

  // Checks the draft once typing pauses. A newer draft cancels the older check, so a late answer is never shown.
  useEffect(() => {
    if (!canEdit) return;
    let current = true;
    const timer = setTimeout(
      async () => {
        let result: Checked;
        try {
          const answer = project === undefined ? await validateConfigAction(serverId, draft) : await validateProjectConfigAction(serverId, project, draft);
          result = { text: draft, issues: answer.issues, failure: "message" in answer ? answer.message : undefined };
        } catch {
          result = { text: draft, issues: [], failure: "The request failed before the agent answered." };
        }
        if (current) setChecked(result);
      },
      draft === content ? 0 : DEBOUNCE_MS,
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [serverId, project, content, draft, canEdit]);

  // Leaving with unsaved text: the browser asks on reload and close; links inside the app ask here.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (!(event.target instanceof Element)) return;
      const anchor = event.target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href);
      if (url.origin === location.origin && url.pathname === location.pathname && url.search === location.search) return;
      event.preventDefault();
      event.stopPropagation();
      setLeaveTo(anchor.href);
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty]);

  // Ctrl or Cmd+S opens the review instead of the browser's "save page".
  useEffect(() => {
    if (!canEdit) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      if (dirty && !resetOpen) setReviewOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canEdit, dirty, resetOpen]);

  const checkedDraft = checked !== null && checked.text === draft ? checked : null;
  // While a new check is on its way the previous findings stay visible, moved along with the text by the editor.
  const issues = useMemo(() => checked?.issues ?? [], [checked]);
  const marked = useMemo(() => issuesInFile(issues, file), [issues, file]);
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.length - errors;

  function leave() {
    const target = leaveTo;
    setLeaveTo(null);
    if (target === null) return;
    const url = new URL(target);
    if (url.origin === location.origin) router.push(url.pathname + url.search + url.hash);
    else location.assign(target);
  }

  async function save(comment: string) {
    setSaveError(null);
    const { saved, result } = await run(
      project === undefined ? "configuration" : `configuration of ${project}`,
      ({ force }) => {
        const opts = { base_hash: hash, comment: comment === "" ? undefined : comment, force };
        return project === undefined ? saveConfigAction(serverId, draft, opts) : saveProjectConfigAction(serverId, project, draft, opts);
      },
      undefined,
      { inlineErrors: true },
    );
    if (saved) {
      setReviewOpen(false);
    } else if (!result.ok && result.kind === "invalid") {
      setChecked({ text: draft, issues: result.issues });
      setReviewOpen(false);
    } else {
      setSaveError(saveFailure(result));
    }
  }

  return (
    <div className="space-y-4">
      {!canEdit && (
        <Notice
          tone="info"
          title="Read-only"
          action={
            <Link href={`/servers/${serverId}/settings`} className="text-sm font-medium underline-offset-4 hover:underline">
              Open server settings
            </Link>
          }
        >
          Changing the configuration needs this server&apos;s deploy access, and the dashboard has none. Add it in the server settings to edit.
        </Notice>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          {canEdit && <CheckStatus checked={checkedDraft} errors={errors} warnings={warnings} />}
          {dirty && <Badge variant="warning">Unsaved changes</Badge>}
          <span className="text-muted-foreground">
            Last changed <RelativeTime at={modifiedAt} />
          </span>
        </div>

        {canEdit && (
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" onClick={() => setResetOpen(true)} disabled={!dirty || pending}>
              <ICONS.rollback />
              Reset
            </Button>
            <Button type="button" onClick={() => setReviewOpen(true)} disabled={!dirty || pending} title="Ctrl or Cmd + S">
              <SaveIcon />
              Review and save
            </Button>
          </div>
        )}
      </div>

      <YamlEditor
        ref={editor}
        value={draft}
        onChange={setDraft}
        issues={marked}
        readOnly={!canEdit}
        label={project === undefined ? "Configuration, YAML" : `Configuration of ${project}, YAML`}
        className="h-[min(70vh,40rem)] min-h-64"
      />

      {checkedDraft?.failure !== undefined && (
        <Notice title="The configuration could not be checked">
          {checkedDraft.failure} Your text is kept; it is checked again when you change it.
        </Notice>
      )}

      {issues.length > 0 && (
        <section aria-label="Problems found" className={checkedDraft === null ? "space-y-2 opacity-60" : "space-y-2"}>
          <IssuesList issues={issues} file={file} onSelectLine={(line) => editor.current?.scrollToLine(line)} />
        </section>
      )}

      <ReviewChangesDialog
        open={reviewOpen}
        onOpenChange={(open) => {
          setReviewOpen(open);
          if (!open) setSaveError(null);
        }}
        original={content}
        draft={draft}
        issues={issues}
        checking={checkedDraft === null}
        checkFailure={checkedDraft?.failure}
        pending={pending}
        error={saveError}
        onSave={save}
      />

      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title="Discard your changes?"
        description="The editor goes back to the saved configuration. The text you typed since then is lost."
        confirmLabel="Discard changes"
        destructive
        onConfirm={() => {
          setDraft(content);
          setResetOpen(false);
        }}
      />

      <ConfirmDialog
        open={leaveTo !== null}
        onOpenChange={(open) => !open && setLeaveTo(null)}
        title="Discard unsaved changes?"
        description="You have unsaved changes. Leaving this page discards them."
        confirmLabel="Discard changes"
        destructive
        onConfirm={leave}
      />

      {dialogs}
    </div>
  );
}
