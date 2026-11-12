import type { AppConfig, ConfigModel } from "@/lib/agent-types";

/** Previews have their own variable scope only for an app that has a `previews:` template. */
export function hasPreviewTemplate(model: Pick<ConfigModel, "apps"> | undefined, app: string): boolean {
  return model?.apps?.some((a) => a.name === app && a.previews !== undefined) ?? false;
}

/** What the apps file already gives an app: the names only (the values of `env:` are written in a file the agent reads, and those of `env_file` stay on the server). */
export interface FileEnvironment {
  envFile: string | null;
  envKeys: string[];
}

export function fileEnvironment(app: Pick<AppConfig, "env_file" | "env"> | undefined): FileEnvironment {
  return { envFile: app?.env_file ? app.env_file : null, envKeys: Object.keys(app?.env ?? {}).sort() };
}

/** The sentence that says which other sources of variables apply to the app; null when the apps file gives none. */
export function fileEnvironmentNote(file: FileEnvironment): string | null {
  const parts: string[] = [];
  if (file.envFile !== null) parts.push(`env_file ${file.envFile}`);
  if (file.envKeys.length > 0) parts.push(`${file.envKeys.length} variable${file.envKeys.length === 1 ? "" : "s"} in env:`);
  if (parts.length === 0) return null;
  return `The server's configuration also gives this app ${parts.join(" and ")}. A value saved here wins over the same name there.`;
}
