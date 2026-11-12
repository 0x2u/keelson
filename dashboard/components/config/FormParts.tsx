"use client";

import { ArrowDownIcon, ArrowUpIcon, CircleAlertIcon, EyeIcon, EyeOffIcon, SaveIcon } from "lucide-react";
import { ICONS } from "@/lib/icons";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { IssuesList } from "@/components/config/IssuesList";
import { describeField, FieldShell, TextField } from "@/components/forms/fields";
import { Notice } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { HIDDEN, type ConfigIssue } from "@/lib/agent-types";
import { cn } from "@/lib/utils";

// ---- Validation and shaping helpers -----------------------------------------------------------------------------------

/** Names of apps and jobs: they end up in URLs, container names and the YAML keys. */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export const NAME_HINT = "Lowercase letters, digits, - and _; start with a letter or digit; up to 63 characters.";

export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const ENV_NAME_HINT = "Letters, digits and _, not starting with a digit.";

const DURATION = /^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/;

export const DURATION_HINT = "A number and a unit, for example 90s, 5m or 1h30m.";

/** Trimmed, with empty entries dropped: what an optional list field submits. */
export function compact(values: string[]): string[] {
  return values.map((v) => v.trim()).filter((v) => v !== "");
}

/** The trimmed text, or undefined when empty, so that empty optional fields are left out of the JSON. */
export function optionalText(value: string): string | undefined {
  const text = value.trim();
  return text === "" ? undefined : text;
}

/** The trimmed list, or undefined when it has no entries. */
export function optionalList(values: string[]): string[] | undefined {
  const list = compact(values);
  return list.length === 0 ? undefined : list;
}

export function durationError(value: string): string | undefined {
  const text = value.trim();
  if (text === "" || DURATION.test(text)) return undefined;
  return `Not a duration. ${DURATION_HINT}`;
}

export function integerError(value: string, what: string, min: number, max: number): string | undefined {
  const text = value.trim();
  if (text === "") return undefined;
  if (!/^\d+$/.test(text)) return `${what} must be a whole number.`;
  const n = Number(text);
  if (n < min || n > max) return `${what} must be between ${min} and ${max}.`;
  return undefined;
}

/** The whole number in a text field, or undefined when the field is empty or not a number. */
export function toInteger(value: string): number | undefined {
  const text = value.trim();
  return /^\d+$/.test(text) ? Number(text) : undefined;
}

/** Why a string list has an empty entry between filled ones, or is empty when it must not be. */
export function listRequiredError(values: string[], what: string): string | undefined {
  return compact(values).length === 0 ? `Add at least one ${what}.` : undefined;
}

// ---- What the agent reported about one entity -------------------------------------------------------------------------

/**
 * The agent's error issues that name a field of one entity, keyed by the field: `apps[web].env` under entity
 * `apps[web]` is key `env`. Used to mark the field or section the agent is complaining about.
 */
export function fieldIssues(issues: ConfigIssue[], entity: string): Record<string, string> {
  const byField: Record<string, string> = {};
  for (const issue of issues) {
    if (issue.severity !== "error" || !issue.path.startsWith(`${entity}.`)) continue;
    const field = issue.path.slice(entity.length + 1).split(/[.[]/, 1)[0];
    byField[field] = byField[field] ? `${byField[field]} ${issue.message}` : issue.message;
  }
  return byField;
}

/** The agent's messages for any of the given fields, joined; undefined when it said nothing about them. */
export function sectionProblems(server: Record<string, string>, fields: string[]): string | undefined {
  const messages = fields.flatMap((f) => (server[f] ? [server[f]] : []));
  return messages.length === 0 ? undefined : messages.join(" ");
}

export interface FieldErrors {
  /** The message to show for a field: ours once the field was visited or a save was attempted, the agent's always. */
  error(field: string): string | undefined;
  touch(field: string): void;
  /** A save was attempted: show every error. */
  touchAll(): void;
  submitted: boolean;
}

/** Validation as you type: a field's own error appears after it was left, every error appears after a save attempt. */
export function useFieldErrors(local: Record<string, string>, server: Record<string, string>): FieldErrors {
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitted, setSubmitted] = useState(false);
  return {
    error: (field) => (submitted || touched[field] ? local[field] : undefined) ?? server[field],
    touch: (field) => setTouched((prev) => (prev[field] ? prev : { ...prev, [field]: true })),
    touchAll: () => setSubmitted(true),
    submitted,
  };
}

