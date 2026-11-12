"use client";

import { useId } from "react";
import { Notice } from "@/components/states";
import { Label } from "@/components/ui/label";
import { BUILD_WARNING, looksSecret } from "@/lib/env-core";

/** "Available at build time": the checkbox and the warning that goes with it, always visible, stronger for a name that looks like a secret. */
export function BuildField({ name, checked, onChange, disabled }: { name: string; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          aria-describedby={`${id}-warning`}
          className="size-4 rounded border-input accent-primary"
        />
        <Label htmlFor={id}>Available at build time</Label>
      </div>
      <p id={`${id}-warning`} className="rounded-md border border-warning/25 bg-warning/10 px-3 py-2 text-xs text-warning-text">
        {BUILD_WARNING}
      </p>
      {checked && looksSecret(name) && (
        <Notice tone="warning" title="This name looks like a secret">
          Untick this unless {name} is meant to be public. Everything ticked here ends up in the image.
        </Notice>
      )}
    </div>
  );
}
