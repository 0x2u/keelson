"use client";

import { useId, useState } from "react";
import { BuildField } from "@/components/environment/BuildField";
import { useEnvSave } from "@/components/environment/useEnvSave";
import { Notice } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TextAreaField, TextField } from "@/components/forms/fields";
import { StepUpAction } from "@/components/unlock";
import type { EnvScope, EnvVar } from "@/lib/agent-types";
import { keyIssue, suggestsBuild, valueIssue, type EnvRules } from "@/lib/env-core";

interface Target {
  serverId: string;
  app: string;
  scope: EnvScope;
  servingImage: string;
}

/**
 * Adds a variable, or (with `existing`) replaces the value of one. The old value is never shown: the field starts empty,
 * and for a replacement an empty field keeps the stored value and changes only the build flag. The typed value is cleared
 * as soon as the dialog closes.
 */
export function VariableDialog({
  target,
  rules,
  stored,
  existing,
  open,
  onOpenChange,
}: {
  target: Target;
  rules: EnvRules;
  /** The names already stored, to say that a name replaces one. */
  stored: EnvVar[];
  existing?: EnvVar;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const id = useId();
  const [key, setKey] = useState(existing?.key ?? "");
  const [value, setValue] = useState("");
  const [build, setBuild] = useState(existing?.build ?? false);
  const [buildTouched, setBuildTouched] = useState(existing !== undefined);
  const [touched, setTouched] = useState(false);
  const { save, pending, failure, clearFailure } = useEnvSave(target);

  const name = key.trim();
  const keyProblem = existing ? null : keyIssue(name, rules);
  const valueProblem = valueIssue(value);
  const replaces = existing !== undefined || stored.some((v) => v.key === name);
  const keepsValue = existing !== undefined && value === "";
  const nothingChanged = keepsValue && build === existing.build;
  const canSubmit = keyProblem === null && valueProblem === null && !nothingChanged && !pending;

  const close = (next: boolean) => {
    if (pending) return;
    if (!next) {
      setValue("");
      clearFailure();
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form
          noValidate
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setTouched(true);
            if (!canSubmit) return;
            save([{ key: name, value: keepsValue ? null : value, build }], [], () => {
              setValue("");
              onOpenChange(false);
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>{existing ? `Replace ${existing.key}` : "Add a variable"}</DialogTitle>
            <DialogDescription>
              {existing
                ? "The current value is never shown. Type the new one; leave the field empty to keep the current value."
                : "The value is stored on the server, in a file only the agent can read. Once saved it is never shown again."}
            </DialogDescription>
          </DialogHeader>

          <TextField
            id={`${id}-key`}
            label="Name"
            value={key}
            onChange={(next) => {
              setKey(next);
              if (!buildTouched) setBuild(suggestsBuild(next.trim()));
            }}
            onBlur={() => setTouched(true)}
            placeholder="DATABASE_URL"
            autoCapitalize="off"
            disabled={existing !== undefined}
            autoFocus={existing === undefined}
            mono
            error={touched && keyProblem !== null ? keyProblem : undefined}
            help={existing === undefined && replaces && name !== "" ? `${name} already has a value: saving replaces it.` : undefined}
          />

          <TextAreaField
            id={`${id}-value`}
            label={existing ? "New value" : "Value"}
            optional={existing !== undefined}
            value={value}
            onChange={setValue}
            rows={3}
            placeholder={existing ? "Leave empty to keep the current value" : undefined}
            autoCapitalize="off"
            autoFocus={existing !== undefined}
            mono
            error={valueProblem ?? undefined}
          />

          <BuildField
            name={name}
            checked={build}
            onChange={(next) => {
              setBuild(next);
              setBuildTouched(true);
            }}
          />

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
            <Button type="button" variant="outline" onClick={() => close(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" loading={pending} disabled={!canSubmit}>
              {existing ? "Replace value" : "Save variable"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