/** Moves focus to the first field marked invalid, after the errors rendered. */
export function focusFirstInvalid(form: HTMLFormElement | null) {
  requestAnimationFrame(() => form?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
}

// ---- Layout -----------------------------------------------------------------------------------------------------------

/**
 * One card of a form. `flagged` marks it as holding fields the agent complained about; `problems` is for complaints
 * that no single field shows, and is printed in the header.
 */
export function FormSection({
  title,
  description,
  flagged,
  problems,
  children,
}: {
  title: string;
  description?: ReactNode;
  flagged?: boolean;
  problems?: string;
  children: ReactNode;
}) {
  const marked = flagged || Boolean(problems);
  return (
    <Card className={cn(marked && "border-destructive/60")}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {title}
          {marked && (
            <Badge variant="danger">
              <CircleAlertIcon aria-hidden />
              Needs attention
            </Badge>
          )}
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        {problems && (
          <p role="alert" className="text-sm font-medium text-destructive-text">
            {problems}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-5">{children}</CardContent>
    </Card>
  );
}

/** Save and Cancel, stuck to the bottom of the viewport so they stay reachable on a long form. */
export function FormFooter({ pending, saveLabel, cancelHref }: { pending: boolean; saveLabel: string; cancelHref: string }) {
  return (
    <div className="sticky bottom-0 z-10 flex items-center justify-end gap-2 border-t bg-background/90 py-3 backdrop-blur">
      <Button asChild variant="outline">
        <Link href={cancelHref}>Cancel</Link>
      </Button>
      <Button type="submit" loading={pending}>
        <SaveIcon />
        {pending ? "Saving…" : saveLabel}
      </Button>
    </div>
  );
}

/** What went wrong with a save, above the form: the agent's issues when it sent any, otherwise the message. */
export function SaveProblems({ issues, message }: { issues: ConfigIssue[]; message?: string }) {
  if (issues.length === 0 && !message) return null;
  return (
    <Notice title="The agent did not accept this configuration">
      {issues.length > 0 ? <IssuesList issues={issues} /> : message}
    </Notice>
  );
}

/** Shown after a save attempt with errors in the form itself. */
export function FixFieldsNotice({ count }: { count: number }) {
  return (
    <Notice title="Not saved yet">
      {count === 1 ? "One field needs attention." : `${count} fields need attention.`} Fix the fields marked below, then save again.
    </Notice>
  );
}

// ---- Inputs -----------------------------------------------------------------------------------------------------------

/** A duration such as 90s or 5m, checked as you type. */
export function DurationField({
  id,
  label,
  help,
  error,
  value,
  onChange,
  onBlur,
  placeholder = "90s",
}: {
  id: string;
  label: ReactNode;
  help?: ReactNode;
  error?: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
}) {
  return (
    <TextField
      id={id}
      label={label}
      help={help ?? DURATION_HINT}
      error={error}
      value={value}
      onChange={onChange}
      onBlur={onBlur}
      placeholder={placeholder}
      mono
    />
  );
}

// ---- Lists ------------------------------------------------------------------------------------------------------------

/** An ordered list of single-line values (ports, command arguments...). Empty entries are dropped on save. */
export function StringListField({
  id,
  label,
  help,
  error,
  values,
  onChange,
  onBlur,
  placeholder,
  addLabel = "Add",
  required,
  mono = true,
}: {
  id: string;
  label: string;
  help?: ReactNode;
  error?: string;
  values: string[];
  onChange: (values: string[]) => void;
  onBlur?: () => void;
  placeholder?: string;
  addLabel?: string;
  required?: boolean;
  mono?: boolean;
}) {
  const [focusIndex, setFocusIndex] = useState<number | null>(null);

  return (
    <FieldShell id={id} label={label} help={help} error={error} required={required} group>
      <div className="space-y-2">
        {values.map((value, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              value={value}
              onChange={(event) => onChange(values.map((v, j) => (j === i ? event.target.value : v)))}
              onBlur={onBlur}
              placeholder={placeholder}
              aria-label={`${label} ${i + 1}`}
              autoComplete="off"
              spellCheck={false}
              autoFocus={i === focusIndex}
              className={cn(mono && "font-mono")}
              id={`${id}-${i}`}
              aria-invalid={error ? true : undefined}
              aria-describedby={describeField(id, Boolean(help), error)["aria-describedby"]}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${label} ${i + 1}`}
              onClick={() => onChange(values.filter((_, j) => j !== i))}
            >
              <ICONS.remove />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setFocusIndex(values.length);
            onChange([...values, ""]);
          }}
        >
          <ICONS.add />
          {addLabel}
        </Button>
      </div>
    </FieldShell>
  );
}

/** Moves the item at `index` by `delta` places; returns the list unchanged when it would leave the list. */
export function moveItem<T>(list: T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (target < 0 || target >= list.length) return list;
  const next = list.slice();
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** Up, down and remove for one entry of an ordered list. */
export function ReorderButtons({
  noun,
  index,
  count,
  onMove,
  onRemove,
}: {
  noun: string;
  index: number;
  count: number;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move ${noun} up`} disabled={index === 0} onClick={() => onMove(-1)}>
        <ArrowUpIcon />
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move ${noun} down`} disabled={index === count - 1} onClick={() => onMove(1)}>
        <ArrowDownIcon />
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${noun}`} onClick={onRemove}>
        <ICONS.remove />
      </Button>
    </div>
  );
}

// ---- Secrets ----------------------------------------------------------------------------------------------------------

/**
 * A write-only value. The agent never sends a secret: it sends HIDDEN, which shows as "Set" with a Replace button, and
 * sending HIDDEN back keeps the stored value. `stored` tells whether the agent holds a value for this field.
 */
export function SecretValueInput({
  id,
  label,
  value,
  onChange,
  onBlur,
  stored,
  invalid,
  describedBy,
  multiline,
  masked = !multiline,
  placeholder,
}: {
  id: string;
  /** The accessible name, also used by the Replace and Show buttons. */
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  stored: boolean;
  invalid?: boolean;
  describedBy?: string;
  multiline?: boolean;
  masked?: boolean;
  placeholder?: string;
}) {
  const [shown, setShown] = useState(false);

  if (stored && value === HIDDEN) {
    return (
      <div className="flex min-h-9 items-center gap-3">
        <Badge variant="success">
          <ICONS.secret aria-hidden />
          Set
        </Badge>
        <Button type="button" variant="outline" size="sm" aria-label={`Replace ${label}`} onClick={() => onChange("")}>
          Replace
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2">
      {multiline ? (
        <Textarea
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          rows={4}
          placeholder={placeholder}
          aria-label={label}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={describedBy}
          autoComplete="off"
          spellCheck={false}
          autoFocus={stored}
          className="font-mono text-xs"
        />
      ) : (
        <Input
          id={id}
          type={masked && !shown ? "password" : "text"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          placeholder={placeholder}
          aria-label={label}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={describedBy}
          autoComplete="off"
          spellCheck={false}
          autoFocus={stored}
          className="font-mono"
        />
      )}
      {masked && !multiline && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`${shown ? "Hide" : "Show"} ${label}`}
          aria-pressed={shown}
          onClick={() => setShown(!shown)}
        >
          {shown ? <EyeOffIcon /> : <EyeIcon />}
        </Button>
      )}
      {stored && (
        <Button type="button" variant="ghost" size="sm" aria-label={`Keep the stored ${label}`} onClick={() => onChange(HIDDEN)}>
          Keep current
        </Button>
      )}
    </div>
  );
}

/** A row of a key/value table. `stored` rows came from the agent with a hidden value: their key cannot be renamed. */
export interface KeyValueRow {
  key: string;
  value: string;
  stored: boolean;
  /** A stored row marked for removal: kept in the list so it can be restored until the form is saved. */
  removed: boolean;
}

export function keyValueRows(record: Record<string, string> | undefined): KeyValueRow[] {
  return Object.entries(record ?? {}).map(([key, value]) => ({ key, value, stored: value === HIDDEN, removed: false }));
}

/** The record to submit: removed and blank-keyed rows left out, hidden values passed back unchanged; undefined when empty. */
export function keyValueRecord(rows: KeyValueRow[]): Record<string, string> | undefined {
  const entries = rows.filter((r) => !r.removed && r.key.trim() !== "").map((r) => [r.key.trim(), r.value] as const);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/** The first thing wrong with a key/value table, or undefined. */
export function keyValueError(rows: KeyValueRow[], noun: string, keyPattern: RegExp, keyHint: string): string | undefined {
  const seen: Record<string, boolean> = {};
  for (const row of rows) {
    if (row.removed) continue;
    const key = row.key.trim();
    if (key === "") {
      if (row.value !== "") return `Give each ${noun} a name.`;
      continue;
    }
    if (!keyPattern.test(key)) return `"${key}" is not a valid ${noun} name. ${keyHint}`;
    if (seen[key]) return `"${key}" appears twice.`;
    seen[key] = true;
    if (row.value === "") return `Enter a value for ${key}, or remove it.`;
    if (row.value === HIDDEN && !row.stored) return `Enter a value for ${key}.`;
  }
  return undefined;
}

/**
 * A table of names and write-only values. Existing values arrive hidden and show as Set; removing a stored entry is
 * explicit and can be undone until the form is saved.
 */
export function KeyValueField({
  id,
  label,
  noun,
  help,
  error,
  rows,
  onChange,
  onBlur,
  keyPlaceholder,
  keyList,
  addLabel,
}: {
  id: string;
  label: string;
  /** What one row is: "variable", "header". */
  noun: string;
  help?: ReactNode;
  error?: string;
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  onBlur?: () => void;
  keyPlaceholder?: string;
  keyList?: string;
  addLabel: string;
}) {
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const describedBy = describeField(id, Boolean(help), error)["aria-describedby"];

  function update(index: number, patch: Partial<KeyValueRow>) {
    onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  return (
    <FieldShell id={id} label={label} help={help} error={error} group>
      <div className="space-y-2">
        {rows.map((row, i) =>
          row.removed ? (
            <div key={i} className="flex items-center justify-between gap-2 rounded-md border border-dashed px-3 py-1.5 text-sm">
              <span className="min-w-0">
                <span className="font-mono line-through">{row.key}</span>
                <span className="ml-2 text-muted-foreground">will be removed when you save</span>
              </span>
              <Button type="button" variant="ghost" size="sm" aria-label={`Keep ${noun} ${row.key}`} onClick={() => update(i, { removed: false })}>
                <ICONS.rollback />
                Undo
              </Button>
            </div>
          ) : (
            <div key={i} className="grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] sm:items-start">
              <Input
                value={row.key}
                onChange={(event) => update(i, { key: event.target.value })}
                onBlur={onBlur}
                readOnly={row.stored}
                placeholder={keyPlaceholder}
                list={keyList}
                aria-label={`Name of ${noun} ${i + 1}`}
                aria-invalid={error ? true : undefined}
                aria-describedby={describedBy}
                autoComplete="off"
                spellCheck={false}
                autoFocus={i === focusIndex}
                className={cn("font-mono", row.stored && "bg-muted text-muted-foreground")}
              />
              <SecretValueInput
                id={`${id}-value-${i}`}
                label={`value of ${row.key || `new ${noun}`}`}
                value={row.value}
                onChange={(value) => update(i, { value })}
                onBlur={onBlur}
                stored={row.stored}
                invalid={Boolean(error)}
                describedBy={describedBy}
                placeholder="Value"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${noun} ${row.key || i + 1}`}
                onClick={() => (row.stored ? update(i, { removed: true }) : onChange(rows.filter((_, j) => j !== i)))}
              >
                <ICONS.remove />
              </Button>
            </div>
          ),
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setFocusIndex(rows.length);
            onChange([...rows, { key: "", value: "", stored: false, removed: false }]);
          }}
        >
          <ICONS.add />
          {addLabel}
        </Button>
      </div>
    </FieldShell>
  );
}
