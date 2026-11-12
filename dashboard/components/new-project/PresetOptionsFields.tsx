"use client";

import { SwitchField, TextField } from "@/components/forms/fields";
import { getPreset, visibleFields, type PresetErrors, type PresetField, type PresetId, type PresetOptions } from "@/lib/presets-core";
import { setOption } from "@/lib/new-project-wizard-core";

/** How each option of the registry is shown. The preset says which ones it reads; the defaults come from the registry as placeholders. */
const FIELD_UI: Record<PresetField, { label: string; help: string; kind: "text" | "switch" }> = {
  context: { label: "Directory", help: "The subdirectory of the repository that is built, for a monorepo. Blank is the repository's root.", kind: "text" },
  install: { label: "Install command", help: "Runs through sh -c in the build.", kind: "text" },
  build_command: { label: "Build command", help: "Runs through sh -c in the build.", kind: "text" },
  start: { label: "Start command", help: "Runs through sh -c when the container starts.", kind: "text" },
  output_dir: { label: "Output directory", help: "The directory the build writes, served as the site.", kind: "text" },
  node: { label: "Node.js version", help: "A major version, 18 or later.", kind: "text" },
  spa: { label: "Single-page app fallback", help: "Unknown paths answer index.html. Off: they answer 404.", kind: "switch" },
  standalone: { label: "Standalone output", help: 'Ships only .next/standalone and runs node server.js: a much smaller image. Needs output: "standalone" in next.config.', kind: "switch" },
  dockerfile: { label: "Dockerfile", help: "Its path inside the directory.", kind: "text" },
  target: { label: "Build stage", help: "The stage of a multi-stage Dockerfile to build. Blank builds the last one.", kind: "text" },
};

/**
 * The options a preset reads, from the registry: only the fields it has, with what a blank one means shown as the
 * placeholder. Used by the New project wizard and by the configuration form of an app that has a `build:` block.
 */
export function PresetOptionsFields({
  preset,
  options,
  onChange,
  errors,
  idPrefix,
}: {
  preset: PresetId;
  options: PresetOptions;
  onChange: (options: PresetOptions) => void;
  errors: PresetErrors;
  idPrefix: string;
}) {
  const p = getPreset(preset);
  const fields = visibleFields(preset, options);
  const texts = fields.filter((f) => FIELD_UI[f].kind === "text");
  const switches = fields.filter((f) => FIELD_UI[f].kind === "switch");
  return (
    <div className="grid gap-5">
      <div className="grid gap-5 sm:grid-cols-2" data-testid="preset-options">
        {texts.map((f) => (
          <TextField
            key={f}
            id={`${idPrefix}-opt-${f}`}
            label={FIELD_UI[f].label}
            help={FIELD_UI[f].help}
            error={errors[f]}
            placeholder={p.placeholders[f] ?? (f === "node" ? p.defaults.node : f === "output_dir" ? p.defaults.output_dir : f === "context" ? "." : undefined)}
            value={(options[f] as string | undefined) ?? ""}
            onChange={(v) => onChange(setOption(options, f, v))}
            mono
          />
        ))}
      </div>
      {switches.map((f) => (
        <SwitchField
          key={f}
          id={`${idPrefix}-opt-${f}`}
          label={FIELD_UI[f].label}
          help={FIELD_UI[f].help}
          checked={(options[f as "spa" | "standalone"] as boolean | undefined) ?? p.defaults[f as "spa" | "standalone"] ?? false}
          onChange={(v) => onChange(setOption(options, f, v))}
        />
      ))}
    </div>
  );
}
