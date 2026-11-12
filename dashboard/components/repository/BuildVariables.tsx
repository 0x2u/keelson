"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  deleteBuildVarsAction,
  saveBuildVarsAction,
  type BuildVarsActionResult,
} from "@/app/build-vars-actions";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { GatedButton } from "@/components/GatedButton";
import { TextAreaField, TextField } from "@/components/forms/fields";
import { RelativeTime } from "@/components/relative-time";
import { Notice } from "@/components/states";
import { Button } from "@/components/ui/button";
import { StepUpAction } from "@/components/unlock";
import type { EnvIssue } from "@/lib/agent-types";
import {
  BUILD_VARS_ANCHOR,
  type BuildVarsView,
} from "@/lib/build-elsewhere-core";
import { parseDotenv } from "@/lib/dotenv-core";
import { keyIssue, valueIssue } from "@/lib/env-core";
import { ICONS } from "@/lib/icons";

/** A variable being typed: a new one (its name is editable), a replacement of a stored one, or a placeholder for a name copied from the app's own server. */
interface Row {
  id: number;
  key: string;
  value: string;
  /** The name is fixed: it replaces a stored variable or is a placeholder. */
  fixed: boolean;
}

/**
 * The build variables kept on the server that builds the app for another one: their names, never their values, and the
 * controls to add, replace, remove and paste a .env. Values are typed here, go to that server's agent in one request and are
 * cleared from the page as soon as it has them. A build on that server uses them; the app's own stored build variables
 * never travel (the section says so).
 */
