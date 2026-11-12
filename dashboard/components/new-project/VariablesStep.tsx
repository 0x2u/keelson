"use client";

import { FileUpIcon } from "lucide-react";
import { ICONS } from "@/lib/icons";
import Link from "next/link";
import { useId, useRef, useState } from "react";
import { Notice } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ERROR_TEXT, TextAreaField, TextField } from "@/components/forms/fields";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { EnvIssue } from "@/lib/agent-types";
import { BUILD_WARNING, keyIssue, looksSecret, suggestsBuild, valueIssue, type EnvRules } from "@/lib/env-core";
import type { ProjectVar } from "@/lib/new-project-core";
import { pasteVars, pendingVariable, putVar, removeVar, setVarBuild, type VariablesPaste } from "@/lib/new-project-wizard-core";

/** What stands in place of a value, always the same whatever the value is. */
export const MASK = "••••••••";

const MAX_FILE = 1024 * 1024;

/**
 * The variables the project starts with. The values live in the wizard's memory (React state) until Create and are
 * never shown again: the list shows names and a mask, the review lists names, and nothing is put in the address, the
 * browser's storage or a cookie. Optional: skipping this step creates the project without variables.
 */
export function VariablesStep({
  vars,
  onChange,
  rules,
  supported,
  serverId,
  serverName,
  issues,
  forImage = false,
}: {
  vars: ProjectVar[];
  onChange: (vars: ProjectVar[]) => void;
  rules: EnvRules;
  /** The agent has the variables API; without it the step is disabled. */
  supported: boolean;
  serverId: string;
  serverName: string;
  /** What a first attempt to create found wrong, by name. */
  issues: EnvIssue[];
  /** A project from an image: nothing is built, so no variable is a build argument and the build-time column and warnings are left out. */
  forImage?: boolean;
}) {
  const id = useId();
  const file = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [paste, setPaste] = useState<Omit<VariablesPaste, "vars"> | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);

  if (!supported) {
    return (
      <Notice
        tone="warning"
        title="This agent is too old to manage variables"
        action={
          <Link href={`/servers/${serverId}/update`} className="text-sm font-medium underline underline-offset-4">
            Update the agent
          </Link>
        }
      >
        Variables set from here need a newer Keelson agent on {serverName}. You can create the project without them and add them once the agent is updated.
      </Notice>
    );
  }

  const name = key.trim();
  const nameProblem = name === "" ? null : keyIssue(name, rules);
  const valueProblem = valueIssue(value);
  const replaces = vars.some((v) => v.key === name);

  const addOne = () => {
    setTouched(true);
    if (name === "" || keyIssue(name, rules) !== null || valueIssue(value) !== null) return;
    onChange(forImage ? putVar(vars, { key: name, value }).map((v) => ({ ...v, build: false })) : putVar(vars, { key: name, value }));
    setKey("");
    setValue("");
    setTouched(false);
  };
  const addText = (source: string) => {
    const out = pasteVars(vars, source, rules);
    const { vars: next, ...rest } = out;
    onChange(forImage ? next.map((v) => ({ ...v, build: false })) : next);
    setPaste(rest);
    setText("");
  };
  const addPasted = () => addText(text);
  // What is typed or pasted is kept when the field is left: a value must not be lost because "Add" was not clicked.
  const keepPasted = () => {
    if (text.trim() !== "") addText(text);
  };
  const keepOne = () => {
    const next = pendingVariable(vars, key, value, rules);
    if (next === null) return;
    onChange(forImage ? next.map((v) => ({ ...v, build: false })) : next);
    setKey("");
    setValue("");
    setTouched(false);
  };
  const readFile = async (f: File | undefined) => {
    setFileError(null);
    if (!f) return;
    if (f.size > MAX_FILE) {
      setFileError("That file is larger than 1 MiB: it is not a .env file.");
      return;
    }
    addText(await f.text());
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Optional. Variables are stored on {serverName}, in files only the agent can read, and set <strong>before</strong> the first {forImage ? "deployment" : "build"}. A value is write-only: once the project is created it is never shown again, and until
        then it stays in this page&apos;s memory, not in the address bar or the browser&apos;s storage. What you paste or type is added to the list as soon as you leave the field.
      </p>

      <div className="grid gap-3 rounded-lg border p-4">
        <TextAreaField
          id={`${id}-paste`}
          label="Paste a .env file"
          value={text}
          onChange={setText}
          onBlur={keepPasted}
          rows={5}
          placeholder={"# comments are ignored\nDATABASE_URL=postgres://…\nNEXT_PUBLIC_API=\"https://example.com\""}
          autoCapitalize="off"
          mono
          inputClassName="max-h-56 text-xs"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" disabled={text.trim() === ""} onClick={addPasted}>
            <ICONS.add />
            Add the variables
          </Button>
          <input ref={file} type="file" className="sr-only" tabIndex={-1} aria-label="Choose a .env file" onChange={(e) => void readFile(e.target.files?.[0])} />
          <Button type="button" variant="outline" size="sm" onClick={() => file.current?.click()}>
            <FileUpIcon />
            Choose a file
          </Button>
          {fileError && <span className={ERROR_TEXT}>{fileError}</span>}
        </div>
        {paste && <PasteReport report={paste} />}
      </div>

      <div
        className="grid gap-3 rounded-lg border p-4"
        onBlur={(e) => {
          // Leaving the whole form (not moving from the name to the value) keeps what was typed.
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) keepOne();
        }}
      >
        <p className="text-sm font-medium">Add one variable</p>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] sm:items-end">
          <TextField
            id={`${id}-key`}
            label="Name"
            value={key}
            onChange={setKey}
            placeholder="DATABASE_URL"
            autoCapitalize="off"
            mono
            error={touched && nameProblem !== null ? nameProblem : undefined}
          />
          <TextField
            id={`${id}-value`}
            label="Value"
            type="password"
            value={value}
            onChange={setValue}
            autoComplete="new-password"
            autoCapitalize="off"
            mono
            error={valueProblem ?? undefined}
          />
          <Button type="button" onClick={addOne} disabled={name === ""}>
            <ICONS.add />
            Add
          </Button>
        </div>
        {replaces && name !== "" && <p className="text-xs text-muted-foreground">{name} is in the list already: adding it replaces its value.</p>}
        {!forImage && name !== "" && suggestsBuild(name) && <p className="text-xs text-muted-foreground">Names starting with NEXT_PUBLIC_, VITE_ or PUBLIC_ start with &ldquo;Available at build time&rdquo; on: frameworks read them while building.</p>}
      </div>

      {issues.length > 0 && (
        <Notice title="Some variables cannot be used">
          <ul className="list-disc pl-4">
            {issues.map((i, n) => (
              <li key={n}>
                {i.key !== "" && <span className="font-mono">{i.key}</span>} {i.message}
              </li>
            ))}
          </ul>
        </Notice>
      )}

      <VariableList vars={vars} onChange={onChange} showBuild={!forImage} />
    </div>
  );
}

