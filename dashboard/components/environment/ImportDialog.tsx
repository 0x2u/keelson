"use client";

import { FileUpIcon } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import { useEnvSave } from "@/components/environment/useEnvSave";
import { Notice } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ERROR_TEXT, TextAreaField } from "@/components/forms/fields";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StepUpAction } from "@/components/unlock";
import type { EnvScope, EnvVar } from "@/lib/agent-types";
import { parseDotenv } from "@/lib/dotenv-core";
import { BUILD_WARNING, looksSecret, reviewImport, type EnvRules, type ImportReview } from "@/lib/env-core";

const MAX_FILE = 1024 * 1024;

/** What the review shows in place of a value: always the same, whatever the value is. */
export const MASK = "••••••••";

/**
 * Imports a .env: paste it or choose a file, read it here in the browser, review the names (never the values), then save
 * them in one request. The text and the values stay in this component's state until the dialog closes.
 */
export function ImportDialog({
  target,
  rules,
  stored,
  onClose,
}: {
  target: { serverId: string; app: string; scope: EnvScope; servingImage: string };
  rules: EnvRules;
  stored: EnvVar[];
  onClose: () => void;
}) {
  const id = useId();
  const file = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [build, setBuild] = useState<Record<string, boolean>>({});
  const { save, pending, failure, clearFailure } = useEnvSave(target);

  const parse = useMemo(() => (reviewing ? parseDotenv(text) : null), [reviewing, text]);
  const review = useMemo(() => (parse ? reviewImport(parse, stored, rules) : null), [parse, stored, rules]);
  const importable = review?.rows.filter((r) => r.status !== "invalid") ?? [];
  const blocked = (review?.issues.length ?? 0) > 0;
  const isBuild = (key: string, suggested: boolean) => build[key] ?? suggested;

  const close = () => {
    if (pending) return;
    setText("");
    setBuild({});
    onClose();
  };

  async function readFile(f: File | undefined) {
    setFileError(null);
    if (!f) return;
    if (f.size > MAX_FILE) {
      setFileError("That file is larger than 1 MiB: it is not a .env file.");
      return;
    }
    setText(await f.text());
  }

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import a .env file</DialogTitle>
          <DialogDescription>
            {reviewing
              ? "Check the names. The values are not shown; they are saved as they are in the file."
              : "Paste the content of a .env file or choose one. It is read in your browser and sent only when you save."}
          </DialogDescription>
        </DialogHeader>

        {!reviewing && (
          <div className="grid gap-3">
            <TextAreaField
              id={`${id}-text`}
              label="Content"
              value={text}
              onChange={setText}
              rows={10}
              placeholder={"# comments are ignored\nDATABASE_URL=postgres://…\nexport API_BASE=\"https://example.com\""}
              autoCapitalize="off"
              autoFocus
              mono
              inputClassName="max-h-64 text-xs"
            />
            <div className="flex flex-wrap items-center gap-2">
              <input ref={file} type="file" className="sr-only" tabIndex={-1} aria-label="Choose a .env file" onChange={(e) => void readFile(e.target.files?.[0])} />
              <Button type="button" variant="outline" size="sm" onClick={() => file.current?.click()}>
                <FileUpIcon />
                Choose a file
              </Button>
              {fileError && <span className={ERROR_TEXT}>{fileError}</span>}
            </div>
          </div>
        )}

        {review && <ImportReviewTable review={review} isBuild={isBuild} onBuild={(key, on) => setBuild({ ...build, [key]: on })} />}

        {failure && (
          <Notice title="Could not save" action={<StepUpAction error={failure.message} />}>
            {failure.message}
            {failure.issues.length > 0 && (
              <ul className="mt-1 list-disc pl-4">
                {failure.issues.map((i, n) => (
                  <li key={n}>
                    {i.key !== "" && <span className="font-mono">{i.key}</span>} {i.message}
                  </li>
                ))}
              </ul>
            )}
          </Notice>
        )}

        <DialogFooter>
          {reviewing ? (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  clearFailure();
                  setReviewing(false);
                }}
              >
                Back
              </Button>
              <Button
                type="button"
                loading={pending}
                disabled={importable.length === 0 || blocked}
                onClick={() => {
                  if (!parse || !review) return;
                  const values = new Map(parse.entries.map((e) => [e.key, e.value]));
                  save(
                    importable.map((r) => ({ key: r.key, value: values.get(r.key) ?? "", build: isBuild(r.key, r.build) })),
                    [],
                    () => {
                      setText("");
                      setBuild({});
                      onClose();
                    },
                  );
                }}
              >
                Save {importable.length} variable{importable.length === 1 ? "" : "s"}
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button type="button" disabled={text.trim() === ""} onClick={() => setReviewing(true)}>
                Review
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What an import would do, by name: new or replacing, with the build-time boxes. The values are not here at all: each row
 * shows the same mask. Pure markup from the review, so it renders without a browser.
 */
export function ImportReviewTable({
  review,
  isBuild,
  onBuild,
}: {
  review: ImportReview;
  isBuild: (key: string, suggested: boolean) => boolean;
  onBuild: (key: string, on: boolean) => void;
}) {
  const importable = review.rows.filter((r) => r.status !== "invalid");
  return (
      <div className="grid max-h-[60vh] auto-rows-max gap-3 overflow-y-auto">
        {review.unreadable.length > 0 && (
          <Notice tone="warning" title={`${review.unreadable.length} line${review.unreadable.length === 1 ? "" : "s"} could not be read`}>
            <ul className="list-disc pl-4">
              {review.unreadable.map((p) => (
                <li key={p.line}>
                  Line {p.line}
                  {p.key !== undefined && (
                    <>
                      {" "}
                      <span className="font-mono">{p.key}</span>
                    </>
                  )}
                  : {p.reason}
                </li>
              ))}
            </ul>
          </Notice>
        )}
        {review.repeated.length > 0 && (
          <Notice tone="warning" title="Some names appear more than once">
            The last value of each is used:{" "}
            {review.repeated.map((d, i) => (
              <span key={d.key}>
                {i > 0 && ", "}
                <span className="font-mono">{d.key}</span> (lines {d.lines.join(", ")})
              </span>
            ))}
            .
          </Notice>
        )}
        {review.issues.map((i, n) => (
          <Notice key={n} title="Cannot import this file">
            {i.message}
          </Notice>
        ))}
        {review.rows.length === 0 ? (
          <Notice tone="info" title="No variable found">
            Nothing in the text looks like NAME=value.
          </Notice>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-3">Name</TableHead>
                  <TableHead className="hidden sm:table-cell">Value</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead className="pr-3" title="Available at build time">Build</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {review.rows.map((r) => (
                  <TableRow key={r.key}>
                    <TableCell className="pl-3 whitespace-normal">
                      <div className="font-mono text-xs break-all">{r.key}</div>
                      {r.status === "invalid" && <div className="mt-0.5 text-xs text-destructive">{r.issue}</div>}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell" aria-label="hidden value">
                      {MASK}
                    </TableCell>
                    <TableCell>
                      {r.status === "invalid" ? (
                        <Badge variant="danger">Refused</Badge>
                      ) : r.status === "replace" ? (
                        <Badge variant="warning" title="Replaces the value stored now, which is never shown">Replaces</Badge>
                      ) : (
                        <Badge variant="success">New</Badge>
                      )}
                    </TableCell>
                    <TableCell className="pr-3">
                      {r.status !== "invalid" && (
                        <label className="inline-flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={isBuild(r.key, r.build)}
                            onChange={(e) => onBuild(r.key, e.target.checked)}
                            className="size-4 rounded border-input accent-primary"
                          />
                          <span className="sr-only">{r.key}</span>
                          {looksSecret(r.key) && isBuild(r.key, r.build) && <Badge variant="danger">looks secret</Badge>}
                        </label>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {importable.some((r) => isBuild(r.key, r.build)) && (
          <Notice tone="warning" title="Build-time values are baked in">
            {BUILD_WARNING}
          </Notice>
        )}
      </div>
  );
}