export function BuildVariables({
  appServerId,
  builderId,
  builderName,
  app,
  view,
  canDeploy,
}: {
  appServerId: string;
  builderId: string;
  builderName: string;
  app: string;
  view: BuildVarsView;
  canDeploy: boolean;
}) {
  const router = useRouter();
  const id = useId();
  const [rows, setRows] = useState<Row[]>([]);
  const [paste, setPaste] = useState("");
  const [pasteNote, setPasteNote] = useState<string | null>(null);
  const [failure, setFailure] = useState<{
    message: string;
    issues: EnvIssue[];
  } | null>(null);
  const [pending, start] = useTransition();
  const ids = useRef(1);

  /** Adds rows; a fixed name that is already a row keeps it, taking the value when one is given. */
  const open = (add: Omit<Row, "id">[]) =>
    setRows((current) => {
      const next = [...current];
      for (const r of add) {
        const at = r.fixed
          ? next.findIndex((x) => x.fixed && x.key === r.key)
          : -1;
        if (at < 0) next.push({ ...r, id: ids.current++ });
        else if (r.value !== "") next[at] = { ...next[at], value: r.value };
      }
      return next;
    });

  const filled = rows.filter((r) => r.key.trim() !== "" && r.value !== "");
  const placeholders = rows.length - filled.length;
  const problems = filled.flatMap((r) => {
    const issue = keyIssue(r.key.trim()) ?? valueIssue(r.value);
    return issue === null ? [] : [`${r.key.trim()}: ${issue}`];
  });

  const done = (message: string) => {
    setRows([]);
    setFailure(null);
    toast.success(message);
    router.refresh();
  };
  const run = (
    work: () => Promise<BuildVarsActionResult>,
    message: (r: { changed: number; removed: number }) => string,
  ) =>
    start(async () => {
      setFailure(null);
      const result = await work();
      if (result.ok) done(message(result));
      else setFailure({ message: result.error, issues: result.issues });
    });

  const save = () =>
    run(
      () =>
        saveBuildVarsAction(
          appServerId,
          builderId,
          app,
          filled.map((r) => ({ key: r.key.trim(), value: r.value })),
        ),
      (r) =>
        `${r.changed} build variable${r.changed === 1 ? "" : "s"} saved on ${builderName}`,
    );

  const importPaste = () => {
    const parsed = parseDotenv(paste);
    const usable = parsed.entries.filter(
      (e) => keyIssue(e.key) === null && valueIssue(e.value) === null,
    );
    open(usable.map((e) => ({ key: e.key, value: e.value, fixed: true })));
    const refused =
      parsed.entries.length - usable.length + parsed.invalid.length;
    setPasteNote(
      `${usable.length} name${usable.length === 1 ? "" : "s"} read${refused > 0 ? `, ${refused} line${refused === 1 ? "" : "s"} cannot be used (a name that is not valid, a value that is too large, a line that is not NAME=value)` : ""}. Review them below, then save.`,
    );
    setPaste("");
  };

  const stored = new Set(view.names.map((n) => n.name));
  return (
    <section
      id={BUILD_VARS_ANCHOR}
      className="grid scroll-mt-20 gap-3 rounded-lg border p-4"
      aria-labelledby={`${id}-title`}
    >
      <div className="grid gap-1">
        <h3 id={`${id}-title`} className="text-sm font-medium">
          {view.title}
        </h3>
        <p className="text-xs text-muted-foreground">{view.intro}</p>
      </div>
      {view.ownNote && (
        <Notice tone="warning" title="Not used by a build here">
          {view.ownNote}
        </Notice>
      )}
      {view.readError && (
        <Notice title={`Could not read ${builderName}`}>
          {view.readError}
        </Notice>
      )}

      {view.readError === null && (
        <>
          {view.names.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {builderName} keeps no build variable for {app} yet.
            </p>
          ) : (
            <ul
              className="grid gap-1 rounded-md border"
              aria-label={`Build variables of ${app} on ${builderName}`}
            >
              {view.names.map((n) => (
                <li
                  key={n.name}
                  className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5 text-sm last:border-b-0"
                >
                  <span className="font-mono break-all">{n.name}</span>
                  <span className="text-xs text-muted-foreground">
                    set <RelativeTime at={n.changed_at} />
                  </span>
                  <span className="ml-auto flex items-center gap-1">
                    <GatedButton
                      variant="ghost"
                      size="sm"
                      canDeploy={canDeploy}
                      onClick={() =>
                        open([{ key: n.name, value: "", fixed: true }])
                      }
                    >
                      <ICONS.edit />
                      Replace<span className="sr-only"> value of {n.name}</span>
                    </GatedButton>
                    <ConfirmDialog
                      title={`Remove ${n.name}?`}
                      description={`${builderName} stops passing ${n.name} to the build of ${app}. Its value is deleted there and cannot be shown again.`}
                      confirmLabel="Remove"
                      destructive
                      pending={pending}
                      error={failure?.message}
                      onConfirm={() =>
                        run(
                          () =>
                            saveBuildVarsAction(
                              appServerId,
                              builderId,
                              app,
                              [],
                              [n.name],
                            ),
                          () => `${n.name} removed from ${builderName}`,
                        )
                      }
                      trigger={
                        <GatedButton
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          canDeploy={canDeploy}
                        >
                          <ICONS.remove />
                          <span className="sr-only">Remove {n.name}</span>
                        </GatedButton>
                      }
                    />
                  </span>
                </li>
              ))}
            </ul>
          )}

          {rows.length > 0 && (
            <div className="grid gap-3 rounded-md border border-dashed p-3">
              {rows.map((r) => (
                <div
                  key={r.id}
                  className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] sm:items-end"
                >
                  <TextField
                    id={`${id}-key-${r.id}`}
                    label="Name"
                    value={r.key}
                    onChange={(key) =>
                      setRows(
                        rows.map((x) => (x.id === r.id ? { ...x, key } : x)),
                      )
                    }
                    readOnly={r.fixed}
                    placeholder="DATABASE_URL"
                    autoCapitalize="off"
                    mono
                    help={
                      r.fixed && stored.has(r.key)
                        ? "Replaces the stored value."
                        : undefined
                    }
                  />
                  <TextField
                    id={`${id}-value-${r.id}`}
                    label="Value"
                    type="password"
                    autoComplete="new-password"
                    value={r.value}
                    onChange={(value) =>
                      setRows(
                        rows.map((x) => (x.id === r.id ? { ...x, value } : x)),
                      )
                    }
                    placeholder="Write-only: never shown again"
                    mono
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setRows(rows.filter((x) => x.id !== r.id))}
                  >
                    <ICONS.remove />
                    <span className="sr-only">
                      Discard {r.key || "this row"}
                    </span>
                  </Button>
                </div>
              ))}
              {problems.length > 0 && (
                <ul
                  className="list-disc pl-4 text-xs text-destructive"
                  role="alert"
                >
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
              {placeholders > 0 && (
                <p className="text-xs text-muted-foreground">
                  {placeholders} row{placeholders === 1 ? "" : "s"} without a
                  value will not be saved.
                </p>
              )}
            </div>
          )}

          {failure && (
            <Notice
              title="Could not save"
              action={<StepUpAction error={failure.message} />}
            >
              {failure.message}
              {failure.issues.length > 0 && (
                <ul className="mt-1 list-disc pl-4">
                  {failure.issues.map((i, n) => (
                    <li key={n}>
                      {i.key !== "" && (
                        <span className="font-mono">{i.key}</span>
                      )}{" "}
                      {i.message}
                    </li>
                  ))}
                </ul>
              )}
            </Notice>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <GatedButton
              variant="outline"
              size="sm"
              canDeploy={canDeploy}
              onClick={() => open([{ key: "", value: "", fixed: false }])}
            >
              <ICONS.add />
              Add variable
            </GatedButton>
            {view.missing.length > 0 && (
              <GatedButton
                variant="outline"
                size="sm"
                canDeploy={canDeploy}
                onClick={() =>
                  open(
                    view.missing.map((key) => ({
                      key,
                      value: "",
                      fixed: true,
                    })),
                  )
                }
                data-testid="copy-names"
              >
                Copy the names ({view.missing.length}) from the app&apos;s own
                server
              </GatedButton>
            )}
            <GatedButton
              size="sm"
              canDeploy={canDeploy}
              loading={pending}
              disabled={filled.length === 0 || problems.length > 0}
              onClick={save}
            >
              Save on {builderName}
            </GatedButton>
            {view.names.length > 0 && (
              <ConfirmDialog
                title={`Remove every build variable of ${app} on ${builderName}?`}
                description="The values are deleted there and cannot be shown again."
                confirmLabel="Remove all"
                destructive
                pending={pending}
                error={failure?.message}
                onConfirm={() =>
                  run(
                    () => deleteBuildVarsAction(appServerId, builderId, app),
                    (r) =>
                      `${r.removed} build variable${r.removed === 1 ? "" : "s"} removed from ${builderName}`,
                  )
                }
                trigger={
                  <GatedButton
                    variant="ghost"
                    size="sm"
                    className="ml-auto text-destructive hover:text-destructive"
                    canDeploy={canDeploy}
                  >
                    <ICONS.remove />
                    Remove all
                  </GatedButton>
                }
              />
            )}
          </div>
          {view.missing.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Copying the names adds one empty row for each of{" "}
              {view.missing.join(", ")}. Values are write-only and never leave
              the app&apos;s server, so type them again here.
            </p>
          )}
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">
              Paste a .env
            </summary>
            <div className="mt-2 grid gap-2">
              <TextAreaField
                id={`${id}-paste`}
                label="NAME=value lines"
                value={paste}
                onChange={setPaste}
                rows={4}
                mono
                autoCapitalize="off"
                placeholder={
                  "DATABASE_URL=postgres://…\nNEXT_PUBLIC_API=https://…"
                }
              />
              <div>
                <GatedButton
                  type="button"
                  variant="outline"
                  size="sm"
                  canDeploy={canDeploy}
                  disabled={paste.trim() === ""}
                  onClick={importPaste}
                >
                  Read the pasted lines
                </GatedButton>
              </div>
              {pasteNote && (
                <p className="text-xs text-muted-foreground">{pasteNote}</p>
              )}
            </div>
          </details>
        </>
      )}
    </section>
  );
}