function PasteReport({ report }: { report: Omit<VariablesPaste, "vars"> }) {
  return (
    <div className="grid gap-2 text-sm" data-testid="paste-report">
      <p className="text-muted-foreground">
        {report.added} variable{report.added === 1 ? "" : "s"} added{report.replaced.length > 0 ? `, ${report.replaced.length} replaced` : ""}.
      </p>
      {report.refused.length > 0 && (
        <Notice tone="warning" title="Some names were left out">
          <ul className="list-disc pl-4">
            {report.refused.map((r) => (
              <li key={r.key}>
                <span className="font-mono">{r.key}</span> {r.reason}
              </li>
            ))}
          </ul>
        </Notice>
      )}
      {report.unreadable.length > 0 && (
        <Notice tone="warning" title={`${report.unreadable.length} line${report.unreadable.length === 1 ? "" : "s"} could not be read`}>
          <ul className="list-disc pl-4">
            {report.unreadable.map((p) => (
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
      {report.repeated.length > 0 && (
        <Notice tone="info" title="Some names appear more than once">
          The last value of each is used: {report.repeated.map((k, i) => (
            <span key={k}>
              {i > 0 && ", "}
              <span className="font-mono">{k}</span>
            </span>
          ))}
          .
        </Notice>
      )}
    </div>
  );
}

/** The list: names, a mask where the value would be, the build-time box and a way to remove. Pure markup from the state: a value is never an attribute or a text. */
export function VariableList({ vars, onChange, showBuild = true }: { vars: ProjectVar[]; onChange: (vars: ProjectVar[]) => void; showBuild?: boolean }) {
  if (vars.length === 0) {
    return (
      <Notice tone="info" title="No variable yet">
        Nothing is needed to continue: create the project without variables, or add them later from the app&apos;s Variables page.
      </Notice>
    );
  }
  return (
    <div className="grid gap-3">
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-3">Name</TableHead>
              <TableHead className="hidden sm:table-cell">Value</TableHead>
              {showBuild && <TableHead title="Available at build time">Build</TableHead>}
              <TableHead className="pr-3">
                <span className="sr-only">Remove</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {vars.map((v) => (
              <TableRow key={v.key}>
                <TableCell className="pl-3 whitespace-normal">
                  <span className="font-mono text-xs break-all">{v.key}</span>
                </TableCell>
                <TableCell className="hidden text-muted-foreground sm:table-cell" aria-label="hidden value">
                  {MASK}
                </TableCell>
                {showBuild && (
                  <TableCell>
                    <label className="inline-flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={v.build} onChange={(e) => onChange(setVarBuild(vars, v.key, e.target.checked))} className="size-4 rounded border-input accent-primary" />
                      <span className="sr-only">Available at build time: {v.key}</span>
                      {v.build && looksSecret(v.key) && <Badge variant="danger">looks secret</Badge>}
                    </label>
                  </TableCell>
                )}
                <TableCell className="pr-3 text-right">
                  <Button type="button" variant="ghost" size="sm" onClick={() => onChange(removeVar(vars, v.key))} aria-label={`Remove ${v.key}`}>
                    <ICONS.remove />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {showBuild && (
        <p className="rounded-md border border-warning/25 bg-warning/10 px-3 py-2 text-xs text-warning-text">
          <strong>Available at build time.</strong> {BUILD_WARNING}
        </p>
      )}
    </div>
  );
}
