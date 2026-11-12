"use client";

import { ICONS } from "@/lib/icons";
import { Switch as SwitchPrimitive } from "radix-ui";
import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

// One form convention for the whole dashboard: every field is a `FieldShell` (a label, the control, its help and its
// error, wired with aria-describedby / aria-invalid), and every form lists all of its errors at once (`noValidate`,
// errors from validation, never the browser's one-at-a-time bubbles).
//
// Required or optional: a form marks the minority. A form whose fields are nearly all needed (a login, a token, a
// connection) marks the exceptions with `optional` ("(optional)"); a long configuration form where almost everything
// has a default marks the exceptions with `required` ("(required)"). A form never uses both.

/** The attributes that tie an input to its help text and its error message. */
export function describeField(id: string, help: boolean, error: string | undefined) {
  const ids: string[] = [];
  if (help) ids.push(`${id}-help`);
  if (error) ids.push(`${id}-error`);
  return {
    id,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": ids.length > 0 ? ids.join(" ") : undefined,
  };
}

const LABEL_CLASS = "text-sm leading-none font-medium select-none";

/** The small error text under a field: the `-text` shade, because the plain shade fails contrast at this size. */
export const ERROR_TEXT = "text-xs font-medium text-destructive-text";

/** A label, the control, its help text and its error. `group` is for controls made of several inputs. */
export function FieldShell({
  id,
  label,
  help,
  error,
  required,
  optional,
  group,
  className,
  children,
}: {
  id: string;
  label: ReactNode;
  help?: ReactNode;
  error?: string;
  /** Marks the label "(required)": for forms where most fields are optional. */
  required?: boolean;
  /** Marks the label "(optional)": for forms where most fields are needed. */
  optional?: boolean;
  group?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const heading = (
    <>
      {label}
      {required && <span className="font-normal text-muted-foreground">(required)</span>}
      {!required && optional && <span className="font-normal text-muted-foreground">(optional)</span>}
    </>
  );
  const notes = (
    <>
      {help && (
        <p id={`${id}-help`} className="text-xs text-muted-foreground">
          {help}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className={ERROR_TEXT}>
          {error}
        </p>
      )}
    </>
  );
  if (group) {
    return (
      <div
        role="group"
        aria-labelledby={`${id}-label`}
        aria-describedby={describeField(id, Boolean(help), error)["aria-describedby"]}
        className={cn("space-y-2", className)}
      >
        <span id={`${id}-label`} className={cn(LABEL_CLASS, "flex items-center gap-2")}>
          {heading}
        </span>
        {children}
        {notes}
      </div>
    );
  }
  return (
    <div className={cn("space-y-2", className)}>
      <Label htmlFor={id}>{heading}</Label>
      {children}
      {notes}
    </div>
  );
}

type InputRest = Omit<ComponentProps<typeof Input>, "id" | "value" | "onChange" | "className" | "aria-invalid" | "aria-describedby">;

/**
 * A labelled single-line text field. Controlled with `value` and `onChange` (numbers are kept as text and parsed on
 * save), or uncontrolled with `name` and `defaultValue` for a form that submits to an action. Any other input attribute
 * (`type`, `maxLength`, `autoComplete`, `disabled`...) is passed on.
 */
export function TextField({
  id,
  label,
  help,
  error,
  required,
  optional,
  value,
  onChange,
  mono,
  readOnly,
  className,
  inputClassName,
  ...input
}: {
  id: string;
  label: ReactNode;
  help?: ReactNode;
  error?: string;
  required?: boolean;
  optional?: boolean;
  value?: string;
  onChange?: (value: string) => void;
  mono?: boolean;
  readOnly?: boolean;
  className?: string;
  inputClassName?: string;
} & InputRest) {
  return (
    <FieldShell id={id} label={label} help={help} error={error} required={required} optional={optional} className={className}>
      <Input
        autoComplete="off"
        spellCheck={false}
        {...input}
        {...(value === undefined ? {} : { value })}
        onChange={onChange && ((event) => onChange(event.target.value))}
        readOnly={readOnly}
        className={cn(mono && "font-mono", readOnly && "bg-muted text-muted-foreground", inputClassName)}
        {...describeField(id, Boolean(help), error)}
      />
    </FieldShell>
  );
}

/** A labelled multi-line text field; controlled or uncontrolled like `TextField`. */
export function TextAreaField({
  id,
  label,
  help,
  error,
  required,
  optional,
  value,
  onChange,
  mono,
  className,
  inputClassName,
  rows = 4,
  ...area
}: {
  id: string;
  label: ReactNode;
  help?: ReactNode;
  error?: string;
  required?: boolean;
  optional?: boolean;
  value?: string;
  onChange?: (value: string) => void;
  mono?: boolean;
  className?: string;
  inputClassName?: string;
} & Omit<ComponentProps<typeof Textarea>, "id" | "value" | "onChange" | "className" | "aria-invalid" | "aria-describedby">) {
  return (
    <FieldShell id={id} label={label} help={help} error={error} required={required} optional={optional} className={className}>
      <Textarea
        rows={rows}
        spellCheck={false}
        {...area}
        {...(value === undefined ? {} : { value })}
        onChange={onChange && ((event) => onChange(event.target.value))}
        className={cn(mono && "font-mono text-xs md:text-xs", inputClassName)}
        {...describeField(id, Boolean(help), error)}
      />
    </FieldShell>
  );
}

/**
 * A write-only secret for a form that submits to an action. A stored secret is never sent back, so it shows as "Set"
 * with a Replace button; an empty input means "keep". The input's `name` is the field id.
 */
export function WriteOnlySecretField({
  id,
  label,
  isSet,
  help,
  error,
  multiline,
  optional,
  extra,
}: {
  id: string;
  label: ReactNode;
  isSet: boolean;
  help?: ReactNode;
  error?: string;
  multiline?: boolean;
  optional?: boolean;
  extra?: ReactNode;
}) {
  const [replacing, setReplacing] = useState(false);
  const showInput = !isSet || replacing || Boolean(error);
  return (
    <FieldShell id={id} label={label} help={help} error={error} optional={optional}>
      {showInput ? (
        <div className="flex items-start gap-2">
          {multiline ? (
            <Textarea name={id} rows={4} autoComplete="off" spellCheck={false} className="font-mono text-xs" {...describeField(id, Boolean(help), error)} />
          ) : (
            <Input name={id} type="password" autoComplete="off" {...describeField(id, Boolean(help), error)} />
          )}
          {isSet && !error && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setReplacing(false)}>
              Keep current
            </Button>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <Badge variant="success">
            <ICONS.secret aria-hidden />
            Set
          </Badge>
          <Button type="button" variant="outline" size="sm" onClick={() => setReplacing(true)} aria-describedby={help ? `${id}-help` : undefined}>
            Replace
          </Button>
        </div>
      )}
      {extra}
    </FieldShell>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export function SelectField({
  id,
  label,
  help,
  error,
  value,
  onChange,
  options,
  placeholder,
  required,
  optional,
  className,
}: {
  id: string;
  label: ReactNode;
  help?: ReactNode;
  error?: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  required?: boolean;
  optional?: boolean;
  className?: string;
}) {
  return (
    <FieldShell id={id} label={label} help={help} error={error} required={required} optional={optional} className={className}>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full" {...describeField(id, Boolean(help), error)}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FieldShell>
  );
}

/** A choice between a few alternatives shown side by side; native radios give it arrow-key navigation. */
export function SegmentedControl({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
}) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap gap-0.5 rounded-lg bg-muted p-0.5">
      {options.map((o) => (
        <label
          key={o.value}
          className="cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors has-[:checked]:bg-background has-[:checked]:text-foreground has-[:checked]:shadow-xs has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50"
        >
          <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} className="sr-only" />
          {o.label}
        </label>
      ))}
    </div>
  );
}

export function SwitchField({
  id,
  label,
  help,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  help?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
      <div className="space-y-1.5">
        <Label htmlFor={id}>{label}</Label>
        {help && (
          <p id={`${id}-help`} className="text-xs text-muted-foreground">
            {help}
          </p>
        )}
      </div>
      <SwitchPrimitive.Root
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        aria-describedby={help ? `${id}-help` : undefined}
        className="inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent bg-input shadow-xs transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=checked]:bg-primary"
      >
        <SwitchPrimitive.Thumb className="pointer-events-none block size-4 translate-x-0 rounded-full bg-background shadow-sm transition-transform data-[state=checked]:translate-x-4" />
      </SwitchPrimitive.Root>
    </div>
  );
}

export function CheckboxField({
  id,
  label,
  help,
  checked,
  onChange,
}: {
  id: string;
  label: ReactNode;
  help?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        aria-describedby={help ? `${id}-help` : undefined}
        className="mt-0.5 size-4 shrink-0 accent-primary"
      />
      <div className="space-y-1">
        <Label htmlFor={id}>{label}</Label>
        {help && (
          <p id={`${id}-help`} className="text-xs text-muted-foreground">
            {help}
          </p>
        )}
      </div>
    </div>
  );
}
