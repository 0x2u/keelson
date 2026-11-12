"use client";

import { CheckIcon, ContainerIcon, TriangleIcon, ZapIcon } from "lucide-react";
import { ICONS } from "@/lib/icons";
import type { ComponentType } from "react";
import { SelectField, TextField } from "@/components/forms/fields";
import { Notice } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import type { DockerfileCandidate } from "@/lib/github-detect";
import { PRESET_LIST, type PresetIcon, type PresetId } from "@/lib/presets-core";
import type { ReviewErrors, ReviewInput } from "@/lib/repo-detect-core";
import { cn } from "@/lib/utils";

const PRESET_ICONS: Record<PresetIcon, ComponentType<{ className?: string }>> = { Triangle: TriangleIcon, Server: ICONS.server, Zap: ZapIcon, Globe: ICONS.domain, Container: ContainerIcon };

/** What was read from the repository when it was chosen: its Dockerfiles, ports and health checks. */
export type DockerfileLookupState = { status: "idle" } | { status: "loading" } | { status: "error"; error: string } | { status: "ready"; candidates: DockerfileCandidate[]; truncated: boolean };

/**
 * The cards come from the presets registry, in its order. The one the repository points to is selected when the
 * repository is chosen, with the reason shown, and the operator can pick another: a suggestion never replaces a click.
 */
export function FrameworkStep({
  preset,
  onChoose,
  lookup,
  suggested,
  input,
  candidate,
  onPick,
  onField,
  errors,
  idPrefix,
}: {
  preset: string;
  onChoose: (id: PresetId) => void;
  lookup: DockerfileLookupState;
  /** The card the repository points to, and why; null when nothing in it says. */
  suggested: { id: PresetId; reason: string } | null;
  input: Pick<ReviewInput, "dockerfile" | "context">;
  candidate: string;
  onPick: (path: string) => void;
  onField: (field: "dockerfile" | "context", value: string) => void;
  errors: ReviewErrors;
  idPrefix: string;
}) {
  return (
    <div className="space-y-6">
      <div role="radiogroup" aria-label="Framework" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {PRESET_LIST.map((p) => {
          const Icon = PRESET_ICONS[p.icon];
          const on = p.id === preset;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={on}
              data-preset={p.id}
              onClick={() => onChoose(p.id)}
              className={cn(
                "flex h-full flex-col gap-2 rounded-lg border bg-card p-4 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                on && "border-primary ring-2 ring-primary/30",
              )}
            >
              <span className="flex items-center gap-2 font-medium">
                <Icon aria-hidden className="size-4 text-muted-foreground" />
                {p.label}
                {suggested?.id === p.id && <Badge variant="muted">Detected</Badge>}
                {on && <CheckIcon aria-hidden className="ml-auto size-4" />}
              </span>
              <span className="text-sm text-muted-foreground">{p.description}</span>
            </button>
          );
        })}
      </div>
      {suggested !== null && (
        <p className="text-sm text-muted-foreground" data-testid="detected">
          Detected: <strong>{PRESET_LIST.find((p) => p.id === suggested.id)?.label}</strong>. {suggested.reason} Pick another card if that is not how it should be built.
        </p>
      )}
      {suggested === null && lookup.status === "ready" && preset === "" && <p className="text-sm text-muted-foreground">Nothing in the repository says how it is built: pick a card.</p>}
      {errors.preset && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {errors.preset}
        </p>
      )}
      {preset === "dockerfile" && <DockerfileDetails lookup={lookup} input={input} candidate={candidate} onPick={onPick} onField={onField} errors={errors} idPrefix={idPrefix} />}
    </div>
  );
}

function DockerfileDetails({
  lookup,
  input,
  candidate,
  onPick,
  onField,
  errors,
  idPrefix,
}: {
  lookup: DockerfileLookupState;
  input: Pick<ReviewInput, "dockerfile" | "context">;
  candidate: string;
  onPick: (path: string) => void;
  onField: (field: "dockerfile" | "context", value: string) => void;
  errors: ReviewErrors;
  idPrefix: string;
}) {
  const candidates = lookup.status === "ready" ? lookup.candidates : [];
  const chosen = candidates.find((c) => c.path === candidate);
  return (
    <div className="space-y-4 rounded-lg border p-4">
      <p className="text-sm text-muted-foreground">Keelson reads the repository for its Dockerfiles, the port each exposes and whether the image has a HEALTHCHECK. Change anything that is not right.</p>
      {lookup.status === "loading" && <p className="text-sm text-muted-foreground">Reading the repository…</p>}
      {lookup.status === "error" && (
        <Notice title="Could not read the repository">
          {lookup.error} You can still enter the Dockerfile&apos;s path below.
        </Notice>
      )}
      {lookup.status === "ready" && lookup.candidates.length === 0 && (
        <Notice tone="warning" title="No Dockerfile found">
          None was found in the repository&apos;s root, in docker/ or deploy/, or one directory down. Enter its path below, or pick a framework above instead.
        </Notice>
      )}
      {lookup.status === "ready" && lookup.truncated && <Notice tone="info">Only part of the repository was searched for Dockerfiles. If yours is not listed, enter its path.</Notice>}
      {candidates.length > 1 && (
        <SelectField
          id={`${idPrefix}-candidate`}
          label="Dockerfile found"
          help="Several were found; the first is chosen. Picking another one fills the fields below."
          value={candidate}
          onChange={onPick}
          options={candidates.map((c) => ({ value: c.path, label: c.path }))}
        />
      )}
      {chosen?.buildkit && (
        <Notice tone="warning" title="This Dockerfile needs BuildKit">
          {chosen.path} uses an instruction only BuildKit runs (such as <span className="font-mono">RUN --mount</span>). The agent builds with the engine&apos;s classic builder, so the build would fail. Remove that instruction, or keep a second Dockerfile without it
          and pick it here.
        </Notice>
      )}
      <div className="grid gap-5 sm:grid-cols-2">
        <TextField id={`${idPrefix}-dockerfile`} label="Dockerfile" required help="Its path in the repository." error={errors.dockerfile} value={input.dockerfile} onChange={(v) => onField("dockerfile", v)} mono />
        <TextField id={`${idPrefix}-context`} label="Build context" help="A directory of the repository; . is its root." error={errors.context} value={input.context} onChange={(v) => onField("context", v)} mono />
      </div>
    </div>
  );
}
