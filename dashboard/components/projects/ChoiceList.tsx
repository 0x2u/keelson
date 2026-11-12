"use client";

import type { ReactNode } from "react";
import { FieldShell } from "@/components/forms/fields";
import { cn } from "@/lib/utils";

export interface Choice {
  value: string;
  label: ReactNode;
  /** What to say under the label: where it runs, or why it cannot be chosen. */
  detail?: ReactNode;
  disabled?: boolean;
}

/**
 * One choice among a few, each a row that says what it is (and why it cannot be chosen): the picker of the "Add app" and
 * "Add environment" dialogs. Native radios, so the arrow keys move between the rows.
 */
export function ChoiceList({
  id,
  label,
  choices,
  value,
  onChange,
  error,
}: {
  id: string;
  label: ReactNode;
  choices: Choice[];
  value: string;
  onChange: (value: string) => void;
  error?: string;
}) {
  return (
    <FieldShell id={id} label={label} error={error} group>
      <div role="radiogroup" aria-labelledby={`${id}-label`} className="max-h-64 divide-y overflow-y-auto rounded-md border" data-testid="choice-list">
        {choices.map((c) => (
          <label
            key={c.value}
            className={cn(
              "flex cursor-pointer items-start gap-3 px-3 py-2 text-sm has-[:checked]:bg-muted has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50 has-[:focus-visible]:ring-inset",
              c.disabled && "cursor-not-allowed text-muted-foreground",
            )}
          >
            <input type="radio" name={id} value={c.value} checked={value === c.value} disabled={c.disabled} onChange={() => onChange(c.value)} className="mt-0.5 size-4 shrink-0 accent-primary" />
            <span className="min-w-0">
              <span className="block font-medium break-words">{c.label}</span>
              {c.detail && <span className="block text-xs text-muted-foreground">{c.detail}</span>}
            </span>
          </label>
        ))}
      </div>
    </FieldShell>
  );
}
